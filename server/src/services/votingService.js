// server/src/services/votingService.js
'use strict';

/**
 * Tallies votes and determines eliminated players.
 *
 * votes is  Map<voterId, targetId[]>  — flattened before counting.
 *
 * ELIMINATION — slot-by-slot:
 *   Sort players by vote count descending.
 *   Walk each slot 0..N-1. A slot is blocked (tied) if the candidate at that
 *   position shares a vote count with the first player OUTSIDE the full N-slot
 *   group. Already-confirmed prior slots remain eliminated; no further slots
 *   are filled once a block is hit.
 *
 *   "Outside the group" means sorted[N] — the first player that would NOT be
 *   eliminated if all N slots were filled cleanly.
 *
 *   Examples (imposterCount = 2, sorted positions 0-indexed):
 *     A=8 B=7 C=6  → slot0: A(8) vs outside(C=6): 8≠6 ✓  slot1: B(7) vs outside(C=6): 7≠6 ✓ → eliminate A,B
 *     A=8 B=7 C=7  → slot0: A(8) vs outside(C=7): 8≠7 ✓  slot1: B(7) vs outside(C=7): 7=7 ✗ → stop → eliminate A only
 *     A=8 B=8 C=5  → slot0: A(8) vs outside(C=5): 8≠5 ✓  slot1: B(8) vs outside(C=5): 8≠5 ✓ → eliminate A,B
 *     A=8 B=8 C=8  → slot0: A(8) vs outside(C=8): 8=8 ✗ → stop immediately → nobody eliminated
 *
 * Single-imposter (N=1) behaviour is identical to the original implementation.
 */
function tallyVotes(votes, roundPlayers, imposterCount = 1) {
  // Build a zeroed count map for every player in the round
  const voteCounts = {};
  for (const p of roundPlayers) {
    voteCounts[p.playerId] = 0;
  }

  // Flatten: each entry in a voter's array counts as one independent vote
  for (const targetIds of votes.values()) {
    for (const targetId of targetIds) {
      if (voteCounts[targetId] !== undefined) {
        voteCounts[targetId]++;
      }
    }
  }

  const maxVotes = Math.max(...Object.values(voteCounts));

  // Edge case: no votes cast at all
  if (maxVotes === 0) {
    return {
      eliminatedPlayerIds: [],
      eliminatedPlayerId:  null,
      eliminatedRole:      null,
      voteCounts,
      isTie:         false,
      tiedPlayerIds: [],
    };
  }

  // Sort descending by vote count.
  // Stable secondary sort: original roundPlayers order (matches prior behaviour).
  const sorted = roundPlayers
    .slice()
    .sort((a, b) => (voteCounts[b.playerId] ?? 0) - (voteCounts[a.playerId] ?? 0));

  // The first player outside the N-slot group — the boundary for tie detection.
  // If there are fewer players than imposterCount (shouldn't happen in practice)
  // firstOutside is undefined, meaning no tie is possible.
  const firstOutside = sorted[imposterCount];

  // ── Slot-by-slot elimination ─────────────────────────────────────────────
  const eliminatedIds = [];
  let tiedPlayerIds   = [];

  for (let slot = 0; slot < imposterCount; slot++) {
    const candidate = sorted[slot];

    // A slot is blocked if this candidate ties with the first player outside
    // the full group. A tie with another player inside the group (slot < N)
    // does NOT block — both are unambiguously in the top N.
    if (
      firstOutside !== undefined &&
      voteCounts[candidate.playerId] === voteCounts[firstOutside.playerId]
    ) {
      // Collect all players at this tied vote count for display
      const tiedCount = voteCounts[firstOutside.playerId];
      tiedPlayerIds = Object.entries(voteCounts)
        .filter(([, count]) => count === tiedCount)
        .map(([id]) => Number(id));
      break;
    }

    eliminatedIds.push(candidate.playerId);
  }

  const isTie           = tiedPlayerIds.length > 0;
  const firstEliminated = roundPlayers.find(p => p.playerId === eliminatedIds[0]);

  return {
    eliminatedPlayerIds: eliminatedIds,
    eliminatedPlayerId:  firstEliminated?.playerId ?? null,  // backward compat
    eliminatedRole:      firstEliminated?.role     ?? null,  // backward compat
    voteCounts,
    isTie,
    tiedPlayerIds,
  };
}

/**
 * Builds the full vote breakdown for the result broadcast.
 * One entry per (voter, target) pair — Result.jsx groups these by voter for display.
 */
function buildVoteBreakdown(votes, roundPlayers) {
  const nicknameMap = {};
  for (const p of roundPlayers) {
    nicknameMap[p.playerId] = p.nickname;
  }

  const breakdown = [];
  for (const [voterId, targetIds] of votes.entries()) {
    for (const targetId of targetIds) {
      breakdown.push({
        voterId:        Number(voterId),
        targetId:       Number(targetId),
        voterNickname:  nicknameMap[voterId]  || 'Unknown',
        targetNickname: nicknameMap[targetId] || 'Unknown',
      });
    }
  }
  return breakdown;
}

module.exports = { tallyVotes, buildVoteBreakdown };