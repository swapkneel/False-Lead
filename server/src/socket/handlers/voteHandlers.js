// server/src/socket/handlers/voteHandlers.js
// ─────────────────────────────────────────────────────────────────────────────
//  Socket.IO handlers for the discussion → voting → results pipeline.
//
//  Events handled:
//    player:ready   — player signals they want to vote
//    vote:submit    — player casts their vote(s)
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
//
//  Multi-vote change summary:
//    vote:submit now accepts  { targetPlayerIds: number[] }
//    - length must equal state.imposterCount
//    - no duplicates, no self-vote, all must be valid round participants
//    - state.votes stores  Map<voterId, targetId[]>
//    - one DB INSERT per target (loop)
//    - resolveVoting delegates tally/scoring to updated service functions
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { getRoundState, clearRoundState } = require('../roundState');
const { tallyVotes, buildVoteBreakdown } = require('../../services/votingService');
const { calculateDeltas, applyDeltas, fetchUpdatedScores } = require('../../services/scoringService');
const { emitRound } = require('../utils/emitRound');

const VOTE_DURATION_MS = 30_000;   // 30 seconds
const VOTE_TICK_MS     = 1_000;    // broadcast timer every second

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
  // Unchanged from before — no multi-vote impact here.
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

    state.readyPlayers.add(socket.data.playerId);

    const readyCount   = state.readyPlayers.size;
    const totalPlayers = state.totalPlayers;

    io.to(socket.data.roomCode).emit('ready:update', { readyCount, totalPlayers });

    console.log(
      `[vote] ${socket.data.nickname} ready in ${socket.data.roomCode} ` +
      `(${readyCount}/${totalPlayers})`
    );

    if (readyCount >= totalPlayers) {
      await startVotingPhase(io, pool, socket.data.roomCode, state);
    }
  });


  // ── round:start-next ─────────────────────────────────────────────────
  //
  // Unchanged from before — no multi-vote impact here.
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
  // Payload: { targetPlayerIds: number[] }
  //   - length must equal state.imposterCount
  //   - no duplicates
  //   - no self-vote
  //   - all targets must be valid round participants
  //
  // state.votes stores Map<voterId, targetId[]>
  // One DB row is inserted per target.
  socket.on('vote:submit', async ({ targetPlayerIds } = {}) => {
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

    const voterId       = socket.data.playerId;
    const imposterCount = state.imposterCount;

    

    // Cannot vote twice
    if (state.votes.has(voterId)) {
      return socket.emit('error', {
        code:    'ALREADY_VOTED',
        message: 'You have already voted this round.',
      });
    }

    // ── Validate targetPlayerIds ─────────────────────────────────────

    if (!Array.isArray(targetPlayerIds)) {
      return socket.emit('error', {
        code:    'INVALID_TARGET',
        message: 'targetPlayerIds must be an array.',
      });
    }

    if (targetPlayerIds.length !== imposterCount) {
      return socket.emit('error', {
        code:    'INVALID_TARGET',
        message: `You must vote for exactly ${imposterCount} player${imposterCount === 1 ? '' : 's'}.`,
      });
    }

    // Coerce to numbers and sanity-check each entry
    const targetIds = targetPlayerIds.map(Number);

    if (targetIds.some(id => !id || isNaN(id))) {
      return socket.emit('error', {
        code:    'INVALID_TARGET',
        message: 'One or more target player IDs are invalid.',
      });
    }

    // No duplicates
    const uniqueTargets = new Set(targetIds);
    if (uniqueTargets.size !== targetIds.length) {
      return socket.emit('error', {
        code:    'INVALID_TARGET',
        message: 'You cannot vote for the same player twice.',
      });
    }

    // No self-vote
    if (targetIds.includes(voterId)) {
      return socket.emit('error', {
        code:    'SELF_VOTE',
        message: 'You cannot vote for yourself.',
      });
    }

    // All targets must be in this round — one query, check count matches
    const placeholders = targetIds.map(() => '?').join(', ');
    const [targetRows] = await pool.query(
      `SELECT rp.room_player_id AS playerId
       FROM   round_players rp
       WHERE  rp.round_id       = ?
       AND    rp.room_player_id IN (${placeholders})`,
      [state.roundId, ...targetIds]
    );

    if (targetRows.length !== targetIds.length) {
      return socket.emit('error', {
        code:    'INVALID_TARGET',
        message: 'One or more target players are not in this round.',
      });
    }

    // ── Record vote in memory ────────────────────────────────────────
    // Map<voterId, targetId[]>
    state.votes.set(voterId, targetIds);

    // ── Persist to DB — one row per target ──────────────────────────
    try {
      for (const targetId of targetIds) {
        await pool.query(
          `INSERT INTO votes (round_id, voter_id, target_id) VALUES (?, ?, ?)`,
          [state.roundId, voterId, targetId]
        );
      }
    } catch (dbErr) {
      // ER_DUP_ENTRY means this (voter, target) pair is already in the DB
      // (reconnect edge case) — safe to ignore
      if (dbErr.code !== 'ER_DUP_ENTRY') throw dbErr;
    }

    console.log(
      `[vote] ${socket.data.nickname} voted for [${targetIds.join(', ')}] ` +
      `in ${socket.data.roomCode} (${state.votes.size}/${state.totalPlayers})`
    );

    // If every player has voted, resolve immediately without waiting for timer
    if (state.votes.size >= state.totalPlayers) {
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
 */
async function startVotingPhase(io, pool, roomCode, state) {
  state.phase = 'voting';

  await pool.query(
    "UPDATE rounds SET status = 'voting' WHERE id = ?",
    [state.roundId]
  );

  io.to(roomCode).emit('voting:start', { roundId: state.roundId });
  console.log(`[vote] Voting started in ${roomCode}`);

  let secondsLeft = VOTE_DURATION_MS / 1000;

  state.tickInterval = setInterval(() => {
    secondsLeft--;
    io.to(roomCode).emit('vote:timer', { secondsRemaining: secondsLeft });
    if (secondsLeft <= 0) {
      clearInterval(state.tickInterval);
    }
  }, VOTE_TICK_MS);

  state.voteTimer = setTimeout(async () => {
    clearInterval(state.tickInterval);
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
 */
async function resolveVoting(io, pool, roomCode, state) {
  if (state.phase === 'results') return;

  state.phase = 'results';

  if (state.voteTimer)    clearTimeout(state.voteTimer);
  if (state.tickInterval) clearInterval(state.tickInterval);

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

    // Fetch all round_players with their nicknames
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
    // tallyVotes now receives Map<voterId, targetId[]> and imposterCount
    const tallyResult   = tallyVotes(state.votes, rpRows, state.imposterCount);
    const voteBreakdown = buildVoteBreakdown(state.votes, rpRows);

    // ── Mark eliminated players in DB ────────────────────────────────
    // tallyResult.eliminatedPlayerIds is now an array (length 0–N)
    for (const eliminatedId of tallyResult.eliminatedPlayerIds) {
      await pool.query(
        `UPDATE round_players
         SET    was_voted_out = 1
         WHERE  round_id       = ?
         AND    room_player_id = ?`,
        [state.roundId, eliminatedId]
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
      votes:        state.votes,
      imposterCount: state.imposterCount,
    });

    await applyDeltas(pool, deltas);

    const playerIds     = rpRows.map(p => p.playerId);
    const updatedScores = await fetchUpdatedScores(pool, playerIds);

    // ── Build the result payload ─────────────────────────────────────

    // For backward compat, keep singular eliminatedPlayer for 1-imposter games,
    // and add eliminatedPlayers array for all games.
    const eliminatedPlayers = rpRows.filter(p =>
      tallyResult.eliminatedPlayerIds.includes(p.playerId)
    );

    // targetPlayer(s): roles that are "the target"
    const targetPlayers = rpRows.filter(p =>
      ['imposter', 'reverse_spy_target', 'similar_word_target'].includes(p.role)
    );

    // correctVote: true if at least one eliminated player was a target role
    const correctVote = eliminatedPlayers.some(p =>
      ['imposter', 'reverse_spy_target', 'similar_word_target'].includes(p.role)
    );

    const resultPayload = {
      roundId:    state.roundId,
      roundType:  round.round_type,
      word:       round.word,
      alternateWord: round.alternate_word || null,

      // Backward-compatible singular fields (first eliminated / first target)
      eliminatedPlayer: eliminatedPlayers[0]
        ? { id: eliminatedPlayers[0].playerId, nickname: eliminatedPlayers[0].nickname, role: eliminatedPlayers[0].role }
        : null,

      targetPlayer: targetPlayers[0]
        ? { id: targetPlayers[0].playerId, nickname: targetPlayers[0].nickname, role: targetPlayers[0].role }
        : null,

      // New plural fields for multi-imposter games
      eliminatedPlayers: eliminatedPlayers.map(p => ({
        id: p.playerId, nickname: p.nickname, role: p.role,
      })),

      targetPlayers: targetPlayers.map(p => ({
        id: p.playerId, nickname: p.nickname, role: p.role,
      })),

      correctVote,
      isTie:          tallyResult.isTie,
      tiedPlayerIds:  tallyResult.tiedPlayerIds,
      voteCounts:     tallyResult.voteCounts,
      voteBreakdown,

      scoreDeltas: deltas.reduce((acc, d) => {
        acc[d.playerId] = d.delta;
        return acc;
      }, {}),

      scores: updatedScores,
    };

    io.to(roomCode).emit('round:result', resultPayload);

    console.log(
      `[vote] Round ${state.roundId} resolved in ${roomCode} — ` +
      `eliminated: [${eliminatedPlayers.map(p => p.nickname).join(', ') || 'nobody'}], ` +
      `correct: ${correctVote}, chaos: ${round.round_type === 'chaos'}`
    );

    clearRoundState(roomCode);

    const isLastRound = round.current_round >= round.total_rounds;

    if (isLastRound) {
      io.to(roomCode).emit('game:finished', { finalScores: updatedScores });
      await pool.query(
        "UPDATE rooms SET status = 'finished' WHERE id = ?",
        [round.room_id]
      );
      console.log(`[vote] Game finished in ${roomCode}`);
    } else {
      io.to(roomCode).emit('round:next', {
        nextRoundNumber: round.current_round + 1,
        totalRounds:     round.total_rounds,
      });
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