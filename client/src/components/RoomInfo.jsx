// client/src/components/RoomInfo.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Displays the room code (large, copyable) and current room status.
//  Used in the lobby header so players can share the code easily.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';

/**
 * @param {object} props
 * @param {string} props.roomCode
 * @param {string} props.status
 * @param {number} props.playerCount
 */
export default function RoomInfo({ roomCode, status, playerCount }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(roomCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="room-info">
      <p className="room-info-label">Room Code</p>

      <div className="room-code-row">
        <span className="room-code">{roomCode}</span>
        <button
          className="btn btn--ghost btn--sm"
          onClick={handleCopy}
          title="Copy room code"
          aria-label="Copy room code to clipboard"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      <p className="room-info-meta">
        <span className="room-status">{status}</span>
        <span className="room-dot" aria-hidden="true"> · </span>
        <span className="room-player-count">
          {playerCount} {playerCount === 1 ? 'player' : 'players'}
        </span>
      </p>
    </div>
  );
}
