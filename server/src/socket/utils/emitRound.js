// server/src/socket/utils/emitRound.js
// ─────────────────────────────────────────────────────────────────────────────
//  Shared helper: create a round in the DB and emit all socket events for it.
//
//  This function owns phases 1-7 end-to-end for a single round:
//    1-6  createRound()  — DB work (word, roles, inserts)
//    7a   round:created  → broadcast to room
//    7b   round:info     → emit privately to each socket
//    -    initRoundState — ready for player:ready events
//
//  Regression fix (post-M2 reconnect testing):
//    Previously this used getConnectedPlayers (is_connected = 1 only) to
//    build the round roster. This meant a player who was mid-grace-period
//    (disconnected but their seat still reserved) was silently excluded
//    from the round entirely — no role, no round_players row, no clue
//    order slot. When they reconnected they had nothing to rejoin into,
//    they could not be voted for ("may not be present"), and totalPlayers
//    counts went stale because the round was built for N-1 players while
//    the room still had N seats.
//
//    Fix: use getRoomPlayers WITHOUT the onlineOnly filter. A reserved
//    seat participates fully in the round (role, clue order, vote
//    eligibility) regardless of current connection status — exactly as
//    originally specified: disconnection during a round must never remove
//    a player from that round, only from live interaction.
//
//    The minimum-player check still requires 3 to START a round at all,
//    but that check now also counts reserved seats, matching game:start's
//    existing online-only check intentionally being separate (you need
//    online players to START — see lobbyHandlers — but once started, an
//    offline-but-reserved seat still belongs to the round).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { createRound }          = require('../../services/roundService');
const { initRoundState }       = require('../roundState');
const { getRoomPlayers }       = require('../queries');
const { resolveImposterCount } = require('../../services/roleAssignmentService');

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
  // ── M1.2 fix: roster includes reserved (offline-but-not-removed) seats ──
  // Previously this used getConnectedPlayers (is_connected = 1 only), which
  // excluded anyone mid-grace-period from the round entirely. A reserved
  // seat must still receive a role and a round_players row — only live
  // interaction (voting, ready) is affected by connection status, not
  // round membership.
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
  console.log('Round:', roundNumber);
  console.log('Settings:', settings);
  console.log('Resolved imposters:', imposterCount);
  console.log('Roster size (incl. reserved seats):', players.length);
  console.log('===============================');

  // ── Phases 1-6: DB work ───────────────────────────────────────────────
  const round = await createRound(pool, {
    roomId,
    roundNumber,
    totalRounds,
    settings,
    players,
  });

  // ── Phase 7a: public broadcast to whole room ──────────────────────────
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
    roundId:      round.roundId,
    roundNumber:  round.roundNumber,
    totalRounds,
    roundType:    announcedRoundType,
    category:     round.category,
    clueOrder:    publicClueOrder,
    imposterCount,
  });

  // ── Phase 7b: private emit to each connected socket ───────────────────
  // Note: only currently-connected sockets receive round:info directly.
  // A player mid-grace-period has no live socket to receive this — they
  // will get their role via round:rejoin when they reconnect, since their
  // round_players row now exists (the fix above) and emitRejoin reads it.
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

  // ── Init in-memory voting state ───────────────────────────────────────
  // totalPlayers now reflects the FULL roster (reserved seats included),
  // matching round_players row count. voteHandlers derives the "online"
  // subset live via socket room membership for ready/vote-completion
  // checks — totalPlayers here is the round's seat count, not the online
  // count, and the two are intentionally different numbers used for
  // different purposes.
  initRoundState(roomCode, round.roundId, players.length, imposterCount);

  console.log(
    `[emitRound] Round ${round.roundNumber} started in ${roomCode} ` +
    `— type: ${round.roundType}, category: ${round.category}, word: ${round.word}, ` +
    `imposters: ${imposterCount}, roster: ${players.length}`
  );
}

module.exports = { emitRound };