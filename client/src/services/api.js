// client/src/services/api.js
// ─────────────────────────────────────────────────────────────────────────────
//  Reusable API functions for all backend REST calls.
//
//  Design decisions:
//    - BASE_URL reads from Vite env so it works in dev and prod without
//      code changes. Set VITE_API_URL in your .env file.
//    - Every function throws a plain Error with a human-readable message
//      so callers (pages/components) only need to catch, not parse.
//    - No Axios — the native fetch API is sufficient for this project.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

/**
 * Internal helper. Sends a JSON request and returns parsed data.
 * Throws an Error with the server's error message if success !== true.
 *
 * @param {string} path         — e.g. '/rooms'
 * @param {object} [options]    — fetch options (method, body, etc.)
 * @returns {Promise<object>}   — the full parsed response body
 */
async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const data = await res.json();

  if (!data.success) {
    throw new Error(data.error || 'An unexpected error occurred');
  }

  return data;
}

// ─────────────────────────────────────────────
//  Room endpoints
// ─────────────────────────────────────────────

/**
 * Creates a new room. The caller becomes the host.
 *
 * @param {object} params
 * @param {string}  params.hostSessionId  — UUID generated client-side
 * @param {string}  [params.preset]       — 'classic' | 'party' | 'custom'
 * @param {number}  [params.totalRounds]
 * @param {object}  [params.settings]
 *
 * @returns {Promise<{ success: true, roomCode: string }>}
 */
export async function createRoom({ hostSessionId, preset, totalRounds, settings }) {
  return request('/rooms', {
    method: 'POST',
    body: JSON.stringify({ hostSessionId, preset, totalRounds, settings }),
  });
}

/**
 * Joins an existing room with a nickname.
 *
 * @param {object} params
 * @param {string}  params.roomCode
 * @param {string}  params.nickname
 *
 * @returns {Promise<{ success: true, playerId: number, sessionToken: string, roomCode: string }>}
 */
export async function joinRoom({ roomCode, nickname }) {
  return request('/rooms/join', {
    method: 'POST',
    body: JSON.stringify({ roomCode, nickname }),
  });
}

/**
 * Fetches current room state including player list.
 *
 * @param {string} roomCode
 *
 * @returns {Promise<{ success: true, room: object }>}
 */
export async function getRoom(roomCode) {
  return request(`/rooms/${roomCode}`);
}
