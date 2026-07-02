// server/src/socket/disconnectTimers.js
// ─────────────────────────────────────────────────────────────────────────────
//  In-memory registries of pending disconnect timers.
//
//  Two SEPARATE timers now exist per disconnecting player:
//
//  1. Seat-reservation timer (disconnectTimers, DISCONNECT_GRACE_MS = 5 min)
//     Controls how long a player's seat (and round participation) is held
//     before permanent removal. Does not affect host status by itself.
//
//  2. Host-transfer timer (hostTransferTimers, HOST_TRANSFER_GRACE_MS = 30s)
//     ONLY created when the disconnecting player is the host. Controls how
//     long the room waits before promoting a new host. Much shorter than
//     the seat timer because an absent host blocks game-progressing actions
//     (starting rounds, settings changes) for everyone, whereas a regular
//     disconnected player does not block anything thanks to the auto-ready
//     and online-only vote-completion logic.
//
//     If the original host reconnects before 30s, this timer is cancelled
//     and they keep their host status — their SEAT timer (5 min) is also
//     cancelled by the same reconnect, independently.
//
//     If 30s elapses and the host has not reconnected, a new host is
//     promoted — but the original (still-offline) player's SEAT remains
//     reserved for the full 5 minutes. They keep playing as a regular
//     (non-host) player if they reconnect within that window.
//
//  Both maps are keyed by playerId (number) and live in module scope so
//  lobbyHandlers and voteHandlers can share them without circular deps.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

/** How long a disconnected player's seat is held before permanent removal. */
const DISCONNECT_GRACE_MS = 300_000; // 5 minutes

/** How long the room waits before transferring host status away from a
 *  disconnected host. Independent of the seat-reservation timer above. */
const HOST_TRANSFER_GRACE_MS = 30_000; // 30 seconds

/** One entry per player currently in their seat-reservation grace window. */
const disconnectTimers = new Map();

/** One entry per disconnected HOST currently in their host-transfer window.
 *  Only ever has entries for players who were host at disconnect time. */
const hostTransferTimers = new Map();

module.exports = {
  disconnectTimers,
  DISCONNECT_GRACE_MS,
  hostTransferTimers,
  HOST_TRANSFER_GRACE_MS,
};