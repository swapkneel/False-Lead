// server/src/services/scoringService.js
'use strict';

const { ROUND_TYPES } = require('./roundTypeService');

// Roles that are "the target" — the player the group is trying to find
const TARGET_ROLES = new Set([
  'imposter',
  'reverse_spy_target',
  'similar_word_target',
]);

/**
 * Calculates score deltas for every player in a round.
 *
 * Scoring rules (all round types except chaos):
 *
 *   TARGET ELIMINATED (correctVote = true, isTie = false):
 *     Target player:          0
 *     Voters who picked target (correct): +2
 *     Voters who picked wrong target:      0
 *
 *   TARGET SURVIVED (tie OR wrong player eliminated):
 *     Target player:          +3
 *     Voters who picked target (correct but survived):  +1
 *     Voters who picked wrong target:                   -1
 *
 *   CHAOS: everyone 0.
 *
 * Negative scores are allowed and written to the DB.
 *
 * @param {object} params
 * @param {string}   params.roundType
 * @param {object[]} params.roundPlayers   — [{ playerId, role }]
 * @param {object}   params.tallyResult    — from votingService.tallyVotes()
 * @param {Map}      params.votes          — voterId → targetId (for "correct voter" detection)
 * @returns {object[]} [{ playerId, delta }]
 */
function calculateDeltas({ roundType, roundPlayers, tallyResult, votes }) {
  // Chaos: no points
  if (roundType === ROUND_TYPES.CHAOS) {
    return roundPlayers.map(p => ({ playerId: p.playerId, delta: 0 }));
  }

  const { eliminatedPlayerId, isTie } = tallyResult;

  // Find the target player (imposter / spy / odd one)
  const targetPlayer = roundPlayers.find(p => TARGET_ROLES.has(p.role));
  const targetId     = targetPlayer ? targetPlayer.playerId : null;

  // Determine whether the target was actually eliminated.
  // A tie means eliminatedPlayerId === null, so targetEliminated is false.
  const targetEliminated =
    eliminatedPlayerId !== null &&
    targetId !== null &&
    eliminatedPlayerId === targetId;

  const deltas = [];

  for (const player of roundPlayers) {
    const isTarget = TARGET_ROLES.has(player.role);

    if (isTarget) {
      // Target earns +3 for surviving, 0 if eliminated
      deltas.push({
        playerId: player.playerId,
        delta:    targetEliminated ? 0 : 3,
      });
      continue;
    }

    // Non-target player — determine if they voted correctly
    // "Correct vote" = voted for the target, regardless of outcome
    const thisPlayerVote  = votes ? votes.get(player.playerId) : undefined;
    const votedForTarget  = thisPlayerVote !== undefined && thisPlayerVote === targetId;

    if (targetEliminated) {
      // Target was caught: correct voters +2, wrong voters 0
      deltas.push({
        playerId: player.playerId,
        delta:    votedForTarget ? 2 : 0,
      });
    } else {
      // Target survived (tie or wrong elimination): correct voters +1, wrong voters -1
      deltas.push({
        playerId: player.playerId,
        delta:    votedForTarget ? 1 : -1,
      });
    }
  }

  return deltas;
}

/**
 * Applies score deltas to room_players.score in the DB.
 * Handles both positive and negative deltas.
 * Skips players with delta === 0 to avoid unnecessary writes.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {object[]} deltas — [{ playerId, delta }]
 */
async function applyDeltas(pool, deltas) {
  // Include negative deltas — previously this only wrote positives
  const scoringDeltas = deltas.filter(d => d.delta !== 0);
  if (scoringDeltas.length === 0) return;

  const caseParts    = scoringDeltas.map(() => 'WHEN id = ? THEN score + ?').join(' ');
  const caseValues   = scoringDeltas.flatMap(d => [d.playerId, d.delta]);
  const playerIds    = scoringDeltas.map(d => d.playerId);
  const placeholders = playerIds.map(() => '?').join(', ');

  await pool.query(
    `UPDATE room_players
     SET    score = CASE ${caseParts} ELSE score END
     WHERE  id IN (${placeholders})`,
    [...caseValues, ...playerIds]
  );
}

/**
 * Fetches updated scores for a list of player IDs, sorted descending.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number[]} playerIds
 * @returns {Promise<object[]>} [{ playerId, nickname, score }]
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