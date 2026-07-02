// server/src/socket/handlers/voteHandlers.js
// ─────────────────────────────────────────────────────────────────────────────
//  Socket.IO handlers for the discussion → voting → results pipeline.
//
//  Phase flow:
//    discussion
//      └─ all online players ready (offline = auto-ready) ──► voting (30s)
//           └─ all online players voted OR timer expires ──► results ──► next/finished
//
//  Regression fix (post-M2 reconnect testing):
//    state.totalPlayers (from roundState) now reflects the FULL round
//    roster including reserved-but-offline seats (see emitRound.js fix).
//    That number is correct for round_players row count and for display
//    purposes showing "X / Y in this round" if ever needed — but it must
//    NOT be used to decide when voting is "complete", because an offline
//    player can never submit a vote and would block resolution forever
//    until the 30s timer bails it out.
//
//    Fix: vote:submit's completion check now compares votes.size against
//    the count of currently ONLINE players (live socket membership), not
//    state.totalPlayers. This mirrors the existing player:ready logic,
//    which already used online players correctly.
//
//    ready:update broadcasts now also report the online count alongside
//    readyCount, so the client's ReadyPanel pip count stays accurate even
//    as players disconnect/reconnect across rounds — it no longer relies
//    on a value computed once at round creation.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { getRoundState, clearRoundState } = require('../roundState');
const { tallyVotes, buildVoteBreakdown } = require('../../services/votingService');
const { calculateDeltas, applyDeltas, fetchUpdatedScores } = require('../../services/scoringService');
const { emitRound } = require('../utils/emitRound');

const VOTE_DURATION_MS = 30_000;
const VOTE_TICK_MS     = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: check whether all currently online players have readied up.
//  "Online" = has a live socket joined to the room right now.
// ─────────────────────────────────────────────────────────────────────────────
function allOnlinePlayersReady(state, onlineIds) {
  for (const id of onlineIds) {
    if (!state.readyPlayers.has(id)) return false;
  }
  return true;
}

/**
 * Derive the set of player IDs who are currently online for a given room.
 * Always computed live from Socket.IO room membership — never cached —
 * so it self-corrects across disconnects, reconnects, and round boundaries
 * without any stale state to track.
 *
 * @param {import('socket.io').Server} io
 * @param {string} roomCode
 * @returns {Promise<Set<number>>}
 */
async function getOnlinePlayerIds(io, roomCode) {
  const sockets = await io.in(roomCode).fetchSockets();
  const ids = new Set();
  for (const s of sockets) {
    if (s.data.playerId) ids.add(s.data.playerId);
  }
  return ids;
}


// ─────────────────────────────────────────────
//  Handler registration
// ─────────────────────────────────────────────

function registerVoteHandlers(socket, io, pool) {

  // ── player:ready ──────────────────────────────────────────────────────
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

    const onlineIds    = await getOnlinePlayerIds(io, socket.data.roomCode);
    const readyCount   = [...state.readyPlayers].filter(id => onlineIds.has(id)).length;
    const totalPlayers = onlineIds.size;

    io.to(socket.data.roomCode).emit('ready:update', { readyCount, totalPlayers });

    console.log(
      `[vote] ${socket.data.nickname} ready in ${socket.data.roomCode} ` +
      `(${readyCount}/${totalPlayers} online)`
    );

    if (onlineIds.size > 0 && allOnlinePlayersReady(state, onlineIds)) {
      await startVotingPhase(io, pool, socket.data.roomCode, state);
    }
  });


  // ── round:start-next ─────────────────────────────────────────────────
  //
  // Unchanged.
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

    if (state.votes.has(voterId)) {
      return socket.emit('error', {
        code:    'ALREADY_VOTED',
        message: 'You have already voted this round.',
      });
    }

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

    const targetIds = targetPlayerIds.map(Number);

    if (targetIds.some(id => !id || isNaN(id))) {
      return socket.emit('error', {
        code:    'INVALID_TARGET',
        message: 'One or more target player IDs are invalid.',
      });
    }

    const uniqueTargets = new Set(targetIds);
    if (uniqueTargets.size !== targetIds.length) {
      return socket.emit('error', {
        code:    'INVALID_TARGET',
        message: 'You cannot vote for the same player twice.',
      });
    }

    if (targetIds.includes(voterId)) {
      return socket.emit('error', {
        code:    'SELF_VOTE',
        message: 'You cannot vote for yourself.',
      });
    }

    // Validate targets are round participants. This now correctly includes
    // players who are mid-grace-period (reserved seat), since emitRound's
    // fix ensures they have a round_players row regardless of connection
    // status. A reconnecting player who was offline at round creation can
    // now be voted for, fixing "this player may not be present."
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

    state.votes.set(voterId, targetIds);

    try {
      for (const targetId of targetIds) {
        await pool.query(
          `INSERT INTO votes (round_id, voter_id, target_id) VALUES (?, ?, ?)`,
          [state.roundId, voterId, targetId]
        );
      }
    } catch (dbErr) {
      if (dbErr.code !== 'ER_DUP_ENTRY') throw dbErr;
    }

    // ── Fix: completion check uses ONLINE players, not state.totalPlayers ──
    // state.totalPlayers is the round's full seat count (may include
    // offline-but-reserved players who can never vote). Comparing against
    // it would block resolution until the 30s timer bails out even when
    // every reachable player has voted. Online players are the correct
    // denominator for "has everyone who CAN vote, voted."
    const onlineIds = await getOnlinePlayerIds(io, socket.data.roomCode);

    console.log(
      `[vote] ${socket.data.nickname} voted for [${targetIds.join(', ')}] ` +
      `in ${socket.data.roomCode} (${state.votes.size}/${onlineIds.size} online)`
    );

    const onlineVoted = [...state.votes.keys()].filter(id => onlineIds.has(id)).length;

    if (onlineIds.size > 0 && onlineVoted >= onlineIds.size) {
      if (state.voteTimer) {
        clearTimeout(state.voteTimer);
        state.voteTimer = null;
      }
      await resolveVoting(io, pool, socket.data.roomCode, state);
    }
  });

}


// ─────────────────────────────────────────────
//  Exported: auto-ready hook for disconnects
// ─────────────────────────────────────────────

/**
 * Called by lobbyHandlers when a player disconnects during the discussion phase.
 * Adds the departing player to readyPlayers (auto-ready) and checks whether
 * all remaining online players are now ready.
 *
 * @param {import('socket.io').Server} io
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} roomCode
 * @param {number} playerId
 * @param {string} nickname
 */
async function handleDisconnectDuringDiscussion(io, pool, roomCode, playerId, nickname) {
  const state = getRoundState(roomCode);
  if (!state || state.phase !== 'discussion') return;

  state.readyPlayers.add(playerId);

  const onlineIds    = await getOnlinePlayerIds(io, roomCode);
  const readyCount   = [...state.readyPlayers].filter(id => onlineIds.has(id)).length;
  const totalPlayers = onlineIds.size;

  io.to(roomCode).emit('ready:update', { readyCount, totalPlayers });

  console.log(
    `[vote] ${nickname} auto-readied on disconnect in ${roomCode} ` +
    `(${readyCount}/${totalPlayers} online)`
  );

  if (onlineIds.size > 0 && allOnlinePlayersReady(state, onlineIds)) {
    await startVotingPhase(io, pool, roomCode, state);
  }
}

/**
 * Called by lobbyHandlers when a player reconnects.
 *
 * Re-broadcasts ready:update with the current online count so every
 * client's ReadyPanel immediately reflects the corrected denominator,
 * instead of waiting for the next player:ready event. This directly
 * fixes "ready panel shows 4 instead of 5" after a reconnect.
 *
 * Safe to call regardless of phase — no-ops if there's no active round
 * or the round isn't in the discussion phase.
 *
 * @param {import('socket.io').Server} io
 * @param {string} roomCode
 */
async function handleReconnectDuringDiscussion(io, roomCode) {
  const state = getRoundState(roomCode);
  if (!state || state.phase !== 'discussion') return;

  const onlineIds    = await getOnlinePlayerIds(io, roomCode);
  const readyCount   = [...state.readyPlayers].filter(id => onlineIds.has(id)).length;
  const totalPlayers = onlineIds.size;

  io.to(roomCode).emit('ready:update', { readyCount, totalPlayers });

  console.log(
    `[vote] Ready count recalculated after reconnect in ${roomCode} ` +
    `(${readyCount}/${totalPlayers} online)`
  );
}


// ─────────────────────────────────────────────
//  Internal: start voting phase
// ─────────────────────────────────────────────

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

async function resolveVoting(io, pool, roomCode, state) {
  if (state.phase === 'results') return;

  state.phase = 'results';

  if (state.voteTimer)    clearTimeout(state.voteTimer);
  if (state.tickInterval) clearInterval(state.tickInterval);

  try {
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

    const tallyResult   = tallyVotes(state.votes, rpRows, state.imposterCount);
    const voteBreakdown = buildVoteBreakdown(state.votes, rpRows);

    for (const eliminatedId of tallyResult.eliminatedPlayerIds) {
      await pool.query(
        `UPDATE round_players
         SET    was_voted_out = 1
         WHERE  round_id       = ?
         AND    room_player_id = ?`,
        [state.roundId, eliminatedId]
      );
    }

    await pool.query(
      "UPDATE rounds SET status = 'results', ended_at = NOW() WHERE id = ?",
      [state.roundId]
    );

    const deltas = calculateDeltas({
      roundType:     round.round_type,
      roundPlayers:  rpRows,
      tallyResult,
      votes:         state.votes,
      imposterCount: state.imposterCount,
    });

    await applyDeltas(pool, deltas);

    const playerIds     = rpRows.map(p => p.playerId);
    const updatedScores = await fetchUpdatedScores(pool, playerIds);

    const eliminatedPlayers = rpRows.filter(p =>
      tallyResult.eliminatedPlayerIds.includes(p.playerId)
    );

    const targetPlayers = rpRows.filter(p =>
      ['imposter', 'reverse_spy_target', 'similar_word_target'].includes(p.role)
    );

    const correctVote = eliminatedPlayers.some(p =>
      ['imposter', 'reverse_spy_target', 'similar_word_target'].includes(p.role)
    );

    const resultPayload = {
      roundId:    state.roundId,
      roundType:  round.round_type,
      word:       round.word,
      alternateWord: round.alternate_word || null,

      eliminatedPlayer: eliminatedPlayers[0]
        ? { id: eliminatedPlayers[0].playerId, nickname: eliminatedPlayers[0].nickname, role: eliminatedPlayers[0].role }
        : null,

      targetPlayer: targetPlayers[0]
        ? { id: targetPlayers[0].playerId, nickname: targetPlayers[0].nickname, role: targetPlayers[0].role }
        : null,

      eliminatedPlayers: eliminatedPlayers.map(p => ({
        id: p.playerId, nickname: p.nickname, role: p.role,
      })),

      targetPlayers: targetPlayers.map(p => ({
        id: p.playerId, nickname: p.nickname, role: p.role,
      })),

      correctVote,
      isTie:         tallyResult.isTie,
      tiedPlayerIds: tallyResult.tiedPlayerIds,
      voteCounts:    tallyResult.voteCounts,
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

module.exports = {
  registerVoteHandlers,
  handleDisconnectDuringDiscussion,
  handleReconnectDuringDiscussion,
};