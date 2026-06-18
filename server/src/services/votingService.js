// server/src/services/votingService.js
'use strict';

/**
 * Tallies votes and determines the result.
 *
 * TIE RULE (fixed): when multiple players share the highest vote count,
 * no player is eliminated. eliminatedPlayerId is null and isTie is true.
 * The scoring service treats this as the target having survived.
 *
 * Previously the code randomly picked one tied player as eliminated —
 * that contradicted the spec and broke tie scoring.
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

  const maxVotes = Math.max(...Object.values(voteCounts));

  // Edge case: no votes cast at all
  if (maxVotes === 0) {
    return {
      eliminatedPlayerId: null,
      eliminatedRole:     null,
      voteCounts,
      isTie:              false,
      tiedPlayerIds:      [],
    };
  }

  // All players tied at the max
  const tiedIds = Object.entries(voteCounts)
    .filter(([, count]) => count === maxVotes)
    .map(([id]) => Number(id));

  const isTie = tiedIds.length > 1;

  if (isTie) {
    // Tie = no elimination. Target survives. Scoring uses the survived path.
    return {
      eliminatedPlayerId: null,
      eliminatedRole:     null,
      voteCounts,
      isTie:              true,
      tiedPlayerIds:      tiedIds,
    };
  }

  // Clear winner — one player eliminated
  const eliminatedId     = tiedIds[0];
  const eliminatedPlayer = roundPlayers.find(p => p.playerId === eliminatedId);

  return {
    eliminatedPlayerId: eliminatedId,
    eliminatedRole:     eliminatedPlayer ? eliminatedPlayer.role : null,
    voteCounts,
    isTie:              false,
    tiedPlayerIds:      [],
  };
}

/**
 * Builds the full vote breakdown for the result broadcast.
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