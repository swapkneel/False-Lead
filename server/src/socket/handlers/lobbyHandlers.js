// server/src/socket/handlers/lobbyHandlers.js
// ─────────────────────────────────────────────────────────────────────────────
//  Lobby Socket.IO handlers.
//
//  Covers everything that happens before the game starts:
//    room:join          — authenticate a socket into a room
//    room:leave         — voluntary departure
//    disconnect         — browser closed / network lost
//    settings:update    — host changes preset or game settings
//    game:start         — host starts the game
//
//  Every handler follows the same pattern:
//    1. Validate the incoming payload
//    2. Verify the player's session token against the DB
//    3. Perform the state change (DB write)
//    4. Broadcast the updated lobby state to the whole room
//
//  The broadcast helper (broadcastLobbyState) is the single source of truth
//  for what the frontend receives — defined once, called everywhere.
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

// ─────────────────────────────────────────────
//  Broadcast helper
// ─────────────────────────────────────────────

/**
 * Fetches the current lobby state from the DB and broadcasts it to
 * every connected socket in the room.
 *
 * Using a DB read (rather than an in-memory snapshot) as the broadcast
 * source means the client always gets the authoritative state, even if
 * two events fire in quick succession.
 *
 * Emits: lobby:updated
 * Payload:
 * {
 *   roomCode:    "AB12CD",
 *   status:      "waiting",
 *   preset:      "classic",
 *   totalRounds: 3,
 *   settings:    { imposter_count, category_voting, special_rounds },
 *   playerCount: 2,
 *   players: [
 *     { id, nickname, isHost, score }
 *   ]
 * }
 *
 * @param {import('socket.io').Server} io
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} roomCode     — Socket.IO room name
 * @param {number} roomId       — DB primary key
 * @param {object} roomMeta     — { preset, status, totalRounds, settingsJson }
 */
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

/**
 * Registers all lobby-related socket events on a single socket.
 * Called once per connection inside the Socket.IO 'connection' listener.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {import('mysql2/promise').Pool} pool
 */
function registerLobbyHandlers(socket, io, pool) {

  // ── room:join ──────────────────────────────
  // The client emits this immediately after the WebSocket connection opens,
  // sending the sessionToken they received from POST /api/rooms/join.
  // This is the authentication step — if the token is invalid, the socket
  // gets an error and is not admitted to any room.
  //
  // Emits back to sender:   room:joined  (confirmation + their own player info)
  // Broadcasts to room:     lobby:updated
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

      // Prevent joining a finished room via socket
      if (player.roomStatus === 'finished') {
        return socket.emit('error', {
          code:    'ROOM_FINISHED',
          message: 'This room has finished.',
        });
      }

      // Attach player context to the socket for use in subsequent events.
      // Avoids a DB lookup on every single event.
      socket.data.playerId  = player.playerId;
      socket.data.roomId    = player.roomId;
      socket.data.roomCode  = player.roomCode;
      socket.data.nickname  = player.nickname;
      socket.data.isHost    = player.isHost;

      // Mark player as connected (handles the reconnect case)
      await setPlayerConnected(pool, player.playerId, true);

      // Join the Socket.IO room — from here all broadcasts use roomCode as the room name
      await socket.join(player.roomCode);

      // Confirm to the joining socket
      socket.emit('room:joined', {
        playerId:    player.playerId,
        nickname:    player.nickname,
        isHost:      player.isHost,
        roomCode:    player.roomCode,
        roomStatus:  player.roomStatus,
      });

      // Tell everyone (including the new player) the updated lobby state
      await broadcastLobbyState(io, pool, player.roomCode, player.roomId, {
        status:      player.roomStatus,
        preset:      player.preset,
        totalRounds: player.totalRounds,
        settingsJson: player.settingsJson,
      });

      console.log(`[socket] ${player.nickname} joined room ${player.roomCode}`);

    } catch (err) {
      console.error('[room:join] Error:', err.message);
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to join room.' });
    }
  });


  // ── room:leave ─────────────────────────────
  // Voluntary departure — player clicks "Leave Room".
  // Distinct from disconnect (which is involuntary).
  // In both cases the same cleanup runs, but here we can be
  // certain the player intended to leave.
  //
  // Broadcasts to room: lobby:updated
  socket.on('room:leave', async () => {
    await handleDeparture(socket, io, pool, 'leave');
  });


  // ── disconnect ─────────────────────────────
  // Fires automatically when the WebSocket closes (browser tab closed,
  // network dropped, mobile browser backgrounded, etc.).
  // We mark the player as disconnected rather than deleting them so they
  // can reconnect within the same session.
  //
  // Broadcasts to room: lobby:updated
  socket.on('disconnect', async (reason) => {
    console.log(`[socket] disconnect — reason: ${reason}, socket: ${socket.id}`);
    await handleDeparture(socket, io, pool, 'disconnect');
  });


  // ── settings:update ────────────────────────
  // Host-only. Updates preset and/or settings_json in the DB then
  // broadcasts the new lobby state so all clients re-render immediately.
  //
  // Payload:
  // {
  //   preset?:   "party",
  //   settings?: { imposter_count, category_voting, special_rounds }
  // }
  //
  // Broadcasts to room: lobby:updated
  socket.on('settings:update', async ({ preset, settings } = {}) => {
    if (!socket.data.roomId) {
      return socket.emit('error', {
        code:    'NOT_IN_ROOM',
        message: 'You are not in a room.',
      });
    }

    if (!socket.data.isHost) {
      return socket.emit('error', {
        code:    'NOT_HOST',
        message: 'Only the host can change settings.',
      });
    }

    try {
      await updateRoomSettings(pool, socket.data.roomId, { preset, settings });

      // Re-fetch the fresh room state so the broadcast is accurate
      const player = await getPlayerByToken(pool,
        // We need the session token — re-query from DB via playerId
        // (simpler than caching the token on socket.data)
        await getSessionTokenByPlayerId(pool, socket.data.playerId)
      );

      if (!player) return; // room disappeared between events

      await broadcastLobbyState(io, pool, socket.data.roomCode, socket.data.roomId, {
        status:      player.roomStatus,
        preset:      player.preset,
        totalRounds: player.totalRounds,
        settingsJson: player.settingsJson,
      });

      console.log(`[socket] ${socket.data.nickname} updated settings in ${socket.data.roomCode}`);

    } catch (err) {
      console.error('[settings:update] Error:', err.message);
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to update settings.' });
    }
  });


  // ── game:start ─────────────────────────────
  // Host-only. Transitions the room from 'waiting' to 'voting'
  // (the category voting phase). Minimum 2 players required.
  //
  // Broadcasts to room: game:starting  (all clients navigate to the game view)
  socket.on('game:start', async () => {
    if (!socket.data.roomId) {
      return socket.emit('error', {
        code:    'NOT_IN_ROOM',
        message: 'You are not in a room.',
      });
    }

    if (!socket.data.isHost) {
      return socket.emit('error', {
        code:    'NOT_HOST',
        message: 'Only the host can start the game.',
      });
    }

    try {
      const players = await getConnectedPlayers(pool, socket.data.roomId);

      if (players.length < 2) {
        return socket.emit('error', {
          code:    'NOT_ENOUGH_PLAYERS',
          message: 'At least 2 players are needed to start.',
        });
      }

      // Advance room to category voting phase
      await setRoomStatus(pool, socket.data.roomId, 'voting');

      // Broadcast to every client in the room — they all navigate away from lobby
      io.to(socket.data.roomCode).emit('game:starting', {
        roomCode: socket.data.roomCode,
        message:  'The host has started the game. Get ready!',
      });

      console.log(`[socket] Game started in room ${socket.data.roomCode} by ${socket.data.nickname}`);

    } catch (err) {
      console.error('[game:start] Error:', err.message);
      socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to start game.' });
    }
  });

} // end registerLobbyHandlers


// ─────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────

/**
 * Shared logic for room:leave and disconnect.
 * Marks the player as disconnected, handles host promotion
 * if needed, then broadcasts the updated lobby.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {import('mysql2/promise').Pool} pool
 * @param {'leave'|'disconnect'} reason
 */
async function handleDeparture(socket, io, pool, reason) {
  // socket.data is empty if the player never completed room:join
  if (!socket.data.playerId) return;

  const { playerId, roomId, roomCode, nickname, isHost } = socket.data;

  try {
    await setPlayerConnected(pool, playerId, false);

    let newHost = null;
    if (isHost) {
      newHost = await promoteNextHost(pool, roomId, playerId);
      if (newHost) {
        // Tell the newly promoted player they are now host so their UI updates
        // We need their socket — find it by iterating sockets in the room
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

    // Leave the Socket.IO room (only meaningful for voluntary leave;
    // disconnect cleans this up automatically, but calling it is harmless)
    socket.leave(roomCode);

    // Clear socket context so stale data can't be used if the socket somehow
    // receives another event before being fully cleaned up
    socket.data = {};

    console.log(`[socket] ${nickname} ${reason === 'leave' ? 'left' : 'disconnected from'} room ${roomCode}`);

    // If no players remain, no broadcast is needed — room is effectively empty
    const remaining = await getConnectedPlayers(pool, roomId);
    if (remaining.length === 0) return;

    // Re-fetch room meta for the broadcast
    // Use the new host's data if we just promoted, otherwise any remaining player
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

/**
 * Fetch a player's session token by their DB id.
 * Used only in settings:update so we can re-query the full player object.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} playerId
 * @returns {Promise<string|null>}
 */
async function getSessionTokenByPlayerId(pool, playerId) {
  const [rows] = await pool.query(
    'SELECT session_token FROM room_players WHERE id = ? LIMIT 1',
    [playerId]
  );
  return rows.length > 0 ? rows[0].session_token : null;
}

module.exports = { registerLobbyHandlers };
