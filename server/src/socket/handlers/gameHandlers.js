// server/src/socket/handlers/gameHandlers.js
// ─────────────────────────────────────────────────────────────────────────────
//  Socket.IO handlers for round lifecycle.
//  Covers Phase 7 — socket delivery of round data.
//
//  Events handled:
//    round:start   — host triggers next round (or first round after voting)
//
//  Events emitted:
//    round:created       → whole room   (public info: type, category, player order)
//    round:info          → each socket  (private: their role + received_info)
//    error               → sender only  (validation failures)
//
//  This file does NOT handle: clues, discussion, voting, scoring.
//  Those will be added as separate handler files following the same pattern.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { createRound }         = require('../../services/roundService');
const { getConnectedPlayers }  = require('../queries');
const { initRoundState }       = require('../roundState');

/**
 * Registers game-phase socket events on a single socket.
 * Called from socket/index.js alongside registerLobbyHandlers.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {import('mysql2/promise').Pool} pool
 */
function registerGameHandlers(socket, io, pool) {

  // ── round:start ───────────────────────────────────────────────────────
  //
  // Triggered by the host after:
  //   - category voting has resolved  (status: 'voting' → 'in_progress')
  //   - or after previous round ended (status: 'in_progress', next round)
  //
  // The handler:
  //   1. Guards — must be in a room, must be host, room must be in right state
  //   2. Fetches room metadata needed for round creation
  //   3. Calls createRound (all DB work happens inside)
  //   4. Broadcasts public round info to the whole room
  //   5. Sends private role info to each player's individual socket
  //
  // No payload required from the client.
  socket.on('round:start', async () => {

    // ── Guard: must have joined a room ────────────────────────────────
    if (!socket.data.roomId) {
      return socket.emit('error', {
        code:    'NOT_IN_ROOM',
        message: 'You must be in a room to start a round.',
      });
    }

    // ── Guard: must be host ───────────────────────────────────────────
    if (!socket.data.isHost) {
      return socket.emit('error', {
        code:    'NOT_HOST',
        message: 'Only the host can start a round.',
      });
    }

    try {
      // ── Fetch room state ────────────────────────────────────────────
      const [roomRows] = await pool.query(
        `SELECT id, status, current_round, total_rounds,
                settings_json AS settingsJson
         FROM   rooms
         WHERE  id = ?
         LIMIT  1`,
        [socket.data.roomId]
      );

      if (roomRows.length === 0) {
        return socket.emit('error', { code: 'ROOM_NOT_FOUND', message: 'Room not found.' });
      }

      const room = roomRows[0];

      // ── Guard: room must be in a startable state ────────────────────
      // 'voting'      → first round starting after category vote
      // 'in_progress' → subsequent rounds
      if (room.status !== 'voting' && room.status !== 'in_progress') {
        return socket.emit('error', {
          code:    'INVALID_STATE',
          message: `Cannot start a round while room is in status "${room.status}".`,
        });
      }

      // ── Guard: all rounds completed ─────────────────────────────────
      if (room.current_round >= room.total_rounds) {
        return socket.emit('error', {
          code:    'GAME_OVER',
          message: 'All rounds have been played.',
        });
      }

      // ── Fetch connected players ─────────────────────────────────────
      const players = await getConnectedPlayers(pool, socket.data.roomId);

      if (players.length < 2) {
        return socket.emit('error', {
          code:    'NOT_ENOUGH_PLAYERS',
          message: 'Need at least 2 players to start a round.',
        });
      }

      // ── Parse settings ──────────────────────────────────────────────
      const settings = typeof room.settingsJson === 'string'
        ? JSON.parse(room.settingsJson)
        : room.settingsJson;

      const roundNumber = room.current_round + 1;

      // ── Set room to in_progress before creating round ───────────────
      // (Covers the 'voting' → 'in_progress' transition on round 1)
      await pool.query(
        "UPDATE rooms SET status = 'in_progress' WHERE id = ?",
        [socket.data.roomId]
      );

      // ── Create round (Phases 1-6) ───────────────────────────────────
      const round = await createRound(pool, {
        roomId:      socket.data.roomId,
        roundNumber,
        totalRounds: room.total_rounds,
        settings,
        players,
      });

      // ── Phase 7a: Broadcast public round info to whole room ─────────
      //
      // What every player can see:
      //  - round number and total
      //  - round type (so UI can show the right banner)
      //    EXCEPT chaos — never reveal it's a chaos round
      //  - category
      //  - clue order (whose turn is when)
      //
      // What is NOT in this broadcast:
      //  - word, hint, or any role data
      const publicClueOrder = round.assignments
        .sort((a, b) => a.clueOrder - b.clueOrder)
        .map(a => {
          const player = players.find(p => p.id === a.playerId);
          return { playerId: a.playerId, nickname: player ? player.nickname : '?', order: a.clueOrder };
        });

      const announcedRoundType = round.roundType === 'chaos' ? 'normal' : round.roundType;

      io.to(socket.data.roomCode).emit('round:created', {
        roundId:     round.roundId,
        roundNumber: round.roundNumber,
        totalRounds: room.total_rounds,
        roundType:   announcedRoundType,   // chaos is hidden
        category:    round.category,
        clueOrder:   publicClueOrder,
      });

      // ── Phase 7b: Send private role info to each player's socket ────
      //
      // We iterate over all sockets currently in this Socket.IO room,
      // match each socket to its player assignment, and emit privately.
      //
      // socket.to(socketId).emit() sends to one specific socket only.
      // io.to(roomCode).emit() would send to everyone — never use that
      // for role or word information.

      const roomSockets = await io.in(socket.data.roomCode).fetchSockets();

      for (const s of roomSockets) {
        const assignment = round.assignments.find(a => a.playerId === s.data.playerId);

        if (!assignment) continue; // socket in room but not in this round's player list

        s.emit('round:info', {
          roundId:      round.roundId,
          role:         assignment.role,
          receivedInfo: assignment.receivedInfo,
          clueOrder:    assignment.clueOrder,
          // Convenience flags so the frontend doesn't have to string-match role
          isImposter:   assignment.role === 'imposter',
          isOddOne:     assignment.role === 'similar_word_target',
          isSpy:        assignment.role === 'reverse_spy_target',
        });
      }

      console.log(
        `[socket] Round ${round.roundNumber} started in ${socket.data.roomCode} ` +
        `— type: ${round.roundType}, category: ${round.category}, word: ${round.word}`
      );

      // ── Initialise in-memory voting state ──────────────────────
      // Must happen AFTER round:info is sent so voteHandlers is ready
      // to receive player:ready events immediately.
      initRoundState(socket.data.roomCode, round.roundId, players.length);

    } catch (err) {
      console.error('[round:start] Error:', err.message);
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to start round.' });
    }
  });

}

module.exports = { registerGameHandlers };
