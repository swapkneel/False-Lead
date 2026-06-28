// server/src/services/scoringService.js
'use strict';

const { ROUND_TYPES } = require('./roundTypeService');

// Roles that receive the survival bonus in normal / similar_word rounds.
const TARGET_ROLES = new Set([
  'imposter',
  'reverse_spy_target',
  'similar_word_target',
]);

/**
 * Calculates score deltas for every player in a round.
 *
 * NORMAL / SIMILAR_WORD rounds:
 *   Target players (imposter, similar_word_target):
 *     Scored on survival only. +3 if survived, 0 if eliminated.
 *     Their own votes never affect their score.
 *   Normal players:
 *     Each vote scored independently. +1 correct, -1 wrong.
 *
 * REVERSE SPY round:
 *   Only the reverse_spy_target (informant) receives the survival bonus.
 *   Every other player — including those with role 'imposter' — scores
 *   from their votes exactly like a normal player (+1 / -1).
 *   A "correct" vote in Reverse Spy means voting for the informant.
 *   Voting for an imposter is a wrong vote.
 *
 * CHAOS: everyone 0.
 *
 * @param {object}   params
 * @param {string}   params.roundType
 * @param {object[]} params.roundPlayers    — [{ playerId, role }]
 * @param {object}   params.tallyResult     — from votingService.tallyVotes()
 * @param {Map}      params.votes           — Map<voterId, targetId[]>
 * @param {number}   params.imposterCount
 * @returns {object[]} [{ playerId, delta }]
 */
function calculateDeltas({ roundType, roundPlayers, tallyResult, votes, imposterCount = 1 }) {
  // Chaos: no points for anyone
  if (roundType === ROUND_TYPES.CHAOS) {
    return roundPlayers.map(p => ({ playerId: p.playerId, delta: 0 }));
  }

  const { eliminatedPlayerIds } = tallyResult;
  const eliminatedSet = new Set(eliminatedPlayerIds);

  // Reverse Spy is the inverse game: only the informant is the scoring target.
  // Imposters in this round are NOT targets — they score from votes like everyone else.
  // Using the full TARGET_ROLES set here would wrongly give imposters +3 for surviving.
  const isReverseSpy = roundType === ROUND_TYPES.REVERSE_SPY;

  const scoringTargetRoles = isReverseSpy
    ? new Set(['reverse_spy_target'])
    : TARGET_ROLES;

  // playerIds whose role qualifies for the survival bonus
  const targetIds = new Set(
    roundPlayers.filter(p => scoringTargetRoles.has(p.role)).map(p => p.playerId)
  );

  const deltas = [];

  for (const player of roundPlayers) {
    const isTarget = scoringTargetRoles.has(player.role);

    // ── Scoring-target players ────────────────────────────────────────
    if (isTarget) {
      // Reverse Spy informant earns +4 for surviving (only one target exists,
      // so the reward is higher). All other target roles earn +3.
      const survived      = !eliminatedSet.has(player.playerId);
      const survivalBonus = isReverseSpy ? 4 : 3;
      deltas.push({
        playerId: player.playerId,
        delta:    survived ? survivalBonus : 0,
      });
      continue;
    }

    // ── All other players (normal, and imposters in Reverse Spy) ─────
    // Score each vote independently.
    // Correct vote: +1 in all round types.
    // Wrong vote:    0 in Reverse Spy (only one target exists so a forced
    //                  second vote can never be correct — no penalty applied).
    //               -1 in all other round types.
    const playerVotes  = votes ? (votes.get(player.playerId) ?? []) : [];
    const wrongPenalty = isReverseSpy ? 0 : -1;

    let delta = 0;
    for (const votedId of playerVotes) {
      if (targetIds.has(votedId)) {
        delta += 1;           // voted for the real target
      } else {
        delta += wrongPenalty; // 0 in Reverse Spy, -1 elsewhere
      }
    }

    deltas.push({ playerId: player.playerId, delta });
  }

  return deltas;
}

/**
 * Applies score deltas to room_players.score in the DB.
 * Skips players with delta === 0 to avoid unnecessary writes.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {object[]} deltas — [{ playerId, delta }]
 */
async function applyDeltas(pool, deltas) {
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