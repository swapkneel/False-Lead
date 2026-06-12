// client/src/services/socket.js
// ─────────────────────────────────────────────────────────────────────────────
//  Singleton Socket.IO client.
//
//  Why a singleton?
//    React components mount and unmount frequently. If each component
//    created its own socket, you'd end up with multiple connections for
//    the same player. One shared instance solves this.
//
//  Usage:
//    import socket from '../services/socket';
//    socket.emit('room:join', { sessionToken });
//    socket.on('lobby:updated', handler);
//    socket.off('lobby:updated', handler);   ← always clean up in useEffect
// ─────────────────────────────────────────────────────────────────────────────

import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

// autoConnect: false — we connect manually after the player has a session token.
// This prevents a race where the socket connects before we have credentials.
const socket = io(SOCKET_URL, {
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});

// ── Dev logging ─────────────────────────────────────────────────────────────
// Visible in the browser console during development only.
if (import.meta.env.DEV) {
  socket.onAny((event, ...args) => {
    console.log(`[socket ←] ${event}`, args);
  });

  socket.on('connect',    () => console.log('[socket] connected', socket.id));
  socket.on('disconnect', (reason) => console.log('[socket] disconnected', reason));
  socket.on('error',      (err)    => console.error('[socket] error', err));
}

export default socket;
