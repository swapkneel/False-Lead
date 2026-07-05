// client/src/services/socket.js
// ─────────────────────────────────────────────────────────────────────────────
//  Singleton Socket.IO client.
//
//  Why a singleton?
//    React components mount and unmount frequently. If each component
//    created its own socket, you'd end up with multiple connections for
//    the same player. One shared instance solves this.
//
//  Reconnect behaviour (M2.5 fix):
//    Socket.IO's automatic reconnection (reconnection: true) re-establishes
//    the transport and fires the 'connect' event without any React involvement.
//    Page-level useEffect reconnect guards use socket.once('connect', ...) 
//    which fires only on the initial mount connection and is gone by the time
//    a subsequent automatic reconnect fires.
//
//    Fix: a persistent 'connect' listener here reads the session token from
//    localStorage and emits room:join after every connection — initial or
//    automatic reconnect. This is the only place that guarantees room:join
//    fires regardless of which page is mounted or whether the socket was
//    already connected when a component mounted.
//
//    The server handles duplicate room:join idempotently (second emission
//    from Lobby's own onConnect handler is a no-op re-auth), so this does
//    not cause correctness issues.
//
//  Usage:
//    import socket from '../services/socket';
//    socket.emit('room:join', { sessionToken });
//    socket.on('lobby:updated', handler);
//    socket.off('lobby:updated', handler);   ← always clean up in useEffect
// ─────────────────────────────────────────────────────────────────────────────

import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

const STORAGE_KEY = 'falselead_session';

// autoConnect: false — we connect manually after the player has a session token.
// This prevents a race where the socket connects before we have credentials.
const socket = io(SOCKET_URL, {
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});

// ── Persistent reconnect handler ─────────────────────────────────────────────
//
// Emits room:join after every successful connection — both the initial connect
// and any subsequent automatic reconnect (e.g. DevTools Offline→Online, mobile
// network drop, brief server restart).
//
// Page-level effects use socket.once('connect', ...) which only fires once and
// cannot respond to automatic reconnects that happen while the component is
// already mounted. This listener fills that gap.
//
// Reads sessionToken directly from localStorage because this listener lives
// outside React and has no access to GameContext. GameContext already persists
// sessionToken to localStorage on every change, so this is always current.
socket.on('connect', () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const { sessionToken } = JSON.parse(raw);
    if (sessionToken) {
      socket.emit('room:join', { sessionToken });
    }
  } catch {
    // localStorage unavailable (private browsing restrictions, etc.)
  }
});

// ── Dev logging ─────────────────────────────────────────────────────────────
if (import.meta.env.DEV) {
  socket.onAny((event, ...args) => {
    console.log(`[socket ←] ${event}`, args);

    if (event === 'round:next') {
      sessionStorage.setItem('nextRoundInfo', JSON.stringify(args[0]));
    }
    if (event === 'game:finished') {
      sessionStorage.setItem('gameFinished', 'true');
    }
  });

  socket.on('connect',    () => console.log('[socket] connected', socket.id));
  socket.on('disconnect', (reason) => console.log('[socket] disconnected', reason));
  socket.on('error',      (err)    => console.error('[socket] error', err));
}

export default socket;