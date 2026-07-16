// server/src/socket/handlers/voteHandlers.js
// ─────────────────────────────────────────────────────────────────────────────
//  Socket.IO handlers for the discussion → voting → results pipeline.
//
//  M2.5/M3 changes:
//    All "how many players" and "who is eligible" questions now use
//    state.roundPlayerIds as the authoritative membership source, intersected
//    with live socket membership for online/offline distinctions.
//
//    Specifically:
//      - ready:update denominator  = onlineIds ∩ roundPlayerIds
//      - "all ready" check         = every (roundPlayerIds ∩ onlineIds) is ready
//      - vote target validation    = roundPlayerIds Set lookup (no DB query)
//      - voter eligibility         = roundPlayerIds membership check
//      - vote completion           = every (roundPlayerIds ∩ onlineIds) has voted
//
//    This replaces the previous mix of state.totalPlayers (stale count),
//    raw fetchSockets() membership (ignores round membership), and ad-hoc
//    DB queries (latency on hot path, inconsistent with in-memory state).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { getRoundState, clearRoundState } = require('../roundState');
const { tallyVotes, buildVoteBreakdown } = require('../../services/votingService');
const { calculateDeltas, applyDeltas, fetchUpdatedScores } = require('../../services/scoringService');
const { emitRound } = require('../utils/emitRound');

const VOTE_DURATION_MS = 30_000;
const VOTE_TICK_MS     = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the set of playerIds who are both in this round AND currently
 * connected (have a live socket in the room).
 *
 * This is the correct denominator for ready-checks and vote-completion:
 * "every round participant who can currently act."
 */
async function getOnlineRoundPlayerIds(io, roomCode, roundPlayerIds) {
  const sockets = await io.in(roomCode).fetchSockets();
  const online  = new Set();
  for (const s of sockets) {
    if (s.data.playerId && roundPlayerIds.has(s.data.playerId)) {
      online.add(s.data.playerId);
    }
  }
  return online;
}

function allOnlinePlayersReady(state, onlineRoundIds) {
  for (const id of onlineRoundIds) {
    if (!state.readyPlayers.has(id)) return false;
  }
  return true;
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

    // Voter must be a round participant
    if (!state.roundPlayerIds.has(socket.data.playerId)) {
      return socket.emit('error', { code: 'NOT_IN_ROUND', message: 'You are not in this round.' });
    }

    state.readyPlayers.add(socket.data.playerId);

    const onlineRoundIds = await getOnlineRoundPlayerIds(io, socket.data.roomCode, state.roundPlayerIds);
    const readyCount     = [...state.readyPlayers].filter(id => onlineRoundIds.has(id)).length;
    const totalOnline    = onlineRoundIds.size;

    io.to(socket.data.roomCode).emit('ready:update', { readyCount, totalPlayers: totalOnline });

    console.log(
      `[vote] ${socket.data.nickname} ready in ${socket.data.roomCode} ` +
      `(${readyCount}/${totalOnline} online round players)`
    );

    if (onlineRoundIds.size > 0 && allOnlinePlayersReady(state, onlineRoundIds)) {
      await startVotingPhase(io, pool, socket.data.roomCode, state);
    }
  });


  // ── round:start-next ─────────────────────────────────────────────────
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
         FROM   rooms WHERE id = ? LIMIT 1`,
        [socket.data.roomId]
      );

      if (!roomRows.length) {
        return socket.emit('error', { code: 'ROOM_NOT_FOUND', message: 'Room not found.' });
      }

      const room = roomRows[0];

      if (room.status !== 'in_progress') {
        return socket.emit('error', {
          code: 'INVALID_STATE',
          message: `Cannot start next round — room is "${room.status}".`,
        });
      }
      if (room.current_round >= room.total_rounds) {
        return socket.emit('error', { code: 'GAME_OVER', message: 'All rounds have already been played.' });
      }

      const settings = typeof room.settingsJson === 'string'
        ? JSON.parse(room.settingsJson) : room.settingsJson;

      await emitRound(io, pool, {
        roomId:      socket.data.roomId,
        roomCode:    socket.data.roomCode,
        roundNumber: room.current_round + 1,
        totalRounds: room.total_rounds,
        settings,
      });

      console.log(`[vote] Host ${socket.data.nickname} started round ${room.current_round + 1} in ${socket.data.roomCode}`);

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
      return socket.emit('error', { code: 'WRONG_PHASE', message: 'Voting is not currently open.' });
    }

    const voterId       = socket.data.playerId;
    const imposterCount = state.imposterCount;

    // Voter must be a round participant
    if (!state.roundPlayerIds.has(voterId)) {
      return socket.emit('error', { code: 'NOT_IN_ROUND', message: 'You are not in this round.' });
    }

    if (state.votes.has(voterId)) {
      return socket.emit('error', { code: 'ALREADY_VOTED', message: 'You have already voted this round.' });
    }

    if (!Array.isArray(targetPlayerIds)) {
      return socket.emit('error', { code: 'INVALID_TARGET', message: 'targetPlayerIds must be an array.' });
    }
    if (targetPlayerIds.length !== imposterCount) {
      return socket.emit('error', {
        code:    'INVALID_TARGET',
        message: `You must vote for exactly ${imposterCount} player${imposterCount === 1 ? '' : 's'}.`,
      });
    }

    const targetIds = targetPlayerIds.map(Number);

    if (targetIds.some(id => !id || isNaN(id))) {
      return socket.emit('error', { code: 'INVALID_TARGET', message: 'One or more target player IDs are invalid.' });
    }
    if (new Set(targetIds).size !== targetIds.length) {
      return socket.emit('error', { code: 'INVALID_TARGET', message: 'You cannot vote for the same player twice.' });
    }
    if (targetIds.includes(voterId)) {
      return socket.emit('error', { code: 'SELF_VOTE', message: 'You cannot vote for yourself.' });
    }

    // ── Target validation: roundPlayerIds Set lookup — no DB query ──────
    // roundPlayerIds is the authoritative membership for this round.
    // A reserved-seat (offline but not removed) player is still a valid
    // target — their roundPlayerIds membership is set at round creation
    // and never changes, regardless of subsequent disconnects.
    for (const targetId of targetIds) {
      if (!state.roundPlayerIds.has(targetId)) {
        return socket.emit('error', {
          code:    'INVALID_TARGET',
          message: 'One or more target players are not in this round.',
        });
      }
    }

    state.votes.set(voterId, targetIds);

    try {
      for (const targetId of targetIds) {
        await pool.query(
          'INSERT INTO votes (round_id, voter_id, target_id) VALUES (?, ?, ?)',
          [state.roundId, voterId, targetId]
        );
      }
    } catch (dbErr) {
      if (dbErr.code !== 'ER_DUP_ENTRY') throw dbErr;
    }

    // ── Completion check: every online round participant has voted ───────
    const onlineRoundIds = await getOnlineRoundPlayerIds(io, socket.data.roomCode, state.roundPlayerIds);
    const onlineVoted    = [...state.votes.keys()].filter(id => onlineRoundIds.has(id)).length;

    console.log(
      `[vote] ${socket.data.nickname} voted [${targetIds.join(', ')}] in ${socket.data.roomCode} ` +
      `(${onlineVoted}/${onlineRoundIds.size} online voted)`
    );

    if (onlineRoundIds.size > 0 && onlineVoted >= onlineRoundIds.size) {
      if (state.voteTimer) { clearTimeout(state.voteTimer); state.voteTimer = null; }
      console.log(`[vote:submit] All players voted in ${socket.data.roomCode}, starting resolveVoting...`);

await resolveVoting(io, pool, socket.data.roomCode, state);

console.log(`[vote:submit] resolveVoting finished for ${socket.data.roomCode}`);
    }
  });
}


// ─────────────────────────────────────────────
//  Exported hooks for lobbyHandlers
// ─────────────────────────────────────────────

async function handleDisconnectDuringDiscussion(io, pool, roomCode, playerId, nickname) {
  const state = getRoundState(roomCode);
  if (!state || state.phase !== 'discussion') return;
  if (!state.roundPlayerIds.has(playerId)) return;

  state.readyPlayers.add(playerId);

  const onlineRoundIds = await getOnlineRoundPlayerIds(io, roomCode, state.roundPlayerIds);
  const readyCount     = [...state.readyPlayers].filter(id => onlineRoundIds.has(id)).length;
  const totalOnline    = onlineRoundIds.size;

  io.to(roomCode).emit('ready:update', { readyCount, totalPlayers: totalOnline });
  console.log(`[vote] ${nickname} auto-readied on disconnect in ${roomCode} (${readyCount}/${totalOnline})`);

  if (onlineRoundIds.size > 0 && allOnlinePlayersReady(state, onlineRoundIds)) {
    await startVotingPhase(io, pool, roomCode, state);
  }
}

async function handleReconnectDuringDiscussion(io, roomCode) {
  const state = getRoundState(roomCode);
  if (!state || state.phase !== 'discussion') return;

  const onlineRoundIds = await getOnlineRoundPlayerIds(io, roomCode, state.roundPlayerIds);
  const readyCount     = [...state.readyPlayers].filter(id => onlineRoundIds.has(id)).length;
  const totalOnline    = onlineRoundIds.size;

  io.to(roomCode).emit('ready:update', { readyCount, totalPlayers: totalOnline });
  console.log(`[vote] Ready count recalculated after reconnect in ${roomCode} (${readyCount}/${totalOnline})`);
}


// ─────────────────────────────────────────────
//  Internal: start voting phase
// ─────────────────────────────────────────────

async function startVotingPhase(io, pool, roomCode, state) {
  state.phase = 'voting';

  await pool.query("UPDATE rounds SET status = 'voting' WHERE id = ?", [state.roundId]);
  io.to(roomCode).emit('voting:start', { roundId: state.roundId });
  console.log(`[vote] Voting started in ${roomCode}`);

  let secondsLeft = VOTE_DURATION_MS / 1000;

  state.tickInterval = setInterval(() => {
    secondsLeft--;
    io.to(roomCode).emit('vote:timer', { secondsRemaining: secondsLeft });
    if (secondsLeft <= 0) clearInterval(state.tickInterval);
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
//  Internal: resolve voting
// ─────────────────────────────────────────────

async function resolveVoting(io, pool, roomCode, state) {
  console.log(`[resolveVoting] START room=${roomCode} round=${state.roundId}`);
  if (state.phase === 'results') return;
  state.phase = 'results';

  if (state.voteTimer)    clearTimeout(state.voteTimer);
  if (state.tickInterval) clearInterval(state.tickInterval);

  try {
    console.log("[resolveVoting] Query 1 - Fetching round...");
    const [roundRows] = await pool.query(
      `SELECT r.id, r.round_type, r.word, r.alternate_word,
              r.room_id, rm.current_round, rm.total_rounds
       FROM   rounds r JOIN rooms rm ON rm.id = r.room_id
       WHERE  r.id = ? LIMIT 1`,
      [state.roundId]
    );
    console.log("[resolveVoting] Query 1 complete.");

    if (!roundRows.length) {
      console.error(`[resolveVoting] Round ${state.roundId} not found`);
      return;
    }

    const round = roundRows[0];

    console.log("[resolveVoting] Query 2 - Fetching round players...");
    const [rpRows] = await pool.query(
      `SELECT rp.room_player_id AS playerId, rmp.nickname, rp.role, rp.received_info AS receivedInfo
       FROM   round_players rp
       JOIN   room_players  rmp ON rmp.id = rp.room_player_id
       WHERE  rp.round_id = ?`,
      [state.roundId]
    );
    console.log("[resolveVoting] Query 2 complete.");

    const tallyResult   = tallyVotes(state.votes, rpRows, state.imposterCount);
    const voteBreakdown = buildVoteBreakdown(state.votes, rpRows);

    for (const eliminatedId of tallyResult.eliminatedPlayerIds) {
      await pool.query(
        'UPDATE round_players SET was_voted_out = 1 WHERE round_id = ? AND room_player_id = ?',
        [state.roundId, eliminatedId]
      );
    }

    await pool.query("UPDATE rounds SET status = 'results', ended_at = NOW() WHERE id = ?", [state.roundId]);

    const deltas = calculateDeltas({
      roundType:     round.round_type,
      roundPlayers:  rpRows,
      tallyResult,
      votes:         state.votes,
      imposterCount: state.imposterCount,
    });

    console.log("[resolveVoting] Applying score deltas...");

await applyDeltas(pool, deltas);

console.log("[resolveVoting] Score deltas applied.");

console.log("[resolveVoting] Fetching updated scores...");    
const updatedScores     = await fetchUpdatedScores(pool, rpRows.map(p => p.playerId));
console.log("[resolveVoting] Updated scores fetched.");
    const eliminatedPlayers = rpRows.filter(p => tallyResult.eliminatedPlayerIds.includes(p.playerId));
    const targetPlayers     = rpRows.filter(p =>
      ['imposter', 'reverse_spy_target', 'similar_word_target'].includes(p.role)
    );
    const correctVote = eliminatedPlayers.some(p =>
      ['imposter', 'reverse_spy_target', 'similar_word_target'].includes(p.role)
    );

    console.log("[resolveVoting] Emitting round:result...");
    io.to(roomCode).emit('round:result', {
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

      eliminatedPlayers: eliminatedPlayers.map(p => ({ id: p.playerId, nickname: p.nickname, role: p.role })),
      targetPlayers:     targetPlayers.map(p => ({ id: p.playerId, nickname: p.nickname, role: p.role })),

      correctVote,
      isTie:         tallyResult.isTie,
      tiedPlayerIds: tallyResult.tiedPlayerIds,
      voteCounts:    tallyResult.voteCounts,
      voteBreakdown,

      scoreDeltas: deltas.reduce((acc, d) => { acc[d.playerId] = d.delta; return acc; }, {}),
      scores:      updatedScores,
    });
    console.log("[resolveVoting] round:result emitted.");

    console.log(
      `[vote] Round ${state.roundId} resolved in ${roomCode} — ` +
      `eliminated: [${eliminatedPlayers.map(p => p.nickname).join(', ') || 'nobody'}]`
    );

    clearRoundState(roomCode);

    const isLastRound = round.current_round >= round.total_rounds;
    if (isLastRound) {
      io.to(roomCode).emit('game:finished', { finalScores: updatedScores });
      await pool.query("UPDATE rooms SET status = 'finished' WHERE id = ?", [round.room_id]);
      console.log(`[vote] Game finished in ${roomCode}`);
    } else {
      io.to(roomCode).emit('round:next', {
        nextRoundNumber: round.current_round + 1,
        totalRounds:     round.total_rounds,
      });
    }

  } catch (err) {
    console.error("[resolveVoting] ERROR:", err);
    io.to(roomCode).emit('error', {
      code: 'SERVER_ERROR',
      message: 'An error occurred resolving the round. Please ask the host to restart.',
    });
  }
}

module.exports = {
  registerVoteHandlers,
  handleDisconnectDuringDiscussion,
  handleReconnectDuringDiscussion,
};