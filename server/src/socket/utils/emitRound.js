// server/src/socket/utils/emitRound.js
// ─────────────────────────────────────────────────────────────────────────────
//  Shared helper: create a round in the DB and emit all socket events for it.
//
//  Previously this logic lived only in gameHandlers. Extracting it here lets:
//    lobbyHandlers  — auto-start round 1 when game:start fires
//    voteHandlers   — auto-start round N+1 when the previous round resolves
//    gameHandlers   — kept as a thin wrapper around this (round:start event)
//
//  This function owns phases 1-7 end-to-end for a single round:
//    1-6  createRound()  — DB work (word, roles, inserts)
//    7a   round:created  → broadcast to room
//    7b   round:info     → emit privately to each socket
//    -    initRoundState — ready for player:ready events
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { createRound }    = require('../../services/roundService');
const { initRoundState } = require('../roundState');
const { getConnectedPlayers } = require('../queries');

/**
 * Creates a round and emits all socket events for it.
 * Called from lobbyHandlers (round 1) and voteHandlers (round N+1).
 *
 * @param {import('socket.io').Server} io
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} params
 * @param {number}   params.roomId
 * @param {string}   params.roomCode
 * @param {number}   params.roundNumber      — 1-based
 * @param {number}   params.totalRounds
 * @param {object}   params.settings         — parsed settings_json
 *
 * @returns {Promise<void>}
 * @throws  passes through any error from createRound for the caller to handle
 */
async function emitRound(io, pool, { roomId, roomCode, roundNumber, totalRounds, settings }) {
  // Always fetch fresh connected players at emit time — state may have
  // changed between game:start and now (disconnect during category voting etc.)
  const players = await getConnectedPlayers(pool, roomId);

  if (players.length < 2) {
    throw Object.assign(new Error('Not enough players to start a round'), {
      code: 'NOT_ENOUGH_PLAYERS',
    });
  }

  // ── Phases 1-6: DB work ───────────────────────────────────────────────
  const round = await createRound(pool, {
    roomId,
    roundNumber,
    totalRounds,
    settings,
    players,
  });

  // ── Phase 7a: public broadcast to whole room ──────────────────────────
  // Chaos disguises itself as normal in the public event.
  const announcedRoundType = round.roundType === 'chaos' ? 'normal' : round.roundType;

  const publicClueOrder = round.assignments
    .sort((a, b) => a.clueOrder - b.clueOrder)
    .map(a => {
      const player = players.find(p => p.id === a.playerId);
      return {
        playerId: a.playerId,
        nickname: player ? player.nickname : '?',
        order:    a.clueOrder,
      };
    });

  io.to(roomCode).emit('round:created', {
    roundId:     round.roundId,
    roundNumber: round.roundNumber,
    totalRounds,
    roundType:   announcedRoundType,
    category:    round.category,
    clueOrder:   publicClueOrder,
  });

  // ── Phase 7b: private emit to each socket ─────────────────────────────
  // Fetch all sockets currently in this Socket.IO room and match them
  // to their assignment. Uses s.emit() — never io.to(room).emit() for secrets.
  const roomSockets = await io.in(roomCode).fetchSockets();

  for (const s of roomSockets) {
    const assignment = round.assignments.find(a => a.playerId === s.data.playerId);
    if (!assignment) continue;

    s.emit('round:info', {
      roundId:      round.roundId,
      role:         assignment.role,
      receivedInfo: assignment.receivedInfo,
      clueOrder:    assignment.clueOrder,
      isImposter:   assignment.role === 'imposter',
      isOddOne:     assignment.role === 'similar_word_target',
      isSpy:        assignment.role === 'reverse_spy_target',
    });
  }

  // ── Init in-memory voting state ───────────────────────────────────────
  // Must happen after socket events so player:ready can fire immediately.
  initRoundState(roomCode, round.roundId, players.length);

  console.log(
    `[emitRound] Round ${round.roundNumber} started in ${roomCode} ` +
    `— type: ${round.roundType}, category: ${round.category}, word: ${round.word}`
  );
}

module.exports = { emitRound };
