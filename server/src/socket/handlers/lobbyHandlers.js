// server/src/socket/handlers/lobbyHandlers.js
// ─────────────────────────────────────────────────────────────────────────────
//  Lobby Socket.IO handlers.
//
//  M2.5/M3 changes (emitRejoin only):
//    1. imposterCount is now read from live roundState.imposterCount when
//       the round is still active. Falls back to settings_json parsing only
//       when roundState is gone (results phase / between rounds). This fixes
//       a latent bug where settings changed between rounds could cause
//       emitRejoin to report the wrong imposterCount for a historical round.
//
//    2. The round roster in round:rejoin is now built from round_players JOIN
//       room_players — the same source as the round:created roster — rather
//       than a separate getRoomPlayers room-level query. This guarantees that
//       the rejoin roster is identical in membership and shape to the roster
//       every other client received at round:created, closing the dual-source
//       divergence that caused vote-target inconsistency.
//
//    3. Roster shape is unified: { id, nickname, isHost, isOnline, score }
//       identical to round:created. Client handles both events the same way.
//
//  All other behaviour (departure, timers, lobby broadcasts, game:start,
//  settings:update) is unchanged from the previous accepted version.
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
  disconnectTimers,    DISCONNECT_GRACE_MS,
  hostTransferTimers,  HOST_TRANSFER_GRACE_MS,
} = require('../disconnectTimers');
const { getRoundState } = require('../roundState');
const {
  handleReconnectDuringDiscussion,
  handleDisconnectDuringDiscussion,
} = require('./voteHandlers');

// ─────────────────────────────────────────────────────────────────────────────
//  Permanently removed player IDs — excluded from lobby broadcasts.
//  Pruned in M4.
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

      // ── DIAGNOSTIC LOGGING — remove after reconnect investigation ──────
      console.log('[room:join:diag] sessionToken (last 8):', sessionToken.slice(-8));
      console.log('[room:join:diag] player found:', player
        ? `id=${player.playerId} nickname=${player.nickname} roomCode=${player.roomCode}`
        : 'NULL — token not in DB'
      );
      if (player) {
        const hasSeatTimer = disconnectTimers.has(player.playerId);
        console.log('[room:join:diag] disconnectTimers has entry for playerId', player.playerId, ':', hasSeatTimer);
        console.log('[room:join:diag] all seat timer keys:', [...disconnectTimers.keys()]);
      }
      // ── END DIAGNOSTIC LOGGING ─────────────────────────────────────────

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

      // ── Cancel pending seat timer ──────────────────────────────────────
      const pendingSeat = disconnectTimers.get(player.playerId);
      let wasReconnect  = false;

      if (pendingSeat) {
        clearTimeout(pendingSeat.timer);
        disconnectTimers.delete(player.playerId);
        wasReconnect = true;
      }

      console.log('[room:join:diag] wasReconnect:', wasReconnect, '| nickname:', player?.nickname);

      // ── Cancel pending host-transfer timer ────────────────────────────
      const pendingHostTransfer = hostTransferTimers.get(player.playerId);
      if (pendingHostTransfer) {
        clearTimeout(pendingHostTransfer.timer);
        hostTransferTimers.delete(player.playerId);
        console.log(
          `[socket] ${player.nickname} reconnected before host-transfer ` +
          `timer expired — host status retained (room: ${player.roomCode})`
        );
      }

      // ── Emit reconnect toast to room ──────────────────────────────────
      if (wasReconnect) {
        try {
          io.to(player.roomCode).emit('player:reconnected', {
            playerId: player.playerId,
            nickname: player.nickname,
          });
        } catch (emitErr) {
          console.error('[room:join] Failed to emit player:reconnected:', emitErr.message);
        }
      }

      // ── Restore socket context ─────────────────────────────────────────
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

      // ── Recalculate ready count after reconnect ────────────────────────
      if (wasReconnect && player.roomStatus === 'in_progress') {
        await handleReconnectDuringDiscussion(io, player.roomCode);
      }

      // ── Emit round:rejoin for in-progress rooms ────────────────────────
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
         FROM   rooms WHERE id = ? LIMIT 1`,
        [socket.data.roomId]
      );

      if (!roomRows.length) {
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
        ? JSON.parse(room.settingsJson) : room.settingsJson;

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
//  M2.5: emitRejoin — unified roster, authoritative imposterCount
// ─────────────────────────────────────────────

/**
 * Emits round:rejoin to a single reconnecting socket.
 *
 * Roster source: round_players JOIN room_players for this round — the same
 * table that round:created's assignments are built from. This guarantees
 * the rejoin roster is identical in membership to what every other client
 * received, eliminating the previous dual-source divergence.
 *
 * imposterCount source: live roundState.imposterCount when the round is
 * still active. Falls back to settings_json parsing only when roundState
 * is gone (results phase). This prevents a settings-change between rounds
 * from contaminating the imposterCount of a historical round.
 *
 * Payload shape is identical to round:created so the client handles both
 * events with the same handler.
 */
async function emitRejoin(socket, pool, player) {
  try {
    // ── Current round from DB ──────────────────────────────────────────
    const [roundRows] = await pool.query(
      `SELECT r.id          AS roundId,
              r.round_type  AS roundType,
              r.status      AS roundStatus,
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

    if (!roundRows.length) {
      socket.emit('round:rejoin', { phase: 'waiting' });
      return;
    }

    const round = roundRows[0];

    // ── This player's private role row ────────────────────────────────
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

    // ── Clue order (for WitnessOrder panel) ───────────────────────────
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

    // ── Unified round roster — identical source to round:created ──────
    // Built from round_players (who is in THIS round) not getRoomPlayers
    // (who is in the room). These diverge when players join/leave between
    // rounds. Using round_players guarantees membership consistency.
    const [rosterRows] = await pool.query(
      `SELECT rmp.id            AS id,
              rmp.nickname,
              rmp.is_host       AS isHost,
              rmp.is_connected  AS isConnected,
              rmp.score
       FROM   round_players rp
       JOIN   room_players  rmp ON rmp.id = rp.room_player_id
       WHERE  rp.round_id = ?`,
      [round.roundId]
    );

    const players = rosterRows.map(p => ({
      id:       p.id,
      nickname: p.nickname,
      isHost:   p.isHost === 1,
      isOnline: p.isConnected === 1,
      score:    p.score,
    }));

    // ── imposterCount: live roundState first, settings fallback ───────
    const liveState = getRoundState(player.roomCode);
    let imposterCount;

    if (liveState) {
      // Round is still active — use the authoritative in-memory value
      // set at round-creation time by resolveImposterCount.
      imposterCount = liveState.imposterCount;
    } else {
      // Round is in results/finished — roundState was cleared.
      // Fall back to settings_json parsing (acceptable here since we're
      // only showing result information, not driving vote logic).
      const settings = typeof round.settingsJson === 'string'
        ? JSON.parse(round.settingsJson)
        : (round.settingsJson || {});
      imposterCount = settings.imposterCount ?? settings.imposter_count ?? 1;
    }

    // ── Phase ─────────────────────────────────────────────────────────
    let phase;
    if (round.roundStatus === 'results' || round.roundStatus === 'finished') {
      phase = 'results';
    } else if (liveState?.phase === 'voting') {
      phase = 'voting';
    } else if (liveState?.phase === 'discussion') {
      phase = 'discussion';
    } else {
      phase = round.roundStatus === 'active' ? 'discussion' : 'waiting';
    }

    const isReady  = liveState ? liveState.readyPlayers.has(player.playerId) : false;
    const hasVoted = liveState ? liveState.votes.has(player.playerId)        : false;

    // ── Emit ──────────────────────────────────────────────────────────
    // Payload shape is identical to round:created so the client can use
    // the same handler for both events.
    socket.emit('round:rejoin', {
      phase,

      // Round identity (matches round:created fields)
      roundId:      round.roundId,
      roundNumber:  round.roundNumber,
      totalRounds:  round.totalRounds,
      roundType:    round.roundType,
      imposterCount,
      clueOrder:    clueRows,
      players,                          // unified roster

      // Private fields (only meaningful to this player)
      role:         myRoundPlayer?.role         ?? null,
      receivedInfo: myRoundPlayer?.receivedInfo ?? null,
      myClueOrder:  myRoundPlayer?.clueOrder    ?? null,

      // Live state restoration
      isReady,
      hasVoted,
      secondsRemaining: null,           // client syncs on next vote:timer tick
      readyCount:   liveState ? liveState.readyPlayers.size : 0,
      totalPlayers: clueRows.length,
    });

    console.log(
      `[socket] round:rejoin → ${player.nickname} in ${player.roomCode} ` +
      `(phase: ${phase}, round: ${round.roundNumber}, ` +
      `roster: ${players.length}, imposterCount: ${imposterCount})`
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
      await performPermanentRemoval(io, pool, { playerId, roomId, roomCode, nickname, isHost });
      return;
    }

    // ── Unintentional disconnect ──────────────────────────────────────
    io.to(roomCode).emit('player:disconnected', { playerId, nickname });
    await broadcastCurrentLobbyState(io, pool, roomId, roomCode);

    // ── DIAGNOSTIC: seat timer registration ──────────────────────────
    console.log(`[depart:diag] ${nickname} (id=${playerId}) — about to register seat timer`);

    // ── Seat timer (5 min) ────────────────────────────────────────────
    // Registered BEFORE the discussion hook so a throw in that hook
    // cannot prevent seat reservation.
    const seatTimer = setTimeout(async () => {
      disconnectTimers.delete(playerId);

      // Guard: verify the player still belongs to this specific roomId before
      // acting. Prevents stale player:removed toasts if the room finished,
      // was abandoned, or the room code was reused by a new room before the
      // timer expired.
      try {
        const [memberCheck] = await pool.query(
          `SELECT rp.id
           FROM   room_players rp
           JOIN   rooms r ON r.id = rp.room_id
           WHERE  rp.id      = ?
           AND    rp.room_id = ?
           AND    r.status  != 'finished'
           LIMIT  1`,
          [playerId, roomId]
        );
        if (!memberCheck.length) {
          console.log(
            `[socket] Seat timer fired for ${nickname} but room ${roomCode} ` +
            `is finished or player has moved on — skipping removal`
          );
          return;
        }
      } catch (guardErr) {
        console.error('[socket] Seat timer guard query failed:', guardErr.message);
        return; // Fail safe: don't emit to a room we cannot verify
      }

      console.log(`[socket] Seat grace expired for ${nickname} in ${roomCode}`);
      await performPermanentRemoval(io, pool, { playerId, roomId, roomCode, nickname, isHost });
    }, DISCONNECT_GRACE_MS);

    disconnectTimers.set(playerId, { timer: seatTimer, roomId, roomCode, nickname, isHost });
    console.log(`[depart:diag] seat timer registered for ${nickname} (id=${playerId}). Timer keys now:`, [...disconnectTimers.keys()]);

    // Auto-ready the player if mid-discussion so nobody is blocked.
    // Wrapped in its own try/catch — a throw here must not prevent the
    // seat reservation above from taking effect.
    try {
      await handleDisconnectDuringDiscussion(io, pool, roomCode, playerId, nickname);
    } catch (hookErr) {
      console.error(`[depart:diag] handleDisconnectDuringDiscussion threw for ${nickname}:`, hookErr.message, hookErr.stack);
    }

    console.log(
      `[socket] ${nickname} disconnected from ${roomCode} — ` +
      `seat reserved for ${DISCONNECT_GRACE_MS / 1000}s`
    );

    // ── Host-transfer timer (30s) — only for host ─────────────────────
    if (isHost) {
      console.log(
        `[socket] ${nickname} was host — starting ${HOST_TRANSFER_GRACE_MS / 1000}s ` +
        `host-transfer timer in ${roomCode}`
      );

      const hostTimer = setTimeout(async () => {
        hostTransferTimers.delete(playerId);

        // Only act if the player hasn't reconnected
        if (!disconnectTimers.has(playerId)) return;

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

  // Clean up any still-pending host-transfer timer
  const pendingHostTransfer = hostTransferTimers.get(playerId);
  if (pendingHostTransfer) {
    clearTimeout(pendingHostTransfer.timer);
    hostTransferTimers.delete(playerId);
  }

  // Second-line guard: check room is still active before broadcasting.
  // The seat timer callback has its own guard, but performPermanentRemoval
  // is also called directly on room:leave, so we verify here too.
  // If the room is finished, there is nobody valid to receive the event.
  const [roomStatusCheck] = await pool.query(
    'SELECT status FROM rooms WHERE id = ? LIMIT 1',
    [roomId]
  );
  if (!roomStatusCheck.length || roomStatusCheck[0].status === 'finished') {
    console.log(
      `[socket] Skipping player:removed for ${nickname} — ` +
      `room ${roomCode} is finished or no longer exists`
    );
    return;
  }

  io.to(roomCode).emit('player:removed', { playerId, nickname });

  if (isHost) {
    const [hostCheck] = await pool.query(
      'SELECT is_host FROM room_players WHERE id = ? LIMIT 1',
      [playerId]
    );
    const stillHost = hostCheck.length > 0 && hostCheck[0].is_host === 1;

    if (stillHost) {
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
        console.log(`[socket] ${newHost.nickname} promoted in ${roomCode} (permanent removal fallback)`);
      }
    }
  }

  await broadcastCurrentLobbyState(io, pool, roomId, roomCode);
  console.log(`[socket] ${nickname} permanently removed from ${roomCode}`);
}


// ─────────────────────────────────────────────
//  Internal: lobby broadcast helpers
// ─────────────────────────────────────────────

async function broadcastCurrentLobbyState(io, pool, roomId, roomCode) {
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
}

async function getSessionTokenByPlayerId(pool, playerId) {
  const [rows] = await pool.query(
    'SELECT session_token FROM room_players WHERE id = ? LIMIT 1',
    [playerId]
  );
  return rows.length > 0 ? rows[0].session_token : null;
}

module.exports = { registerLobbyHandlers };