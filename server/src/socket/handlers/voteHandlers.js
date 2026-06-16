// server/src/socket/handlers/voteHandlers.js
// ─────────────────────────────────────────────────────────────────────────────
//  Socket.IO handlers for the discussion → voting → results pipeline.
//
//  Events handled:
//    player:ready   — player signals they want to vote
//    vote:submit    — player casts their vote
//
//  Events emitted (to whole room unless noted):
//    ready:update          — current ready count during discussion
//    voting:start          — all players ready; voting phase begins
//    vote:timer            — countdown tick every second
//    round:result          — full result broadcast after voting closes
//    round:next            — host prompt to start next round (if rounds remain)
//    game:finished         — final leaderboard (if all rounds done)
//    error                 → sender only
//
//  Phase flow:
//    discussion
//      └─ all ready (or host force) ──► voting (30s timer starts)
//           └─ all voted OR timer expires ──► results ──► next/finished
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { getRoundState, clearRoundState } = require('../roundState');
const { tallyVotes, buildVoteBreakdown } = require('../../services/votingService');
const { calculateDeltas, applyDeltas, fetchUpdatedScores } = require('../../services/scoringService');
const { emitRound } = require('../utils/emitRound');

const VOTE_DURATION_MS  = 30_000;   // 30 seconds
const VOTE_TICK_MS      = 1_000;    // broadcast timer every second

/**
 * Registers all vote-phase socket events on a single socket.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {import('mysql2/promise').Pool} pool
 */
function registerVoteHandlers(socket, io, pool) {

  // ── player:ready ──────────────────────────────────────────────────────
  //
  // Player emits this during the discussion phase to signal they are
  // ready to vote. Once all connected players are ready, voting starts.
  //
  // No payload required.
  socket.on('player:ready', async () => {
    if (!socket.data.roomCode) {
      return socket.emit('error', { code: 'NOT_IN_ROOM', message: 'Not in a room.' });
    }

    const state = getRoundState(socket.data.roomCode);
    if (!state) {
      return socket.emit('error', { code: 'NO_ACTIVE_ROUND', message: 'No active round.' });
    }
    if (state.phase !== 'discussion') {
      return socket.emit('error', {
        code:    'WRONG_PHASE',
        message: `Cannot mark ready during phase "${state.phase}".`,
      });
    }

    // Record this player as ready (Set ignores duplicates)
    state.readyPlayers.add(socket.data.playerId);

    const readyCount   = state.readyPlayers.size;
    const totalPlayers = state.totalPlayers;

    // Broadcast the live count to everyone in the room
    io.to(socket.data.roomCode).emit('ready:update', { readyCount, totalPlayers });

    console.log(
      `[vote] ${socket.data.nickname} ready in ${socket.data.roomCode} ` +
      `(${readyCount}/${totalPlayers})`
    );

    // If all players are ready, start voting immediately
    if (readyCount >= totalPlayers) {
      await startVotingPhase(io, pool, socket.data.roomCode, state);
    }
  });


  // ── round:start-next ─────────────────────────────────────────────────
  //
  // Host-only. Emitted from the Result screen after a round ends.
  // Creates and emits the next round using the existing emitRound utility.
  //
  // Validation:
  //   - Must be host
  //   - Room must be in_progress
  //   - Must not be the final round (current_round < total_rounds)
  socket.on('round:start-next', async () => {
    if (!socket.data.roomCode) {
      return socket.emit('error', { code: 'NOT_IN_ROOM', message: 'Not in a room.' });
    }
    if (!socket.data.isHost) {
      return socket.emit('error', { code: 'NOT_HOST', message: 'Only the host can start the next round.' });
    }

    try {
      const [roomRows] = await pool.query(
        `SELECT id, status, current_round, total_rounds, settings_json AS settingsJson
         FROM   rooms
         WHERE  id = ?
         LIMIT  1`,
        [socket.data.roomId]
      );

      if (roomRows.length === 0) {
        return socket.emit('error', { code: 'ROOM_NOT_FOUND', message: 'Room not found.' });
      }

      const room = roomRows[0];

      if (room.status !== 'in_progress') {
        return socket.emit('error', {
          code:    'INVALID_STATE',
          message: `Cannot start next round — room is "${room.status}".`,
        });
      }

      if (room.current_round >= room.total_rounds) {
        return socket.emit('error', {
          code:    'GAME_OVER',
          message: 'All rounds have already been played.',
        });
      }

      const settings = typeof room.settingsJson === 'string'
        ? JSON.parse(room.settingsJson)
        : room.settingsJson;

      await emitRound(io, pool, {
        roomId:      socket.data.roomId,
        roomCode:    socket.data.roomCode,
        roundNumber: room.current_round + 1,
        totalRounds: room.total_rounds,
        settings,
      });

      console.log(
        `[vote] Host ${socket.data.nickname} started round ` +
        `${room.current_round + 1} in ${socket.data.roomCode}`
      );

    } catch (err) {
      console.error('[round:start-next] Error:', err.message);
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to start next round.' });
    }
  });


  // ── vote:submit ───────────────────────────────────────────────────────
  //
  // Player emits this during the voting phase.
  //
  // Payload: { targetPlayerId: number }
  //
  // Validation:
  //   - Must be in voting phase
  //   - Cannot vote twice
  //   - Cannot vote for yourself
  //   - Target must be a player in this room (checked against round_players)
  socket.on('vote:submit', async ({ targetPlayerId } = {}) => {
    if (!socket.data.roomCode) {
      return socket.emit('error', { code: 'NOT_IN_ROOM', message: 'Not in a room.' });
    }

    const state = getRoundState(socket.data.roomCode);
    if (!state) {
      return socket.emit('error', { code: 'NO_ACTIVE_ROUND', message: 'No active round.' });
    }
    if (state.phase !== 'voting') {
      return socket.emit('error', {
        code:    'WRONG_PHASE',
        message: 'Voting is not currently open.',
      });
    }

    const voterId = socket.data.playerId;

    // Cannot vote twice
    if (state.votes.has(voterId)) {
      return socket.emit('error', {
        code:    'ALREADY_VOTED',
        message: 'You have already voted this round.',
      });
    }

    // Validate targetPlayerId type
    const targetId = Number(targetPlayerId);
    if (!targetId || isNaN(targetId)) {
      return socket.emit('error', {
        code:    'INVALID_TARGET',
        message: 'Invalid target player.',
      });
    }

    // Cannot vote for yourself
    if (targetId === voterId) {
      return socket.emit('error', {
        code:    'SELF_VOTE',
        message: 'You cannot vote for yourself.',
      });
    }

    // Confirm target is in this round
    const [targetRows] = await pool.query(
      `SELECT rp.id
       FROM   round_players rp
       WHERE  rp.round_id        = ?
       AND    rp.room_player_id  = ?
       LIMIT  1`,
      [state.roundId, targetId]
    );
    if (targetRows.length === 0) {
      return socket.emit('error', {
        code:    'INVALID_TARGET',
        message: 'Target player is not in this round.',
      });
    }

    // Record vote in memory
    state.votes.set(voterId, targetId);

    // Persist to DB immediately — if the server crashes mid-round the
    // votes already cast are not lost
    try {
      await pool.query(
        `INSERT INTO votes (round_id, voter_id, target_id) VALUES (?, ?, ?)`,
        [state.roundId, voterId, targetId]
      );
    } catch (dbErr) {
      // ER_DUP_ENTRY means the vote is already in the DB (reconnect edge case)
      if (dbErr.code !== 'ER_DUP_ENTRY') throw dbErr;
    }

    console.log(
      `[vote] ${socket.data.nickname} voted for player ${targetId} ` +
      `in ${socket.data.roomCode} (${state.votes.size}/${state.totalPlayers})`
    );

    // If every player has voted, resolve immediately without waiting for timer
    if (state.votes.size >= state.totalPlayers) {
      // Cancel the 30s timer
      if (state.voteTimer) {
        clearTimeout(state.voteTimer);
        state.voteTimer = null;
      }
      await resolveVoting(io, pool, socket.data.roomCode, state);
    }
  });

}


// ─────────────────────────────────────────────
//  Internal: start voting phase
// ─────────────────────────────────────────────

/**
 * Transitions the room from discussion → voting.
 * Broadcasts voting:start, then starts the 30-second timer.
 *
 * @param {import('socket.io').Server} io
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} roomCode
 * @param {object} state   — roundState entry
 */
async function startVotingPhase(io, pool, roomCode, state) {
  state.phase = 'voting';

  // Update DB status so REST endpoints reflect the current phase
  await pool.query(
    "UPDATE rounds SET status = 'voting' WHERE id = ?",
    [state.roundId]
  );

  io.to(roomCode).emit('voting:start', { roundId: state.roundId });
  console.log(`[vote] Voting started in ${roomCode}`);

  // Broadcast a countdown tick every second
  let secondsLeft = VOTE_DURATION_MS / 1000;

  state.voteInterval = setInterval(() => {
    secondsLeft--;
    io.to(roomCode).emit('vote:timer', { secondsRemaining: secondsLeft });

    if (secondsLeft <= 0) {
      clearInterval(state.voteInterval);
    }
  }, VOTE_TICK_MS);

  // 30-second hard deadline
  state.voteTimer = setTimeout(async () => {
    clearInterval(state.voteInterval);
    // Only resolve if still in voting (not already resolved by early completion)
    const currentState = getRoundState(roomCode);
    if (currentState && currentState.phase === 'voting') {
      await resolveVoting(io, pool, roomCode, currentState);
    }
  }, VOTE_DURATION_MS);
}


// ─────────────────────────────────────────────
//  Internal: resolve voting and broadcast result
// ─────────────────────────────────────────────

/**
 * Called when voting ends (timer or all-voted).
 * Tallies votes, calculates scores, persists to DB, broadcasts result.
 *
 * @param {import('socket.io').Server} io
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} roomCode
 * @param {object} state   — roundState entry
 */
async function resolveVoting(io, pool, roomCode, state) {
  // Prevent double-resolution if timer fires just as the last vote arrives
  if (state.phase === 'results') return;
  state.phase = 'results';
  clearTimeout(state.voteTimer);

if (state.voteInterval) {
  clearInterval(state.voteInterval);
}

  try {
    // ── Fetch round context from DB ──────────────────────────────────
    const [roundRows] = await pool.query(
      `SELECT r.id, r.round_type, r.word, r.alternate_word,
              r.room_id, rm.current_round, rm.total_rounds
       FROM   rounds r
       JOIN   rooms  rm ON rm.id = r.room_id
       WHERE  r.id = ?
       LIMIT  1`,
      [state.roundId]
    );

    if (roundRows.length === 0) {
      console.error(`[resolveVoting] Round ${state.roundId} not found`);
      return;
    }

    const round = roundRows[0];

    // Fetch all round_players with their nicknames for the result broadcast
    const [rpRows] = await pool.query(
      `SELECT rp.room_player_id AS playerId,
              rmp.nickname,
              rp.role,
              rp.received_info  AS receivedInfo
       FROM   round_players rp
       JOIN   room_players  rmp ON rmp.id = rp.room_player_id
       WHERE  rp.round_id = ?`,
      [state.roundId]
    );

    // ── Tally votes ──────────────────────────────────────────────────
    const tallyResult   = tallyVotes(state.votes, rpRows);
    const voteBreakdown = buildVoteBreakdown(state.votes, rpRows);

    // ── Mark eliminated player in DB ─────────────────────────────────
    if (tallyResult.eliminatedPlayerId !== null) {
      await pool.query(
        `UPDATE round_players
         SET    was_voted_out = 1
         WHERE  round_id       = ?
         AND    room_player_id = ?`,
        [state.roundId, tallyResult.eliminatedPlayerId]
      );
    }

    // ── Update round status ──────────────────────────────────────────
    await pool.query(
      "UPDATE rounds SET status = 'results', ended_at = NOW() WHERE id = ?",
      [state.roundId]
    );

    // ── Calculate and apply scores ───────────────────────────────────
    const deltas = calculateDeltas({
      roundType:    round.round_type,
      roundPlayers: rpRows,
      tallyResult,
    });

    await applyDeltas(pool, deltas);

    const playerIds    = rpRows.map(p => p.playerId);
    const updatedScores = await fetchUpdatedScores(pool, playerIds);

    // ── Build the result payload ─────────────────────────────────────

    // Find the target player (imposter / spy / odd one)
    const targetPlayer = rpRows.find(p =>
      ['imposter', 'reverse_spy_target', 'similar_word_target'].includes(p.role)
    );
    const eliminatedPlayer = rpRows.find(p => p.playerId === tallyResult.eliminatedPlayerId);

    const correctVote = eliminatedPlayer
      ? ['imposter', 'reverse_spy_target', 'similar_word_target'].includes(eliminatedPlayer.role)
      : false;

    const resultPayload = {
      roundId:    state.roundId,
      roundType:  round.round_type,   // reveal the true round type (including chaos)
      word:       round.word,         // reveal the secret word
      alternateWord: round.alternate_word || null,

      eliminatedPlayer: eliminatedPlayer
        ? { id: eliminatedPlayer.playerId, nickname: eliminatedPlayer.nickname, role: eliminatedPlayer.role }
        : null,

      targetPlayer: targetPlayer
        ? { id: targetPlayer.playerId, nickname: targetPlayer.nickname, role: targetPlayer.role }
        : null,

      correctVote,
      isTie:          tallyResult.isTie,
      tiedPlayerIds:  tallyResult.tiedPlayerIds,
      voteCounts:     tallyResult.voteCounts,
      voteBreakdown,

      // Score deltas for this round (so frontend can animate +2, +1, etc.)
      scoreDeltas: deltas.reduce((acc, d) => {
        acc[d.playerId] = d.delta;
        return acc;
      }, {}),

      // Updated cumulative scores
      scores: updatedScores,
    };

    // ── Broadcast result to room ─────────────────────────────────────
    io.to(roomCode).emit('round:result', resultPayload);

    console.log(
      `[vote] Round ${state.roundId} resolved in ${roomCode} — ` +
      `eliminated: ${eliminatedPlayer?.nickname ?? 'nobody'}, ` +
      `correct: ${correctVote}, chaos: ${round.round_type === 'chaos'}`
    );

    // ── Clean up in-memory state ─────────────────────────────────────
    clearRoundState(roomCode);

    // ── Emit next-step event ─────────────────────────────────────────
    const isLastRound = round.current_round >= round.total_rounds;

    if (isLastRound) {
      // Game over — emit final leaderboard
      io.to(roomCode).emit('game:finished', {
        finalScores: updatedScores,
      });

      // Mark room as finished
      await pool.query(
        "UPDATE rooms SET status = 'finished' WHERE id = ?",
        [round.room_id]
      );

      console.log(`[vote] Game finished in ${roomCode}`);

    } else {
      // More rounds remain.
      // Emit round:next as a UI signal so the result screen knows to show
      // the host a "Start Next Round" button and non-hosts a waiting message.
      // The host then emits round:start-next to actually begin the next round.
      // No automatic timer, no automatic round creation here.
      setTimeout(() => {
  io.to(roomCode).emit('round:next', {
    nextRoundNumber: round.current_round + 1,
    totalRounds:     round.total_rounds,
  });
}, 500);
    }

  } catch (err) {
    console.error(`[resolveVoting] Error in ${roomCode}:`, err.message);
    io.to(roomCode).emit('error', {
      code:    'SERVER_ERROR',
      message: 'An error occurred resolving the round. Please ask the host to restart.',
    });
  }
}

module.exports = { registerVoteHandlers };