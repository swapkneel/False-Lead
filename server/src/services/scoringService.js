// server/src/services/scoringService.js
// ─────────────────────────────────────────────────────────────────────────────
//  Calculates score deltas for a completed round and writes them to the DB.
//
//  Scoring rules:
//
//  NORMAL round
//    Normal player:  +1 if imposter was eliminated (correct vote)
//    Imposter:       +2 if imposter survived (not eliminated)
//
//  REVERSE SPY round
//    Normal player:  +1 if spy was eliminated
//    Spy target:     +2 if spy survived
//
//  SIMILAR WORD round
//    Normal player:  +1 if odd-one-out was eliminated
//    Odd player:     +2 if odd-one-out survived
//
//  CHAOS round
//    Everyone:       +0  (no points, no correct answer exists)
//
//  Design note:
//    This service receives the pre-computed tally result and the full
//    round_players list. It is pure logic until the final DB write step.
//    The separation keeps scoring testable without a live database.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { ROUND_TYPES } = require('./roundTypeService');

// Roles that are "the target" — the player everyone is trying to find
const TARGET_ROLES = new Set([
  'imposter',
  'reverse_spy_target',
  'similar_word_target',
]);

/**
 * Calculates score deltas for every player in a round.
 *
 * @param {object} params
 * @param {string}   params.roundType         — one of ROUND_TYPES
 * @param {object[]} params.roundPlayers       — [{ playerId, role }]
 * @param {object}   params.tallyResult        — output of votingService.tallyVotes()
 *
 * @returns {object[]} deltas — [{ playerId, delta }]
 *   delta is 0 for players who earn nothing this round.
 *   Always one entry per player so the caller can iterate predictably.
 */
function calculateDeltas({ roundType, roundPlayers, tallyResult }) {
  // Chaos: no points for anyone
  if (roundType === ROUND_TYPES.CHAOS) {
    return roundPlayers.map(p => ({ playerId: p.playerId, delta: 0 }));
  }

  const { eliminatedPlayerId } = tallyResult;
  const deltas = [];

  for (const player of roundPlayers) {
    const isTarget    = TARGET_ROLES.has(player.role);
    const isEliminated = player.playerId === eliminatedPlayerId;

    let delta = 0;

    if (isTarget) {
      // Target earns points for surviving
      delta = isEliminated ? 0 : 2;
    } else {
      // Normal players earn points if the target was correctly eliminated
      // Only award if the target was actually eliminated (not a no-vote or missed tie)
      const targetWasEliminated =
        eliminatedPlayerId !== null &&
        roundPlayers.some(p => p.playerId === eliminatedPlayerId && TARGET_ROLES.has(p.role));

      delta = targetWasEliminated ? 1 : 0;
    }

    deltas.push({ playerId: player.playerId, delta });
  }

  return deltas;
}

/**
 * Applies score deltas to room_players.score in the DB.
 * Uses a single bulk UPDATE via CASE expression — one round-trip.
 * Only updates rows where delta > 0 to avoid unnecessary writes.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {object[]} deltas   — [{ playerId, delta }]
 */
async function applyDeltas(pool, deltas) {
  const scoringDeltas = deltas.filter(d => d.delta > 0);
  if (scoringDeltas.length === 0) return; // nothing to update

  // Build:  CASE WHEN id = 1 THEN score + 2 WHEN id = 2 THEN score + 1 ... END
  const caseParts   = scoringDeltas.map(() => 'WHEN id = ? THEN score + ?').join(' ');
  const caseValues  = scoringDeltas.flatMap(d => [d.playerId, d.delta]);
  const playerIds   = scoringDeltas.map(d => d.playerId);
  const placeholders = playerIds.map(() => '?').join(', ');

  await pool.query(
    `UPDATE room_players
     SET    score = CASE ${caseParts} ELSE score END
     WHERE  id IN (${placeholders})`,
    [...caseValues, ...playerIds]
  );
}

/**
 * Fetches updated scores for a list of player IDs.
 * Called after applyDeltas so the broadcast reflects the new totals.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number[]} playerIds
 * @returns {Promise<object[]>}  [{ playerId, nickname, score }]
 */
async function fetchUpdatedScores(pool, playerIds) {
  if (playerIds.length === 0) return [];
  const placeholders = playerIds.map(() => '?').join(', ');
  const [rows] = await pool.query(
    `SELECT id AS playerId, nickname, score
     FROM   room_players
     WHERE  id IN (${placeholders})
     ORDER  BY score DESC`,
    playerIds
  );
  return rows;
}

module.exports = { calculateDeltas, applyDeltas, fetchUpdatedScores };
