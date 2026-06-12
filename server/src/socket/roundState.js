// server/src/socket/roundState.js
// ─────────────────────────────────────────────────────────────────────────────
//  Shared in-memory state for the active voting phase.
//
//  Why in-memory instead of the DB?
//    Ready-state and vote-timer are transient. They exist only while a round
//    is live and have no value after the round resolves. Storing them in MySQL
//    would add latency to every ready/vote event with zero benefit.
//    The DB is written once — when the round ends — in a single flush.
//
//  Structure per room:
//  roundState.get(roomCode) → {
//    roundId:       number,
//    readyPlayers:  Set<playerId>,
//    votes:         Map<voterId, targetId>,
//    totalPlayers:  number,
//    voteTimer:     NodeJS.Timeout | null,
//    phase:         'discussion' | 'voting' | 'results'
//  }
//
//  Lifecycle:
//    Created  → when round:start fires (gameHandlers calls initRoundState)
//    Updated  → as players mark ready and cast votes
//    Deleted  → when round:result is broadcast (cleanup call)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// One Map entry per active room. Keyed by roomCode (string).
const roundState = new Map();

/**
 * Initialise state for a new round.
 * Called by gameHandlers immediately after round creation.
 *
 * @param {string} roomCode
 * @param {number} roundId
 * @param {number} totalPlayers
 */
function initRoundState(roomCode, roundId, totalPlayers) {
  // Clear any stale state from a previous round
  clearRoundState(roomCode);

  roundState.set(roomCode, {
    roundId,
    readyPlayers: new Set(),
    votes:        new Map(),
    totalPlayers,
    voteTimer:    null,
    phase:        'discussion',
  });
}

/**
 * Returns the current round state for a room, or null if not found.
 *
 * @param {string} roomCode
 * @returns {object|null}
 */
function getRoundState(roomCode) {
  return roundState.get(roomCode) || null;
}

/**
 * Clears state for a room (called after results are broadcast).
 * Cancels any running timer to prevent memory leaks.
 *
 * @param {string} roomCode
 */
function clearRoundState(roomCode) {
  const state = roundState.get(roomCode);
  if (state && state.voteTimer) {
    clearTimeout(state.voteTimer);
  }
  roundState.delete(roomCode);
}

module.exports = { initRoundState, getRoundState, clearRoundState };
