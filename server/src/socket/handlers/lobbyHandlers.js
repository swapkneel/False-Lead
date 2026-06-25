// server/src/socket/handlers/lobbyHandlers.js
// ─────────────────────────────────────────────────────────────────────────────
//  Lobby Socket.IO handlers.
//
//  Change from previous version:
//    game:start now creates round 1 automatically after emitting game:starting.
//    The frontend no longer needs to emit round:start to begin the first round.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const {
  getPlayerByToken,
  getConnectedPlayers,
  setPlayerConnected,
  promoteNextHost,
  updateRoomSettings,
  setRoomStatus,
} = require('../queries');

const { emitRound } = require('../utils/emitRound');

// ─────────────────────────────────────────────
//  Broadcast helper
// ─────────────────────────────────────────────

async function broadcastLobbyState(io, pool, roomCode, roomId, roomMeta) {
  const players = await getConnectedPlayers(pool, roomId);

  io.to(roomCode).emit('lobby:updated', {
    roomCode,
    status:      roomMeta.status,
    preset:      roomMeta.preset,
    totalRounds: roomMeta.totalRounds,
    settings:    roomMeta.settingsJson,
    playerCount: players.length,
    players,
  });
}

// ─────────────────────────────────────────────
//  Handler registration
// ─────────────────────────────────────────────

function registerLobbyHandlers(socket, io, pool) {

  // ── room:join ─────────────────────────────────────────────────────────
  socket.on('room:join', async ({ sessionToken } = {}) => {
    if (!sessionToken || typeof sessionToken !== 'string') {
      return socket.emit('error', {
        code:    'INVALID_TOKEN',
        message: 'sessionToken is required to join a room.',
      });
    }

    try {
      const player = await getPlayerByToken(pool, sessionToken);
      

      if (!player) {
        return socket.emit('error', {
          code:    'INVALID_TOKEN',
          message: 'Session not recognised. Please rejoin the room.',
        });
      }

      if (player.roomStatus === 'finished') {
        return socket.emit('error', {
          code:    'ROOM_FINISHED',
          message: 'This room has finished.',
        });
      }

      socket.data.playerId  = player.playerId;
      socket.data.roomId    = player.roomId;
      socket.data.roomCode  = player.roomCode;
      socket.data.nickname  = player.nickname;
      socket.data.isHost    = player.isHost;

      await setPlayerConnected(pool, player.playerId, true);
      await socket.join(player.roomCode);

      socket.emit('room:joined', {
        playerId:    player.playerId,
        nickname:    player.nickname,
        isHost:      player.isHost,
        roomCode:    player.roomCode,
        roomStatus:  player.roomStatus,
      });

      await broadcastLobbyState(io, pool, player.roomCode, player.roomId, {
        status:       player.roomStatus,
        preset:       player.preset,
        totalRounds:  player.totalRounds,
        settingsJson: player.settingsJson,
      });

      console.log(`[socket] ${player.nickname} joined room ${player.roomCode}`);

    } catch (err) {
      console.error('[room:join] Error:', err.message);
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to join room.' });
    }
  });


  // ── room:leave ────────────────────────────────────────────────────────
  socket.on('room:leave', async () => {
    await handleDeparture(socket, io, pool, 'leave');
  });


  // ── disconnect ────────────────────────────────────────────────────────
  socket.on('disconnect', async (reason) => {
    console.log(`[socket] disconnect — reason: ${reason}, socket: ${socket.id}`);
    await handleDeparture(socket, io, pool, 'disconnect');
  });


  // ── settings:update ───────────────────────────────────────────────────
  socket.on('settings:update', async ({ preset, settings } = {}) => {
    if (!socket.data.roomId) {
      return socket.emit('error', { code: 'NOT_IN_ROOM', message: 'You are not in a room.' });
    }
    if (!socket.data.isHost) {
      return socket.emit('error', { code: 'NOT_HOST', message: 'Only the host can change settings.' });
    }

    try {
      await updateRoomSettings(pool, socket.data.roomId, { preset, settings });

      const token  = await getSessionTokenByPlayerId(pool, socket.data.playerId);
      const player = await getPlayerByToken(pool, token);
      if (!player) return;

      await broadcastLobbyState(io, pool, socket.data.roomCode, socket.data.roomId, {
        status:       player.roomStatus,
        preset:       player.preset,
        totalRounds:  player.totalRounds,
        settingsJson: player.settingsJson,
      });

      console.log(`[socket] ${socket.data.nickname} updated settings in ${socket.data.roomCode}`);

    } catch (err) {
      console.error('[settings:update] Error:', err.message);
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to update settings.' });
    }
  });


  // ── game:start ────────────────────────────────────────────────────────
  //
  // FIX (Issue 1): game:start now creates round 1 automatically.
  // Flow:
  //   1. Guard checks (host, player count)
  //   2. Set room status → 'in_progress'
  //   3. Emit game:starting  → all clients navigate to /game
  //   4. Create round 1 + emit round:created + round:info (via emitRound)
  //
  // The frontend must NOT emit round:start to trigger the first round.
  socket.on('game:start', async () => {
    if (!socket.data.roomId) {
      return socket.emit('error', { code: 'NOT_IN_ROOM', message: 'You are not in a room.' });
    }
    if (!socket.data.isHost) {
      return socket.emit('error', { code: 'NOT_HOST', message: 'Only the host can start the game.' });
    }

    try {
      // ── Fetch room state ─────────────────────────────────────────────
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

      if (room.status !== 'waiting' && room.status !== 'voting') {
        return socket.emit('error', {
          code:    'INVALID_STATE',
          message: `Cannot start: room is already "${room.status}".`,
        });
      }

      const players = await getConnectedPlayers(pool, socket.data.roomId);

      if (players.length < 3) {
  return socket.emit('error', {
    code: 'NOT_ENOUGH_PLAYERS',
    message: 'At least 3 players are required to start the game.',
  });
}

      const settings = typeof room.settingsJson === 'string'
        ? JSON.parse(room.settingsJson)
        : room.settingsJson;

      // ── Transition room to in_progress ──────────────────────────────
      await setRoomStatus(pool, socket.data.roomId, 'in_progress');

      // ── Notify all clients to navigate to game screen ───────────────
      io.to(socket.data.roomCode).emit('game:starting', {
        roomCode: socket.data.roomCode,
        message:  'The game is starting!',
      });

      console.log(`[socket] Game started in ${socket.data.roomCode} by ${socket.data.nickname}`);

      // ── Create and emit round 1 ─────────────────────────────────────
      // Small delay ensures clients have navigated to /game before
      // round:created arrives, preventing events dropped on the floor.
      await new Promise(resolve => setTimeout(resolve, 300));

      await emitRound(io, pool, {
        roomId:      socket.data.roomId,
        roomCode:    socket.data.roomCode,
        roundNumber: 1,
        totalRounds: room.total_rounds,
        settings,
      });

    } catch (err) {
      console.error('[game:start] Error:', err.message);
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to start game.' });
    }
  });

} // end registerLobbyHandlers


// ─────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────

async function handleDeparture(socket, io, pool, reason) {
  if (!socket.data.playerId) return;

  const { playerId, roomId, roomCode, nickname, isHost } = socket.data;

  try {
    await setPlayerConnected(pool, playerId, false);

    if (isHost) {
      const newHost = await promoteNextHost(pool, roomId, playerId);
      if (newHost) {
        const roomSockets = await io.in(roomCode).fetchSockets();
        for (const s of roomSockets) {
          if (s.data.playerId === newHost.id) {
            s.data.isHost = true;
            s.emit('host:promoted', { message: `${nickname} left. You are now the host.` });
            break;
          }
        }
        console.log(`[socket] ${newHost.nickname} promoted to host in ${roomCode}`);
      }
    }

    socket.leave(roomCode);
    socket.data = {};

    console.log(`[socket] ${nickname} ${reason === 'leave' ? 'left' : 'disconnected from'} room ${roomCode}`);

    const remaining = await getConnectedPlayers(pool, roomId);
    if (remaining.length === 0) return;

    const [roomRow] = await pool.query(
      `SELECT status, preset, settings_json AS settingsJson, total_rounds AS totalRounds
       FROM rooms WHERE id = ? LIMIT 1`,
      [roomId]
    );
    if (!roomRow.length) return;

    const meta = {
      ...roomRow[0],
      settingsJson: typeof roomRow[0].settingsJson === 'string'
        ? JSON.parse(roomRow[0].settingsJson)
        : roomRow[0].settingsJson,
    };

    await broadcastLobbyState(io, pool, roomCode, roomId, meta);

  } catch (err) {
    console.error(`[handleDeparture:${reason}] Error:`, err.message);
  }
}

async function getSessionTokenByPlayerId(pool, playerId) {
  const [rows] = await pool.query(
    'SELECT session_token FROM room_players WHERE id = ? LIMIT 1',
    [playerId]
  );
  return rows.length > 0 ? rows[0].session_token : null;
}

module.exports = { registerLobbyHandlers };
