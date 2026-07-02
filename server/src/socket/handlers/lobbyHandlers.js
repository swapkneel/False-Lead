// server/src/socket/handlers/lobbyHandlers.js
// ─────────────────────────────────────────────────────────────────────────────
//  Lobby Socket.IO handlers.
//
//  M1 / M1.1 / M2 history preserved — see prior versions for full changelog.
//
//  Regression fixes (post-M2 reconnect testing):
//
//  1. Host transfer now uses its OWN 30-second timer (HOST_TRANSFER_GRACE_MS),
//     completely independent of the 300-second seat-reservation timer
//     (DISCONNECT_GRACE_MS). A disconnected host who reconnects within 30s
//     keeps host status. If 30s elapse, host is transferred — but the
//     original player's SEAT remains reserved for the full 5 minutes; they
//     can still reconnect and keep playing as a non-host.
//
//  2. round:rejoin now includes a `players` array (the round's online/offline
//     roster) so Voting.jsx can render suspect cards even if lobby:updated
//     hasn't populated GameContext.players yet (e.g. a player reconnecting
//     directly into /voting without passing through /lobby).
//
//  3. Reconnect calls handleReconnectDuringDiscussion so every client's
//     ReadyPanel count is recalculated immediately against current online
//     membership, instead of waiting for the next player:ready event.
//     This fixes "ready panel shows 4 instead of 5" after a reconnect.
//
//  4. player:reconnected emission verified and given defensive error
//     handling so a downstream failure can't silently swallow the emit.
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
const {
  disconnectTimers, DISCONNECT_GRACE_MS,
  hostTransferTimers, HOST_TRANSFER_GRACE_MS,
} = require('../disconnectTimers');
const { getRoundState }                                     = require('../roundState');
const { handleReconnectDuringDiscussion, handleDisconnectDuringDiscussion } =
  require('./voteHandlers');

// ─────────────────────────────────────────────────────────────────────────────
//  Tracks players who have been permanently removed (leave or seat-timer
//  expiry). Filtered out of all broadcastLobbyState calls. Pruned in M4.
// ─────────────────────────────────────────────────────────────────────────────
const permanentlyRemovedIds = new Set();

// ─────────────────────────────────────────────
//  Broadcast helper
// ─────────────────────────────────────────────

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

      // ── Cancel any pending SEAT timer ─────────────────────────────────
      const pendingSeat = disconnectTimers.get(player.playerId);
      let wasReconnect = false;

      if (pendingSeat) {
        clearTimeout(pendingSeat.timer);
        disconnectTimers.delete(player.playerId);
        wasReconnect = true;
      }

      // ── Cancel any pending HOST TRANSFER timer (independent of seat) ──
      // A player can have a host-transfer timer running without a seat
      // timer in edge cases (shouldn't normally happen since both start
      // together on disconnect, but we guard independently for safety).
      const pendingHostTransfer = hostTransferTimers.get(player.playerId);
      if (pendingHostTransfer) {
        clearTimeout(pendingHostTransfer.timer);
        hostTransferTimers.delete(player.playerId);
        console.log(
          `[socket] ${player.nickname} reconnected before host-transfer timer ` +
          `expired — host status retained (room: ${player.roomCode})`
        );
      }

      // ── Emit reconnect toast to everyone else in the room ──────────────
      // Defensive try/catch so a failure here can never silently abort the
      // rest of room:join (which would also break round:rejoin).
      if (wasReconnect) {
        try {
          io.to(player.roomCode).emit('player:reconnected', {
            playerId: player.playerId,
            nickname: player.nickname,
          });
          console.log(
            `[socket] player:reconnected emitted for ${player.nickname} ` +
            `to room ${player.roomCode}`
          );
        } catch (emitErr) {
          console.error('[room:join] Failed to emit player:reconnected:', emitErr.message);
        }
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

      // ── Recalculate ready count against current online membership ─────
      // Fixes "ready panel shows stale count" after a reconnect — this
      // runs regardless of phase; the helper no-ops if not in discussion.
      if (wasReconnect && player.roomStatus === 'in_progress') {
        await handleReconnectDuringDiscussion(io, player.roomCode);
      }

      // ── Emit round:rejoin if game is in progress ──────────────────────
      if (player.roomStatus === 'in_progress') {
        await emitRejoin(socket, pool, player);
      }

      const verb = wasReconnect ? 'reconnected to' : 'joined';
      console.log(`[socket] ${player.nickname} ${verb} room ${player.roomCode}`);

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
//  round:rejoin payload builder
// ─────────────────────────────────────────────

/**
 * Builds and emits the round:rejoin payload to a single reconnecting socket.
 *
 * Regression fix: payload now includes `players` — the round's roster with
 * isOnline flags — so the client can render the suspect grid immediately
 * even if lobby:updated hasn't populated GameContext.players yet (e.g. a
 * player reconnecting directly into /voting without passing through /lobby
 * first).
 */
async function emitRejoin(socket, pool, player) {
  try {
    const [roundRows] = await pool.query(
      `SELECT r.id          AS roundId,
              r.round_type  AS roundType,
              r.status      AS roundStatus,
              r.word,
              r.alternate_word AS alternateWord,
              rm.current_round AS roundNumber,
              rm.total_rounds  AS totalRounds,
              rm.settings_json AS settingsJson
       FROM   rounds r
       JOIN   rooms  rm ON rm.id = r.room_id
       WHERE  r.room_id = ?
       ORDER  BY r.id DESC
       LIMIT  1`,
      [player.roomId]
    );

    if (roundRows.length === 0) {
      socket.emit('round:rejoin', { phase: 'waiting' });
      return;
    }

    const round = roundRows[0];

    const [rpRows] = await pool.query(
      `SELECT rp.role,
              rp.received_info AS receivedInfo,
              rp.clue_order    AS clueOrder
       FROM   round_players rp
       WHERE  rp.round_id       = ?
       AND    rp.room_player_id = ?
       LIMIT  1`,
      [round.roundId, player.playerId]
    );

    const myRoundPlayer = rpRows[0] || null;

    const [clueRows] = await pool.query(
      `SELECT rp.room_player_id AS playerId,
              rmp.nickname,
              rp.clue_order     AS \`order\`
       FROM   round_players rp
       JOIN   room_players  rmp ON rmp.id = rp.room_player_id
       WHERE  rp.round_id = ?
       ORDER  BY rp.clue_order ASC`,
      [round.roundId]
    );

    // ── M1.2 fix: full player roster for this round, with isOnline ──────
    // Used by the client as a fallback source for the suspect grid when
    // GameContext.players hasn't been populated via lobby:updated yet.
    const [roundPlayerRows] = await pool.query(
      `SELECT rmp.id           AS id,
              rmp.nickname,
              rmp.is_host       AS isHost,
              rmp.is_connected  AS isConnected,
              rmp.score
       FROM   round_players rp
       JOIN   room_players  rmp ON rmp.id = rp.room_player_id
       WHERE  rp.round_id = ?`,
      [round.roundId]
    );

    const roundPlayers = roundPlayerRows.map(p => ({
      id:       p.id,
      nickname: p.nickname,
      isHost:   p.isHost === 1,
      isOnline: p.isConnected === 1,
      score:    p.score,
    }));

    const settings = typeof round.settingsJson === 'string'
      ? JSON.parse(round.settingsJson)
      : (round.settingsJson || {});

    const imposterCount = settings.imposterCount ?? 1;

    const liveState = getRoundState(player.roomCode);
    let phase;

    if (round.roundStatus === 'results' || round.roundStatus === 'finished') {
      phase = 'results';
    } else if (liveState && liveState.phase === 'voting') {
      phase = 'voting';
    } else if (liveState && liveState.phase === 'discussion') {
      phase = 'discussion';
    } else {
      phase = round.roundStatus === 'active' ? 'discussion' : 'waiting';
    }

    const isReady = liveState
      ? liveState.readyPlayers.has(player.playerId)
      : false;

    const hasVoted = liveState
      ? liveState.votes.has(player.playerId)
      : false;

    const secondsRemaining = null;

    const payload = {
      phase,

      roundId:      round.roundId,
      roundNumber:  round.roundNumber,
      totalRounds:  round.totalRounds,
      roundType:    round.roundType,
      imposterCount,

      clueOrder: clueRows,

      // M1.2: round roster fallback for suspect grid / player lists
      players: roundPlayers,

      role:         myRoundPlayer?.role         ?? null,
      receivedInfo: myRoundPlayer?.receivedInfo ?? null,
      myClueOrder:  myRoundPlayer?.clueOrder    ?? null,

      isReady,
      hasVoted,
      secondsRemaining,

      readyCount:   liveState ? liveState.readyPlayers.size : 0,
      totalPlayers: clueRows.length,
    };

    socket.emit('round:rejoin', payload);

    console.log(
      `[socket] round:rejoin → ${player.nickname} in ${player.roomCode} ` +
      `(phase: ${phase}, round: ${round.roundNumber}, roster: ${roundPlayers.length})`
    );

  } catch (err) {
    console.error('[emitRejoin] Error:', err.message);
  }
}


// ─────────────────────────────────────────────
//  Internal: departure handler
// ─────────────────────────────────────────────

async function handleDeparture(socket, io, pool, reason) {
  if (!socket.data.playerId) return;

  const { playerId, roomId, roomCode, nickname, isHost } = socket.data;
  socket.data = {};

  try {
    await setPlayerConnected(pool, playerId, false);
    socket.leave(roomCode);

    if (reason === 'leave') {
      // Intentional leave: permanent and immediate, host transferred now.
      // No timers involved — both grace windows are irrelevant here.
      await performPermanentRemoval(io, pool, { playerId, roomId, roomCode, nickname, isHost });
      return;
    }

    // ── Unintentional disconnect ─────────────────────────────────────────
    io.to(roomCode).emit('player:disconnected', { playerId, nickname });
    await broadcastCurrentLobbyState(io, pool, roomId, roomCode);

    // If this player is mid-discussion, auto-ready them so they don't
    // block everyone else.
    await handleDisconnectDuringDiscussion(io, pool, roomCode, playerId, nickname);

    console.log(
      `[socket] ${nickname} disconnected from ${roomCode} — ` +
      `seat reserved for ${DISCONNECT_GRACE_MS / 1000}s`
    );

    // ── SEAT timer (5 min) — independent of host status ─────────────────
    const seatTimer = setTimeout(async () => {
      disconnectTimers.delete(playerId);
      console.log(`[socket] Seat grace period expired for ${nickname} in ${roomCode}`);
      await performPermanentRemoval(io, pool, { playerId, roomId, roomCode, nickname, isHost });
    }, DISCONNECT_GRACE_MS);

    disconnectTimers.set(playerId, { timer: seatTimer, roomId, roomCode, nickname, isHost });

    // ── HOST TRANSFER timer (30s) — ONLY if this player was host ────────
    // Independent of the seat timer. If it fires, host moves to another
    // connected player, but the original player's seat remains reserved
    // separately for the full DISCONNECT_GRACE_MS.
    if (isHost) {
      console.log(
        `[socket] ${nickname} was host — starting ${HOST_TRANSFER_GRACE_MS / 1000}s ` +
        `host-transfer timer in ${roomCode}`
      );

      const hostTimer = setTimeout(async () => {
        hostTransferTimers.delete(playerId);

        // Only transfer if the player hasn't reconnected (i.e. their seat
        // timer is still pending — if they reconnected, seat timer would
        // already be cleared).
        if (!disconnectTimers.has(playerId)) {
          // Already reconnected via the seat path; nothing to do.
          return;
        }

        console.log(`[socket] Host-transfer timer expired for ${nickname} in ${roomCode}`);

        const newHost = await promoteNextHost(pool, roomId, playerId);
        if (newHost) {
          const roomSockets = await io.in(roomCode).fetchSockets();
          for (const s of roomSockets) {
            if (s.data.playerId === newHost.id) {
              s.data.isHost = true;
              s.emit('host:promoted', {
                message: `${nickname} disconnected. You are now the host.`,
              });
              break;
            }
          }
          console.log(`[socket] ${newHost.nickname} promoted to host in ${roomCode} (host-transfer timer)`);

          // Update socket.data.isHost = false for the original host's
          // pending seat entry isn't needed — when they reconnect, their
          // fresh DB read via getPlayerByToken will correctly report
          // isHost: false since promoteNextHost already updated the DB.

          await broadcastCurrentLobbyState(io, pool, roomId, roomCode);
        }
      }, HOST_TRANSFER_GRACE_MS);

      hostTransferTimers.set(playerId, { timer: hostTimer, roomId, roomCode, nickname });
    }

  } catch (err) {
    console.error(`[handleDeparture:${reason}] Error:`, err.message);
  }
}


// ─────────────────────────────────────────────
//  Internal: permanent removal
// ─────────────────────────────────────────────

async function performPermanentRemoval(io, pool, { playerId, roomId, roomCode, nickname, isHost }) {
  permanentlyRemovedIds.add(playerId);

  // Clean up any still-pending host-transfer timer for this player
  // (e.g. seat timer fired before the 30s host-transfer window did,
  // which shouldn't normally happen since 30s < 5min, but guard anyway).
  const pendingHostTransfer = hostTransferTimers.get(playerId);
  if (pendingHostTransfer) {
    clearTimeout(pendingHostTransfer.timer);
    hostTransferTimers.delete(playerId);
  }

  io.to(roomCode).emit('player:removed', { playerId, nickname });

  // If host status was already transferred via the 30s timer, isHost here
  // will be stale (still true from socket.data snapshot at disconnect time)
  // but promoteNextHost is safe to call again — it will simply find no
  // eligible change is needed if a host already exists, or no-op gracefully
  // if departingPlayerId no longer matches the current host. We guard by
  // checking the DB directly to avoid a duplicate host:promoted toast.
  if (isHost) {
    const [hostCheck] = await pool.query(
      'SELECT is_host FROM room_players WHERE id = ? LIMIT 1',
      [playerId]
    );
    const stillHost = hostCheck.length > 0 && hostCheck[0].is_host === 1;

    if (stillHost) {
      // Host transfer timer never fired (player removed before 30s, e.g.
      // very short seat timer in testing) — transfer now as a fallback.
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
        console.log(`[socket] ${newHost.nickname} promoted to host in ${roomCode} (permanent removal fallback)`);
      }
    }
  }

  await broadcastCurrentLobbyState(io, pool, roomId, roomCode);
  console.log(`[socket] ${nickname} permanently removed from ${roomCode}`);
}


// ─────────────────────────────────────────────
//  Internal: lobby broadcast from DB
// ─────────────────────────────────────────────

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