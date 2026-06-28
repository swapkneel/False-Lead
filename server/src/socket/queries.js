// server/src/socket/queries.js
// ─────────────────────────────────────────────────────────────────────────────
//  Shared DB query helpers for socket handlers.
//
//  Keeping queries here rather than inline in handlers means:
//   - Each handler file stays focused on event logic
//   - Queries are easy to find, read, and update in one place
//   - Nothing is duplicated between handlers
//
//  All functions receive the pool as a parameter so they are
//  easy to unit-test with a mock pool later.
//
//  M1 change — getConnectedPlayers → getRoomPlayers:
//    The old function filtered to is_connected = 1 only.  The new one returns
//    ALL players in a room, each with an `isOnline` boolean, so the lobby
//    broadcast can show disconnected seats with an offline indicator.
//
//    Pass `{ onlineOnly: true }` to replicate the old behaviour.  The two
//    places that needed the old filter (game:start player-count check and
//    promoteNextHost) pass that option explicitly, so their behaviour is
//    completely unchanged.
//
//    The old export name is re-exported as an alias so any file outside
//    this module that still imports getConnectedPlayers continues to work.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

/**
 * Look up a player by session token.
 * Returns the full row including room_id, nickname, is_host, and the
 * room's code and status — everything a handler needs in one query.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} sessionToken
 * @returns {Promise<object|null>}
 */
async function getPlayerByToken(pool, sessionToken) {
  const [rows] = await pool.query(
    `SELECT
       rp.id            AS playerId,
       rp.room_id       AS roomId,
       rp.nickname,
       rp.is_host       AS isHost,
       rp.is_connected  AS isConnected,
       rp.score,
       r.room_code      AS roomCode,
       r.status         AS roomStatus,
       r.preset,
       r.settings_json  AS settingsJson,
       r.total_rounds   AS totalRounds,
       r.host_session_id AS hostSessionId
     FROM   room_players rp
     JOIN   rooms r ON r.id = rp.room_id
     WHERE  rp.session_token = ?
     LIMIT  1`,
    [sessionToken]
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    ...row,
    isHost:       row.isHost === 1,
    isConnected:  row.isConnected === 1,
    settingsJson: typeof row.settingsJson === 'string'
      ? JSON.parse(row.settingsJson)
      : row.settingsJson,
  };
}

/**
 * Fetch the player list for a room.
 *
 * By default returns ALL players (connected and disconnected) so the lobby
 * broadcast can show offline seats with an indicator during the reconnect
 * grace window.  Each row carries `isOnline` so callers can filter or render
 * as needed without a second query.
 *
 * Pass `{ onlineOnly: true }` to restrict to connected players — used by the
 * game:start player-count check and host-promotion logic, preserving their
 * original behaviour exactly.
 *
 * session_token is intentionally excluded from all rows.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} roomId
 * @param {{ onlineOnly?: boolean }} [opts]
 * @returns {Promise<Array<{ id, nickname, isHost, isOnline, score }>>}
 */
async function getRoomPlayers(pool, roomId, { onlineOnly = false } = {}) {
  const [rows] = await pool.query(
    `SELECT id,
            nickname,
            is_host       AS isHost,
            is_connected  AS isConnected,
            score
     FROM   room_players
     WHERE  room_id = ?
     ${onlineOnly ? 'AND is_connected = 1' : ''}
     ORDER  BY joined_at ASC`,
    [roomId]
  );

  return rows.map((p) => ({
    id:       p.id,
    nickname: p.nickname,
    isHost:   p.isHost === 1,
    isOnline: p.isConnected === 1,
    score:    p.score,
  }));
}

/**
 * Backward-compatible alias.
 * Any file that still imports getConnectedPlayers gets the onlineOnly
 * behaviour it always had.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} roomId
 * @returns {Promise<Array>}
 */
async function getConnectedPlayers(pool, roomId) {
  return getRoomPlayers(pool, roomId, { onlineOnly: true });
}

/**
 * Mark a player as connected or disconnected.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} playerId
 * @param {boolean} connected
 */
async function setPlayerConnected(pool, playerId, connected) {
  await pool.query(
    'UPDATE room_players SET is_connected = ? WHERE id = ?',
    [connected ? 1 : 0, playerId]
  );
}

/**
 * Promote the next joined, connected player to host.
 * Called when the host's reconnect grace period expires — NOT on immediate
 * disconnect, so the host's status is preserved during the grace window.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} roomId
 * @param {number} departingPlayerId  — the player who timed out or left
 * @returns {Promise<object|null>}    — newly promoted player, or null if empty
 */
async function promoteNextHost(pool, roomId, departingPlayerId) {
  const [rows] = await pool.query(
    `SELECT id, nickname
     FROM   room_players
     WHERE  room_id      = ?
     AND    id           != ?
     AND    is_connected = 1
     ORDER  BY joined_at ASC
     LIMIT  1`,
    [roomId, departingPlayerId]
  );

  if (rows.length === 0) return null;

  const newHost = rows[0];

  // Clear old host flag and set the new one atomically
  await pool.query(
    `UPDATE room_players
     SET    is_host = CASE WHEN id = ? THEN 1 ELSE 0 END
     WHERE  room_id = ?`,
    [newHost.id, roomId]
  );

  // Keep host_session_id on rooms in sync so REST endpoints stay consistent
  await pool.query(
    `UPDATE rooms r
     JOIN   room_players rp ON rp.id = ?
     SET    r.host_session_id = rp.session_token
     WHERE  r.id = ?`,
    [newHost.id, roomId]
  );

  return newHost;
}

/**
 * Update a room's settings_json and/or preset column.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} roomId
 * @param {object} fields   — { preset?, settings? }
 */
async function updateRoomSettings(pool, roomId, { preset, settings }) {
  const VALID_PRESETS = ['classic', 'party', 'custom'];

  if (preset && VALID_PRESETS.includes(preset)) {
    await pool.query(
      'UPDATE rooms SET preset = ? WHERE id = ?',
      [preset, roomId]
    );
  }

  if (settings && typeof settings === 'object') {
    await pool.query(
      'UPDATE rooms SET settings_json = ? WHERE id = ?',
      [JSON.stringify(settings), roomId]
    );
  }
}

/**
 * Transition a room's status column.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} roomId
 * @param {string} status
 */
async function setRoomStatus(pool, roomId, status) {
  await pool.query(
    'UPDATE rooms SET status = ? WHERE id = ?',
    [status, roomId]
  );
}

module.exports = {
  getPlayerByToken,
  getRoomPlayers,
  getConnectedPlayers,   // backward-compatible alias
  setPlayerConnected,
  promoteNextHost,
  updateRoomSettings,
  setRoomStatus,
};