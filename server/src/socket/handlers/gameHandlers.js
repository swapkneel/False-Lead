// server/src/socket/handlers/gameHandlers.js
// ─────────────────────────────────────────────────────────────────────────────
//  Game-phase socket handlers.
//
//  Change from previous version:
//    round:start is now only used for rounds 2+ (host-triggered next round).
//    Round 1 is created automatically by game:start in lobbyHandlers.
//    The actual round creation + socket emit logic lives in utils/emitRound.js.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { emitRound } = require('../utils/emitRound');

function registerGameHandlers(socket, io, pool) {

  // ── round:start ───────────────────────────────────────────────────────
  //
  // Host emits this to begin rounds 2, 3, … N.
  // Round 1 is started automatically by game:start — this event only
  // fires for subsequent rounds, triggered by the host after seeing results.
  //
  // Status must be 'in_progress' (never 'voting' — that transition is gone).
  socket.on('round:start', async () => {
    if (!socket.data.roomId) {
      return socket.emit('error', { code: 'NOT_IN_ROOM', message: 'You must be in a room.' });
    }
    if (!socket.data.isHost) {
      return socket.emit('error', { code: 'NOT_HOST', message: 'Only the host can start a round.' });
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
          message: `Cannot start a round while room is "${room.status}".`,
        });
      }

      if (room.current_round >= room.total_rounds) {
        return socket.emit('error', { code: 'GAME_OVER', message: 'All rounds have been played.' });
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

    } catch (err) {
      console.error('[round:start] Error:', err.message);
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to start round.' });
    }
  });

}

module.exports = { registerGameHandlers };
