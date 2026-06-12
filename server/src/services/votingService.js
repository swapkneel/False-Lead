// server/src/services/votingService.js
// ─────────────────────────────────────────────────────────────────────────────
//  Vote tallying and result determination.
//
//  Pure logic — no DB access, no socket calls.
//  Receives the votes Map and the round_players array, returns a result object.
//
//  Responsibilities:
//    - Count votes per target
//    - Find the most-voted player
//    - Detect and handle ties (random selection among tied players)
//    - Return structured result for scoringService and socket broadcast
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

/**
 * Tallies votes and determines the eliminated player.
 *
 * @param {Map<number, number>} votes
 *   Map of voterId → targetId (from in-memory roundState)
 *
 * @param {object[]} roundPlayers
 *   Array of round_players rows:
 *   [{ playerId, nickname, role, receivedInfo }]
 *
 * @returns {object} result
 * {
 *   eliminatedPlayerId: number | null,   — null only if zero votes cast (edge case)
 *   eliminatedRole:     string | null,
 *   voteCounts:         { [playerId]: number },
 *   isTie:              boolean,
 *   tiedPlayerIds:      number[],        — populated when isTie is true
 * }
 */
function tallyVotes(votes, roundPlayers) {
  // Build a count map: { playerId → voteCount }
  const voteCounts = {};
  for (const playerId of roundPlayers.map(p => p.playerId)) {
    voteCounts[playerId] = 0;
  }
  for (const targetId of votes.values()) {
    if (voteCounts[targetId] !== undefined) {
      voteCounts[targetId]++;
    }
  }

  // Find the maximum vote count
  const maxVotes = Math.max(...Object.values(voteCounts));

  // Edge case: no votes cast at all (every player skipped / disconnected)
  if (maxVotes === 0) {
    return {
      eliminatedPlayerId: null,
      eliminatedRole:     null,
      voteCounts,
      isTie:              false,
      tiedPlayerIds:      [],
    };
  }

  // Collect all players tied at the max
  const tiedIds = Object.entries(voteCounts)
    .filter(([, count]) => count === maxVotes)
    .map(([id]) => Number(id));

  const isTie           = tiedIds.length > 1;
  const eliminatedId    = tiedIds[Math.floor(Math.random() * tiedIds.length)];
  const eliminatedPlayer = roundPlayers.find(p => p.playerId === eliminatedId);

  return {
    eliminatedPlayerId: eliminatedId,
    eliminatedRole:     eliminatedPlayer ? eliminatedPlayer.role : null,
    voteCounts,
    isTie,
    tiedPlayerIds:      isTie ? tiedIds : [],
  };
}

/**
 * Builds the full vote breakdown for the result broadcast.
 * Maps each voter to their target with nicknames for the frontend.
 *
 * @param {Map<number, number>} votes          — voterId → targetId
 * @param {object[]}            roundPlayers   — [{ playerId, nickname }]
 * @returns {object[]}
 * [{ voterNickname, targetNickname }]
 */
function buildVoteBreakdown(votes, roundPlayers) {
  const nicknameMap = {};
  for (const p of roundPlayers) {
    nicknameMap[p.playerId] = p.nickname;
  }

  const breakdown = [];
  for (const [voterId, targetId] of votes.entries()) {
    breakdown.push({
      voterId:        Number(voterId),
      targetId:       Number(targetId),
      voterNickname:  nicknameMap[voterId]  || 'Unknown',
      targetNickname: nicknameMap[targetId] || 'Unknown',
    });
  }
  return breakdown;
}

module.exports = { tallyVotes, buildVoteBreakdown };
