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
    isHost:      row.isHost === 1,
    settingsJson: typeof row.settingsJson === 'string'
      ? JSON.parse(row.settingsJson)
      : row.settingsJson,
  };
}

/**
 * Fetch the current connected player list for a room.
 * Used to broadcast lobby state after any change.
 * session_token is intentionally excluded.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} roomId
 * @returns {Promise<Array>}
 */
async function getConnectedPlayers(pool, roomId) {
  const [rows] = await pool.query(
    `SELECT id,
            nickname,
            is_host  AS isHost,
            score
     FROM   room_players
     WHERE  room_id      = ?
     AND    is_connected = 1
     ORDER  BY joined_at ASC`,
    [roomId]
  );
  return rows.map((p) => ({
    id:       p.id,
    nickname: p.nickname,
    isHost:   p.isHost === 1,
    score:    p.score,
  }));
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
 * Promote the next joined player to host.
 * Called when the host disconnects so the room is never host-less.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} roomId
 * @param {number} departingPlayerId  — the player who just left/disconnected
 * @returns {Promise<object|null>}    — the newly promoted player, or null if room is empty
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

  // Clear old host flag and set the new one in one statement
  await pool.query(
    `UPDATE room_players
     SET    is_host = CASE WHEN id = ? THEN 1 ELSE 0 END
     WHERE  room_id = ?`,
    [newHost.id, roomId]
  );

  // Sync host_session_id on rooms so REST endpoints stay consistent
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
  getConnectedPlayers,
  setPlayerConnected,
  promoteNextHost,
  updateRoomSettings,
  setRoomStatus,
};
