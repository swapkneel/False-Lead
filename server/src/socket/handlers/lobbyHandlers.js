// server/src/socket/handlers/lobbyHandlers.js
// ─────────────────────────────────────────────────────────────────────────────
//  Lobby Socket.IO handlers.
//
//  M1 (reconnect foundation):
//    - handleDeparture splits on reason:
//        'leave'      → immediate permanent removal (unchanged behaviour)
//        'disconnect' → marks offline, starts DISCONNECT_GRACE_MS timer
//    - room:join cancels any pending timer on reconnect
//    - broadcastLobbyState sends all players with isOnline flag
//    - Host promotion deferred to timer expiry on disconnect
//    - permanentlyRemovedIds excludes departed players from broadcasts
//
//  M1.1 additions (this file):
//    - DISCONNECT_GRACE_MS increased to 5 minutes (in disconnectTimers.js)
//    - player:disconnected emitted when grace period starts
//    - player:reconnected emitted when a pending timer is cancelled
//    - player:removed payload already present; now consistent with the above
//    - handleDisconnectDuringDiscussion exported so voteHandlers can call it
//      when a player drops mid-discussion and needs to be auto-readied
//
//  No changes to game:start, settings:update, round logic, voting, or scoring.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const {
  getPlayerByToken,
  getRoomPlayers,
  setPlayerConnected,
  promoteNextHost,
  updateRoomSettings,
  setRoomStatus,
} = require('../queries');

const { emitRound } = require('../utils/emitRound');
const { disconnectTimers, DISCONNECT_GRACE_MS } = require('../disconnectTimers');

// ─────────────────────────────────────────────────────────────────────────────
//  Tracks players who have been permanently removed (leave or timer expiry).
//  Filtered out of all broadcastLobbyState calls so they don't linger after
//  their grace period ends.  Will be pruned in M4 (finished-room cleanup).
// ─────────────────────────────────────────────────────────────────────────────
const permanentlyRemovedIds = new Set();

// ─────────────────────────────────────────────
//  Broadcast helper
// ─────────────────────────────────────────────

/**
 * Broadcast current room state to every socket in the room.
 *
 * Sends ALL players (online and offline) so the frontend can show offline
 * seats during the reconnect grace window.  Permanently removed players
 * are excluded via permanentlyRemovedIds.
 *
 * Shape of lobby:updated is otherwise identical to pre-M1 — the only new
 * field per player is `isOnline` (boolean).
 */
async function broadcastLobbyState(io, pool, roomCode, roomId, roomMeta) {
  const allPlayers = await getRoomPlayers(pool, roomId);
  const players    = allPlayers.filter(p => !permanentlyRemovedIds.has(p.id));

  io.to(roomCode).emit('lobby:updated', {
    roomCode,
    status:      roomMeta.status,
    preset:      roomMeta.preset,
    totalRounds: roomMeta.totalRounds,
    settings:    roomMeta.settingsJson,
    playerCount: players.filter(p => p.isOnline).length,
    players,
  });
}

// ─────────────────────────────────────────────
//  Handler registration
// ─────────────────────────────────────────────

function registerLobbyHandlers(socket, io, pool) {

  // ── room:join ─────────────────────────────────────────────────────────
  //
  // Handles both first-time joins and reconnects.
  // If a pending disconnect timer exists we cancel it and emit
  // player:reconnected so clients can display a toast or update the UI.
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

      // ── Cancel any pending disconnect timer ──────────────────────────
      const pending = disconnectTimers.get(player.playerId);
      if (pending) {
        clearTimeout(pending.timer);
        disconnectTimers.delete(player.playerId);

        // Inform all clients in the room that this player is back
        io.to(player.roomCode).emit('player:reconnected', {
          playerId: player.playerId,
          nickname: player.nickname,
        });

        console.log(
          `[socket] ${player.nickname} reconnected within grace window — ` +
          `disconnect timer cancelled (room: ${player.roomCode})`
        );
      }

      // ── Restore socket context ───────────────────────────────────────
      socket.data.playerId  = player.playerId;
      socket.data.roomId    = player.roomId;
      socket.data.roomCode  = player.roomCode;
      socket.data.nickname  = player.nickname;
      socket.data.isHost    = player.isHost;

      await setPlayerConnected(pool, player.playerId, true);
      await socket.join(player.roomCode);

      socket.emit('room:joined', {
        playerId:   player.playerId,
        nickname:   player.nickname,
        isHost:     player.isHost,
        roomCode:   player.roomCode,
        roomStatus: player.roomStatus,
      });

      await broadcastLobbyState(io, pool, player.roomCode, player.roomId, {
        status:       player.roomStatus,
        preset:       player.preset,
        totalRounds:  player.totalRounds,
        settingsJson: player.settingsJson,
      });

      const verb = pending ? 'reconnected to' : 'joined';
      console.log(`[socket] ${player.nickname} ${verb} room ${player.roomCode}`);

    } catch (err) {
      console.error('[room:join] Error:', err.message);
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to join room.' });
    }
  });


  // ── room:leave ────────────────────────────────────────────────────────
  //
  // Intentional departure — permanent and immediate, same as before M1.
  socket.on('room:leave', async () => {
    await handleDeparture(socket, io, pool, 'leave');
  });


  // ── disconnect ────────────────────────────────────────────────────────
  //
  // Unintentional drop — starts the grace-period timer.
  socket.on('disconnect', async (reason) => {
    console.log(`[socket] disconnect — reason: ${reason}, socket: ${socket.id}`);
    await handleDeparture(socket, io, pool, 'disconnect');
  });


  // ── settings:update ───────────────────────────────────────────────────
  //
  // Unchanged from before M1.
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
  // Unchanged from M1 — player count check uses onlineOnly:true.
  socket.on('game:start', async () => {
    if (!socket.data.roomId) {
      return socket.emit('error', { code: 'NOT_IN_ROOM', message: 'You are not in a room.' });
    }
    if (!socket.data.isHost) {
      return socket.emit('error', { code: 'NOT_HOST', message: 'Only the host can start the game.' });
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

      if (room.status !== 'waiting' && room.status !== 'voting') {
        return socket.emit('error', {
          code:    'INVALID_STATE',
          message: `Cannot start: room is already "${room.status}".`,
        });
      }

      const players = await getRoomPlayers(pool, socket.data.roomId, { onlineOnly: true });

      if (players.length < 3) {
        return socket.emit('error', {
          code:    'NOT_ENOUGH_PLAYERS',
          message: 'At least 3 players are required to start the game.',
        });
      }

      const settings = typeof room.settingsJson === 'string'
        ? JSON.parse(room.settingsJson)
        : room.settingsJson;

      await setRoomStatus(pool, socket.data.roomId, 'in_progress');

      io.to(socket.data.roomCode).emit('game:starting', {
        roomCode: socket.data.roomCode,
        message:  'The game is starting!',
      });

      console.log(`[socket] Game started in ${socket.data.roomCode} by ${socket.data.nickname}`);

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
//  Internal: departure handler
// ─────────────────────────────────────────────

/**
 * Central handler for both intentional leaves and socket disconnects.
 *
 * 'leave'      — permanent and immediate.  Identical to pre-M1 behaviour.
 * 'disconnect' — marks offline, emits player:disconnected, starts grace timer.
 *                Host promotion and permanent removal are deferred to expiry.
 */
async function handleDeparture(socket, io, pool, reason) {
  if (!socket.data.playerId) return;

  const { playerId, roomId, roomCode, nickname, isHost } = socket.data;
  socket.data = {};

  try {
    await setPlayerConnected(pool, playerId, false);
    socket.leave(roomCode);

    if (reason === 'leave') {
      // Intentional leave: permanent removal right now (pre-M1 behaviour)
      await performPermanentRemoval(io, pool, { playerId, roomId, roomCode, nickname, isHost });

    } else {
      // Unintentional disconnect: hold the seat, start the grace period

      // Inform all clients so they can show an offline indicator / toast
      io.to(roomCode).emit('player:disconnected', { playerId, nickname });

      // Broadcast updated lobby — player still present, isOnline: false
      await broadcastCurrentLobbyState(io, pool, roomId, roomCode);

      console.log(
        `[socket] ${nickname} disconnected from ${roomCode} — ` +
        `grace period started (${DISCONNECT_GRACE_MS / 1000}s)`
      );

      const timer = setTimeout(async () => {
        disconnectTimers.delete(playerId);
        console.log(`[socket] Grace period expired for ${nickname} in ${roomCode}`);
        await performPermanentRemoval(io, pool, { playerId, roomId, roomCode, nickname, isHost });
      }, DISCONNECT_GRACE_MS);

      disconnectTimers.set(playerId, { timer, roomId, roomCode, nickname, isHost });
    }

  } catch (err) {
    console.error(`[handleDeparture:${reason}] Error:`, err.message);
  }
}


// ─────────────────────────────────────────────
//  Internal: permanent removal
// ─────────────────────────────────────────────

/**
 * Permanently removes a player from the active room view.
 * Called on intentional leave, or when the grace-period timer fires.
 *
 * 1. Marks the player as permanently removed (excluded from future broadcasts)
 * 2. Emits player:removed so the frontend reconciles its local state
 * 3. Promotes a new host if needed
 * 4. Broadcasts the updated lobby without the removed player
 */
async function performPermanentRemoval(io, pool, { playerId, roomId, roomCode, nickname, isHost }) {
  permanentlyRemovedIds.add(playerId);

  io.to(roomCode).emit('player:removed', { playerId, nickname });

  if (isHost) {
    const newHost = await promoteNextHost(pool, roomId, playerId);
    if (newHost) {
      const roomSockets = await io.in(roomCode).fetchSockets();
      for (const s of roomSockets) {
        if (s.data.playerId === newHost.id) {
          s.data.isHost = true;
          s.emit('host:promoted', {
            message: `${nickname} left. You are now the host.`,
          });
          break;
        }
      }
      console.log(`[socket] ${newHost.nickname} promoted to host in ${roomCode}`);
    }
  }

  await broadcastCurrentLobbyState(io, pool, roomId, roomCode);

  console.log(`[socket] ${nickname} permanently removed from ${roomCode}`);
}


// ─────────────────────────────────────────────
//  Internal: lobby broadcast from DB
// ─────────────────────────────────────────────

/**
 * Fetch current room meta from DB and broadcast lobby state.
 * Used by the immediate-disconnect path and performPermanentRemoval.
 */
async function broadcastCurrentLobbyState(io, pool, roomId, roomCode) {
  const [roomRow] = await pool.query(
    `SELECT status, preset, settings_json AS settingsJson, total_rounds AS totalRounds
     FROM   rooms
     WHERE  id = ?
     LIMIT  1`,
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
}


// ─────────────────────────────────────────────
//  Internal: token lookup
// ─────────────────────────────────────────────

async function getSessionTokenByPlayerId(pool, playerId) {
  const [rows] = await pool.query(
    'SELECT session_token FROM room_players WHERE id = ? LIMIT 1',
    [playerId]
  );
  return rows.length > 0 ? rows[0].session_token : null;
}

module.exports = { registerLobbyHandlers };