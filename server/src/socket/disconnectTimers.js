// server/src/socket/disconnectTimers.js
// ─────────────────────────────────────────────────────────────────────────────
//  In-memory registry of pending disconnect timers.
//
//  When a player's socket drops we don't remove them immediately — we give
//  them a grace period (DISCONNECT_GRACE_MS) to reconnect.  This map holds
//  the pending timeout handle plus the context needed to do the cleanup if
//  the timer fires.
//
//  Structure:
//    disconnectTimers.get(playerId) → {
//      timer:    NodeJS.Timeout,
//      roomId:   number,
//      roomCode: string,
//      nickname: string,
//      isHost:   boolean,
//    }
//
//  Lifecycle:
//    Set     → handleDeparture (disconnect path) in lobbyHandlers
//    Cleared → room:join (player reconnects within grace window)
//              OR timer fires (grace period expires → permanent removal)
//
//  Kept in a separate module so both lobbyHandlers and voteHandlers can
//  import it without circular dependencies.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

/**
 * How long a disconnected player's seat is held before permanent removal.
 * Does not pause or delay gameplay in any way — purely a seat reservation.
 */
const DISCONNECT_GRACE_MS = 300_000; // 5 minutes

/**
 * One entry per player currently in their grace window.
 * Keyed by playerId (number).
 */
const disconnectTimers = new Map();

module.exports = { disconnectTimers, DISCONNECT_GRACE_MS };