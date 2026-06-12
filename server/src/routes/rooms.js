// server/src/routes/rooms.js
'use strict';

const express = require('express');
const crypto  = require('crypto');   // built-in — no install needed
const router  = express.Router();
const pool    = require('../config/db');

// ─────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────

const ROOM_CODE_CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0, I/1 (visually ambiguous)
const ROOM_CODE_LENGTH = 6;
const MAX_RETRIES      = 5;   // max attempts to find a unique code before giving up

const DEFAULT_PRESET       = 'classic';
const DEFAULT_TOTAL_ROUNDS = 3;
const DEFAULT_SETTINGS     = {
  imposter_count:  'auto',
  category_voting: true,
  special_rounds: {
    reverse_spy:  false,
    similar_word: false,
    chaos:        false,
  },
};

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

/**
 * Generates a random 6-character room code.
 * Uses only characters from ROOM_CODE_CHARS to avoid
 * ambiguous characters that are hard to read aloud or type.
 * Example output: "AB12CD", "X7K9P2"
 *
 * @returns {string}
 */
function generateRoomCode() {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

/**
 * Checks whether a room code already exists in the DB.
 *
 * @param {import('mysql2/promise').Pool} db
 * @param {string} code
 * @returns {Promise<boolean>}
 */
async function roomCodeExists(db, code) {
  const [rows] = await db.query(
    'SELECT id FROM rooms WHERE room_code = ? LIMIT 1',
    [code]
  );
  return rows.length > 0;
}

/**
 * Attempts to generate a code that does not already exist in the DB.
 * Retries up to MAX_RETRIES times — collisions are astronomically rare
 * at low scale, but this keeps the endpoint safe at any scale.
 *
 * @param {import('mysql2/promise').Pool} db
 * @returns {Promise<string>}
 * @throws {Error} if a unique code cannot be found within MAX_RETRIES
 */
async function generateUniqueRoomCode(db) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const code = generateRoomCode();
    const exists = await roomCodeExists(db, code);
    if (!exists) return code;
  }
  throw new Error(`Could not generate a unique room code after ${MAX_RETRIES} attempts`);
}

// ─────────────────────────────────────────────
//  POST /api/rooms
//  Creates a new room and returns the room code.
// ─────────────────────────────────────────────

/**
 * Request body (all fields optional — defaults applied for MVP):
 * {
 *   "hostSessionId": "uuid-string",   // required: identifies the host
 *   "preset":        "classic",       // optional: classic | party | custom
 *   "totalRounds":   3,               // optional: number of rounds
 *   "settings":      { ... }          // optional: overrides DEFAULT_SETTINGS
 * }
 *
 * Success response (201):
 * {
 *   "success":  true,
 *   "roomCode": "AB12CD"
 * }
 *
 * Error responses:
 *   400 — missing hostSessionId
 *   500 — database or code-generation failure
 */
router.post('/', async (req, res) => {
  const { hostSessionId, preset, totalRounds, settings } = req.body;

  // ── Validation ──────────────────────────────
  if (!hostSessionId || typeof hostSessionId !== 'string' || hostSessionId.trim() === '') {
    return res.status(400).json({
      success: false,
      error:   'hostSessionId is required',
    });
  }

  const sanitisedHostSession = hostSessionId.trim();

  // Validate preset if provided
  const VALID_PRESETS = ['classic', 'party', 'custom'];
  const resolvedPreset = preset && VALID_PRESETS.includes(preset) ? preset : DEFAULT_PRESET;

  // totalRounds must be a positive integer between 1 and 10
  const resolvedRounds = Number.isInteger(totalRounds) && totalRounds >= 1 && totalRounds <= 10
    ? totalRounds
    : DEFAULT_TOTAL_ROUNDS;

  // Merge provided settings on top of defaults so missing keys are always present
  const resolvedSettings = {
    ...DEFAULT_SETTINGS,
    ...(settings && typeof settings === 'object' ? settings : {}),
    special_rounds: {
      ...DEFAULT_SETTINGS.special_rounds,
      ...(settings?.special_rounds && typeof settings.special_rounds === 'object'
        ? settings.special_rounds
        : {}),
    },
  };

  // ── DB insert ───────────────────────────────
  try {
    const roomCode = await generateUniqueRoomCode(pool);

    await pool.query(
      `INSERT INTO rooms
         (room_code, host_session_id, preset, total_rounds, settings_json)
       VALUES
         (?, ?, ?, ?, ?)`,
      [
        roomCode,
        sanitisedHostSession,
        resolvedPreset,
        resolvedRounds,
        JSON.stringify(resolvedSettings),
      ]
    );

    return res.status(201).json({
      success:  true,
      roomCode,
    });

  } catch (err) {
    console.error('[POST /api/rooms] Error:', err.message);

    // Distinguish a code-generation failure from a generic DB error
    // so logs are actionable
    if (err.message.startsWith('Could not generate a unique room code')) {
      return res.status(503).json({
        success: false,
        error:   'Server is temporarily unable to create a room. Please try again.',
      });
    }

    return res.status(500).json({
      success: false,
      error:   'An unexpected error occurred. Please try again.',
    });
  }
});

// ─────────────────────────────────────────────
//  GET /api/rooms/:roomCode
//  Returns room details and current player list.
//  Safe to call from the lobby on page load or
//  refresh — no auth required, no sensitive data.
// ─────────────────────────────────────────────

/**
 * Success response (200):
 * {
 *   "success": true,
 *   "room": {
 *     "roomCode":     "AB12CD",
 *     "status":       "waiting",
 *     "preset":       "classic",
 *     "currentRound": 0,
 *     "totalRounds":  3,
 *     "playerCount":  2,
 *     "players": [
 *       { "id": 1, "nickname": "Swapnil", "isHost": true,  "score": 0 },
 *       { "id": 2, "nickname": "Rahul",   "isHost": false, "score": 0 }
 *     ]
 *   }
 * }
 *
 * Error responses:
 *   400 — roomCode param is missing or malformed
 *   404 — no room found for that code
 *   500 — unexpected server error
 */
router.get('/:roomCode', async (req, res) => {
  const cleanRoomCode = (req.params.roomCode || '').trim().toUpperCase();

  if (!cleanRoomCode) {
    return res.status(400).json({
      success: false,
      error:   'roomCode is required',
    });
  }

  try {
    // ── 1. Fetch the room ──────────────────────
    // One query per concern keeps the queries readable and independently
    // cacheable later. A JOIN would work too but mixing room + player
    // columns makes the mapping code noisier for no real perf gain here.
    const [roomRows] = await pool.query(
      `SELECT id,
              room_code      AS roomCode,
              status,
              preset,
              current_round  AS currentRound,
              total_rounds   AS totalRounds
       FROM   rooms
       WHERE  room_code = ?
       LIMIT  1`,
      [cleanRoomCode]
    );

    if (roomRows.length === 0) {
      return res.status(404).json({
        success: false,
        error:   'Room not found. Check the code and try again.',
      });
    }

    const room = roomRows[0];

    // ── 2. Fetch the player list ───────────────
    // Ordered by joined_at so the host (who joined first) naturally
    // appears at the top of the list on the frontend.
    // session_token is intentionally excluded — never expose tokens
    // in a response that all players can read.
    const [playerRows] = await pool.query(
      `SELECT id,
              nickname,
              is_host  AS isHost,
              score
       FROM   room_players
       WHERE  room_id      = ?
       AND    is_connected = 1
       ORDER  BY joined_at ASC`,
      [room.id]
    );

    // Cast MySQL tinyint(1) → proper JS boolean for isHost
    const players = playerRows.map((p) => ({
      id:       p.id,
      nickname: p.nickname,
      isHost:   p.isHost === 1,
      score:    p.score,
    }));

    return res.status(200).json({
      success: true,
      room: {
        roomCode:     room.roomCode,
        status:       room.status,
        preset:       room.preset,
        currentRound: room.currentRound,
        totalRounds:  room.totalRounds,
        playerCount:  players.length,
        players,
      },
    });

  } catch (err) {
    console.error(`[GET /api/rooms/${cleanRoomCode}] Error:`, err.message);

    return res.status(500).json({
      success: false,
      error:   'An unexpected error occurred. Please try again.',
    });
  }
});

// ─────────────────────────────────────────────
//  POST /api/rooms/join
//  Adds a player to an existing room.
// ─────────────────────────────────────────────

const NICKNAME_MAX_LENGTH = 20;

// Statuses a room must NOT be in for a player to join
const UNJOINABLE_STATUSES = ['finished'];

/**
 * Request body:
 * {
 *   "roomCode": "AB12CD",   // required
 *   "nickname": "Swapnil"   // required, unique within the room
 * }
 *
 * Success response (201):
 * {
 *   "success":      true,
 *   "playerId":     1,
 *   "sessionToken": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
 *   "roomCode":     "AB12CD"
 * }
 *
 * Error responses:
 *   400 — missing / invalid fields, duplicate nickname
 *   404 — room not found
 *   409 — room is not joinable (finished)
 *   500 — unexpected server error
 */
router.post('/join', async (req, res) => {
  const { roomCode, nickname } = req.body;

  // ── Input validation ────────────────────────

  // roomCode
  if (!roomCode || typeof roomCode !== 'string' || roomCode.trim() === '') {
    return res.status(400).json({
      success: false,
      error:   'roomCode is required',
    });
  }

  // nickname — present, non-empty, within length limit
  if (!nickname || typeof nickname !== 'string' || nickname.trim() === '') {
    return res.status(400).json({
      success: false,
      error:   'nickname is required',
    });
  }

  const cleanNickname = nickname.trim();

  if (cleanNickname.length > NICKNAME_MAX_LENGTH) {
    return res.status(400).json({
      success: false,
      error:   `nickname must be ${NICKNAME_MAX_LENGTH} characters or fewer`,
    });
  }

  const cleanRoomCode = roomCode.trim().toUpperCase();

  // ── DB operations ───────────────────────────
  try {
    // 1. Confirm the room exists and is joinable
    //    Single query — fetch status so we can give a precise error message.
    const [roomRows] = await pool.query(
      `SELECT id, status
       FROM   rooms
       WHERE  room_code = ?
       LIMIT  1`,
      [cleanRoomCode]
    );

    if (roomRows.length === 0) {
      return res.status(404).json({
        success: false,
        error:   'Room not found. Check the code and try again.',
      });
    }

    const room = roomRows[0];

    if (UNJOINABLE_STATUSES.includes(room.status)) {
      return res.status(409).json({
        success: false,
        error:   'This room has already finished. Ask the host to start a new game.',
      });
    }

    // 2. Enforce nickname uniqueness within this room
    //    The DB has a unique index on (room_id, nickname) as a hard guard,
    //    but we check here first to return a friendly message instead of
    //    letting a DB constraint error bubble up.
    const [nicknameRows] = await pool.query(
      `SELECT id
       FROM   room_players
       WHERE  room_id  = ?
       AND    nickname = ?
       LIMIT  1`,
      [room.id, cleanNickname]
    );

    if (nicknameRows.length > 0) {
      return res.status(400).json({
        success: false,
        error:   `Nickname "${cleanNickname}" is already taken in this room. Choose a different name.`,
      });
    }

    // 3. Generate a session token and insert the player
    //    crypto.randomUUID() produces a v4 UUID — no external package needed.
    const sessionToken = crypto.randomUUID();

    const [hostRows] = await pool.query(
  `SELECT COUNT(*) AS count
   FROM room_players
   WHERE room_id = ?`,
  [room.id]
);

const isHost = hostRows[0].count === 0 ? 1 : 0;

    const [insertResult] = await pool.query(
  `INSERT INTO room_players
     (room_id, nickname, session_token, is_host)
   VALUES
     (?, ?, ?, ?)`,
  [room.id, cleanNickname, sessionToken, isHost]
);

    return res.status(201).json({
      success:      true,
      playerId:     insertResult.insertId,
      sessionToken,
      roomCode:     cleanRoomCode,
    });

  } catch (err) {
    console.error('[POST /api/rooms/join] Error:', err.message);

    // The DB unique index on (room_id, nickname) is a safety net.
    // If two requests race past the application-level check above,
    // MySQL will throw ER_DUP_ENTRY. Handle it gracefully.
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({
        success: false,
        error:   'That nickname was just taken. Please choose another.',
      });
    }

    return res.status(500).json({
      success: false,
      error:   'An unexpected error occurred. Please try again.',
    });
  }
});

module.exports = router;
