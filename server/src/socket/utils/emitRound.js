// server/src/socket/utils/emitRound.js
// ─────────────────────────────────────────────────────────────────────────────
//  Shared helper: create a round in the DB and emit all socket events for it.
//
//  M2.5/M3 changes:
//    1. initRoundState now receives playerIds[] instead of a bare count, so
//       roundState.roundPlayerIds can be the single authoritative membership
//       source for vote eligibility and completion checks.
//
//    2. round:created now includes a `players` array in the same shape as
//       round:rejoin — [{ id, nickname, isHost, isOnline, score }].
//       Every client (reconnecting or not) updates GameContext.players from
//       this event at every round boundary, closing the "players never
//       refreshed between rounds" desync gap permanently.
//
//  Roster note: getRoomPlayers (all seats, including grace-period) is used
//  intentionally — a reserved-but-offline player participates fully in the
//  round (role, clue order, vote eligibility). Online status is tracked via
//  isOnline on each player entry, not by exclusion from the roster.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { createRound }          = require('../../services/roundService');
const { initRoundState }       = require('../roundState');
const { getRoomPlayers }       = require('../queries');
const { resolveImposterCount } = require('../../services/roleAssignmentService');

/**
 * @param {import('socket.io').Server} io
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} params
 * @param {number}   params.roomId
 * @param {string}   params.roomCode
 * @param {number}   params.roundNumber
 * @param {number}   params.totalRounds
 * @param {object}   params.settings
 */
async function emitRound(io, pool, { roomId, roomCode, roundNumber, totalRounds, settings }) {
  // All seats (including grace-period reserved) belong to the round roster.
  const players = await getRoomPlayers(pool, roomId);

  if (players.length < 3) {
    throw Object.assign(new Error('Not enough players to start a round'), {
      code: 'NOT_ENOUGH_PLAYERS',
    });
  }

  const imposterCount = resolveImposterCount(
    settings.imposter_count,
    players.length
  );

  console.log('========== EMIT ROUND ==========');
  console.log('Round:', roundNumber, '| Imposters:', imposterCount, '| Roster:', players.length);
  console.log('================================');

  // ── DB work ───────────────────────────────────────────────────────────
  const round = await createRound(pool, {
    roomId,
    roundNumber,
    totalRounds,
    settings,
    players,
  });

  // ── Unified roster payload ────────────────────────────────────────────
  // Same shape sent in both round:created and round:rejoin so the client
  // can handle both identically. isOnline reflects current DB state.
  const rosterPayload = players.map(p => ({
    id:       p.id,
    nickname: p.nickname,
    isHost:   p.isHost,
    isOnline: p.isOnline,
    score:    p.score,
  }));

  // ── round:created — public broadcast ─────────────────────────────────
  const announcedRoundType = round.roundType === 'chaos' ? 'normal' : round.roundType;

  const publicClueOrder = round.assignments
    .sort((a, b) => a.clueOrder - b.clueOrder)
    .map(a => {
      const player = players.find(p => p.id === a.playerId);
      return { playerId: a.playerId, nickname: player ? player.nickname : '?', order: a.clueOrder };
    });

  io.to(roomCode).emit('round:created', {
    roundId:      round.roundId,
    roundNumber:  round.roundNumber,
    totalRounds,
    roundType:    announcedRoundType,
    category:     round.category,
    clueOrder:    publicClueOrder,
    imposterCount,
    players:      rosterPayload,   // ← M2.5: unified roster
  });

  // ── round:info — private per socket ──────────────────────────────────
  const roomSockets = await io.in(roomCode).fetchSockets();

  for (const s of roomSockets) {
    const assignment = round.assignments.find(a => a.playerId === s.data.playerId);
    if (!assignment) continue;

    const visibleRole = assignment.socketRole ?? assignment.role;

    s.emit('round:info', {
      roundId:      round.roundId,
      role:         visibleRole,
      receivedInfo: assignment.receivedInfo,
      clueOrder:    assignment.clueOrder,
      isImposter:   visibleRole === 'imposter',
      isOddOne:     false,
      isSpy:        visibleRole === 'reverse_spy_target',
    });
  }

  // ── initRoundState ────────────────────────────────────────────────────
  // Pass the full playerIds array so roundState.roundPlayerIds is the
  // authoritative membership set for this round.
  const playerIds = players.map(p => p.id);
  initRoundState(roomCode, round.roundId, playerIds, imposterCount);

  console.log(
    `[emitRound] Round ${round.roundNumber} in ${roomCode} — ` +
    `type: ${round.roundType}, word: ${round.word}, ` +
    `imposters: ${imposterCount}, roster: ${players.length}`
  );
}

module.exports = { emitRound };