// server/src/services/wordService.js
// ─────────────────────────────────────────────────────────────────────────────
//  Handles two responsibilities:
//    1. Category resolution  — tallies category_votes to find a winner
//    2. Word selection       — picks a random word from word_bank
//
//  AI (Gemini) is intentionally absent here. The word_bank is the sole
//  runtime data source. Gemini is used offline to expand the bank.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ─────────────────────────────────────────────
//  Category resolution
// ─────────────────────────────────────────────

/**
 * Reads category_votes for a room and returns the winning category.
 * Ties are broken by random selection among the tied categories.
 * If no votes exist, a random category from word_bank is used.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} roomId
 * @returns {Promise<string>}  the winning category name
 */
async function resolveCategory(pool, roomId) {
  // Tally votes for this room
  const [voteRows] = await pool.query(
    `SELECT   category, COUNT(*) AS vote_count
     FROM     category_votes
     WHERE    room_id = ?
     GROUP BY category
     ORDER BY vote_count DESC`,
    [roomId]
  );

  if (voteRows.length > 0) {
    // Collect all categories tied at the highest vote count
    const topCount = voteRows[0].vote_count;
    const topTied  = voteRows.filter(r => r.vote_count === topCount).map(r => r.category);

    // Random pick among tied winners
    return topTied[Math.floor(Math.random() * topTied.length)];
  }

  // No votes cast — fall back to a random active category from word_bank
  return getRandomCategory(pool);
}

/**
 * Returns a random category that has at least one active word in word_bank.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<string>}
 */
async function getRandomCategory(pool) {
  const [rows] = await pool.query(
    `SELECT DISTINCT category
     FROM   word_bank
     WHERE  is_active = 1
     ORDER  BY RAND()
     LIMIT  1`
  );

  if (rows.length === 0) {
    throw new Error('word_bank is empty — seed the database before starting a game');
  }

  return rows[0].category;
}

// ─────────────────────────────────────────────
//  Word selection
// ─────────────────────────────────────────────

/**
 * Picks a random word from word_bank for the given category.
 * Returns the full row: { id, word, hint, alternate_word, category, difficulty }
 *
 * Falls back to any category if the requested one has no active words
 * (defensive — should never happen with a properly seeded DB).
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} category
 * @returns {Promise<object>}
 */
async function selectWord(pool, category) {
  const [rows] = await pool.query(
    `SELECT id, word, hint, alternate_word, category, difficulty
     FROM   word_bank
     WHERE  category  = ?
     AND    is_active = 1
     ORDER  BY RAND()
     LIMIT  1`,
    [category]
  );

  if (rows.length > 0) return rows[0];

  // Fallback — pick from any category
  console.warn(`[wordService] No active words for category "${category}", using fallback`);

  const [fallbackRows] = await pool.query(
    `SELECT id, word, hint, alternate_word, category, difficulty
     FROM   word_bank
     WHERE  is_active = 1
     ORDER  BY RAND()
     LIMIT  1`
  );

  if (fallbackRows.length === 0) {
    throw new Error('word_bank is empty — seed the database before starting a game');
  }

  return fallbackRows[0];
}

/**
 * Picks a random word that has a non-null alternate_word.
 * Required for Similar Word rounds.
 * Falls back to selectWord (normal) if no alternates exist for the category.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} category
 * @returns {Promise<object>}  word row guaranteed to have alternate_word
 */
async function selectWordWithAlternate(pool, category) {
  const [rows] = await pool.query(
    `SELECT id, word, hint, alternate_word, category, difficulty
     FROM   word_bank
     WHERE  category       = ?
     AND    is_active       = 1
     AND    alternate_word IS NOT NULL
     ORDER  BY RAND()
     LIMIT  1`,
    [category]
  );

  if (rows.length > 0) return rows[0];

  // Not enough alternate words in this category — try any category
  console.warn(
    `[wordService] No alternate_word entries for category "${category}". ` +
    'Trying any category — run generate_alternates.js to expand the bank.'
  );

  const [fallbackRows] = await pool.query(
    `SELECT id, word, hint, alternate_word, category, difficulty
     FROM   word_bank
     WHERE  is_active       = 1
     AND    alternate_word IS NOT NULL
     ORDER  BY RAND()
     LIMIT  1`
  );

  if (fallbackRows.length > 0) return fallbackRows[0];

  // No alternates exist anywhere — this round cannot be similar_word
  throw new Error('NO_ALTERNATE_WORDS');
}

/**
 * Selects 2-3 distinct words from the same category for Chaos mode.
 *
 * Returns:
 * [
 *   "Pizza",
 *   "Burger"
 * ]
 *
 * or
 *
 * [
 *   "Pizza",
 *   "Burger",
 *   "Pasta"
 * ]
 */
async function selectWordsForChaos(pool, category, playerCount) {
  const [rows] = await pool.query(
    `SELECT word
     FROM word_bank
     WHERE category = ?
     AND is_active = 1
     ORDER BY RAND()
     LIMIT ?`,
    [category, playerCount]
  );

  if (rows.length < playerCount) {
    throw new Error(
      `[wordService] Chaos requires at least ${playerCount} words in category "${category}"`
    );
  }

  return rows.map(r => r.word);
}

module.exports = {
  resolveCategory,
  getRandomCategory,
  selectWord,
  selectWordWithAlternate,
  selectWordsForChaos,
};
