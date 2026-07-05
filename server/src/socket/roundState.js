// server/src/socket/roundState.js
// ─────────────────────────────────────────────────────────────────────────────
//  Shared in-memory state for the active voting phase.
//
//  M2.5/M3 addition — roundPlayerIds:
//    A Set of every playerId that has a round_players row for this round.
//    Set once at initRoundState time from the round's DB assignments and
//    never mutated. Used as the single authoritative source for:
//      - vote target eligibility  (is this target in the round?)
//      - voter eligibility        (is this voter in the round?)
//      - vote completion check    (online players ∩ roundPlayerIds)
//      - ready-check denominator  (online players ∩ roundPlayerIds)
//    Replaces ad-hoc DB queries and raw socket-room membership checks that
//    previously gave different answers depending on call site.
//
//  Structure per room:
//  roundState.get(roomCode) → {
//    roundId:         number,
//    roundPlayerIds:  Set<playerId>,          ← M2.5/M3 addition
//    readyPlayers:    Set<playerId>,
//    votes:           Map<voterId, targetId[]>,
//    totalPlayers:    number,                 ← roster size (= roundPlayerIds.size)
//    imposterCount:   number,
//    voteTimer:       NodeJS.Timeout | null,
//    tickInterval:    NodeJS.Timeout | null,
//    phase:           'discussion' | 'voting' | 'results'
//  }
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const roundState = new Map();

/**
 * Initialise state for a new round.
 *
 * @param {string}   roomCode
 * @param {number}   roundId
 * @param {number[]} playerIds      — all playerIds in round_players for this round
 * @param {number}   [imposterCount=1]
 */
function initRoundState(roomCode, roundId, playerIds, imposterCount = 1) {
  clearRoundState(roomCode);

  roundState.set(roomCode, {
    roundId,
    roundPlayerIds: new Set(playerIds),   // authoritative round membership
    readyPlayers:   new Set(),
    votes:          new Map(),
    totalPlayers:   playerIds.length,     // convenience alias
    imposterCount,
    voteTimer:      null,
    tickInterval:   null,
    phase:          'discussion',
  });
}

/**
 * @param {string} roomCode
 * @returns {object|null}
 */
function getRoundState(roomCode) {
  return roundState.get(roomCode) || null;
}

/**
 * Clears state for a room. Cancels any running timers.
 * @param {string} roomCode
 */
function clearRoundState(roomCode) {
  const state = roundState.get(roomCode);
  if (state) {
    if (state.voteTimer)    clearTimeout(state.voteTimer);
    if (state.tickInterval) clearInterval(state.tickInterval);
  }
  roundState.delete(roomCode);
}

module.exports = { initRoundState, getRoundState, clearRoundState };