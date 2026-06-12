// server/src/services/roundService.js
// ─────────────────────────────────────────────────────────────────────────────
//  Round creation orchestrator.
//
//  This is the single function called by gameHandlers when the host starts
//  a round. It runs every phase in order:
//
//    Phase 1  — resolve winning category from votes
//    Phase 2  — select round type (respects settings + history)
//    Phase 3  — select word (with alternate if similar_word)
//    Phase 4  — insert rounds row
//    Phase 5  — build role assignments (pure logic, no DB)
//    Phase 6  — bulk-insert round_players rows
//
//  Returns the completed round data so gameHandlers can do the
//  socket delivery (Phase 7) without knowing anything about the DB.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { resolveCategory, selectWord, selectWordWithAlternate } = require('./wordService');
const { selectRoundType, ROUND_TYPES }                         = require('./roundTypeService');
const { buildAssignments }                                     = require('./roleAssignmentService');

/**
 * Creates a complete round for a room.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} params
 * @param {number}   params.roomId
 * @param {string}   params.roomCode
 * @param {number}   params.roundNumber   — 1-based, already incremented by caller
 * @param {number}   params.totalRounds
 * @param {object}   params.settings      — parsed settings_json
 * @param {object[]} params.players       — connected players [{ id, nickname }]
 *
 * @returns {Promise<object>}  round result (used by gameHandlers for socket delivery)
 * {
 *   roundId:      number,
 *   roundNumber:  number,
 *   roundType:    string,
 *   category:     string,
 *   word:         string,          — only for DB/host, never broadcast to all
 *   alternateWord: string|null,
 *   assignments:  Assignment[],    — full array, used for per-player socket emit
 * }
 */
async function createRound(pool, {
  roomId,
  roundNumber,
  totalRounds,
  settings,
  players,
}) {
  // ── Phase 1: Category resolution ──────────────────────────────────────
  const category = await resolveCategory(pool, roomId);

  // ── Phase 2: Round type selection ─────────────────────────────────────
  // Fetch previously used round types for this room so we respect
  // the "chaos only once" and "spread specials" rules.
  const [priorRounds] = await pool.query(
    `SELECT round_type FROM rounds WHERE room_id = ? ORDER BY round_number ASC`,
    [roomId]
  );
  const usedRoundTypes = priorRounds.map(r => r.round_type);

  let roundType = selectRoundType({
    settings,
    currentRound: roundNumber,
    totalRounds,
    usedRoundTypes,
  });

  // ── Phase 3: Word selection ────────────────────────────────────────────
  let wordEntry;
  let wordSelectionFailed = false;

  if (roundType === ROUND_TYPES.SIMILAR_WORD) {
    try {
      wordEntry = await selectWordWithAlternate(pool, category);
    } catch (err) {
      if (err.message === 'NO_ALTERNATE_WORDS') {
        // Graceful downgrade — not enough alternate words, play normal instead
        console.warn('[roundService] similar_word downgraded to normal (no alternate words)');
        wordSelectionFailed = true;
        roundType  = ROUND_TYPES.NORMAL;
        wordEntry  = await selectWord(pool, category);
      } else {
        throw err;
      }
    }
  } else if (roundType === ROUND_TYPES.CHAOS) {
    // Chaos doesn't use a real word — insert placeholder values
    wordEntry = { word: '???', hint: '???', alternate_word: null };
  } else {
    wordEntry = await selectWord(pool, category);
  }

  // ── Phase 4: Insert round record ──────────────────────────────────────
  const [roundInsert] = await pool.query(
    `INSERT INTO rounds
       (room_id, round_number, round_type, category, word, alternate_word, status)
     VALUES
       (?, ?, ?, ?, ?, ?, 'clue')`,
    [
      roomId,
      roundNumber,
      roundType,
      category,
      wordEntry.word,
      wordEntry.alternate_word || null,
    ]
  );

  const roundId = roundInsert.insertId;

  // ── Phase 5: Build role assignments (pure logic, no DB) ────────────────
  const assignments = buildAssignments({
    players,
    roundType,
    wordEntry,
    settings,
  });

  // ── Phase 6: Bulk-insert round_players ────────────────────────────────
  // Build values array for a single multi-row INSERT — one round-trip
  // regardless of player count.
  const roundPlayerValues = assignments.map(a => [
    roundId,
    a.playerId,
    a.role,
    a.receivedInfo,
    a.clueOrder,
  ]);

  await pool.query(
    `INSERT INTO round_players
       (round_id, room_player_id, role, received_info, clue_order)
     VALUES ?`,
    [roundPlayerValues]
  );

  // ── Update room's current_round counter ───────────────────────────────
  await pool.query(
    'UPDATE rooms SET current_round = ? WHERE id = ?',
    [roundNumber, roomId]
  );

  return {
    roundId,
    roundNumber,
    roundType,
    category,
    word:          wordEntry.word,
    alternateWord: wordEntry.alternate_word || null,
    assignments,
    downgradedFrom: wordSelectionFailed ? ROUND_TYPES.SIMILAR_WORD : null,
  };
}

module.exports = { createRound };
