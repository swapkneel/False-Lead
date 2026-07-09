// client/src/components/RoomInfo.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Room code hero for the Briefing Room. This is the single largest element
//  on the Lobby screen by design — copy logic and props are unchanged from
//  the previous version, only the presentation.
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
    <div className="lobby-hero">
      <p className="eyebrow lobby-hero__eyebrow">Briefing Room</p>

      <div className="lobby-hero__code-row">
        <span className="lobby-hero__code">{roomCode}</span>
        <button
          className="lobby-hero__copy"
          onClick={handleCopy}
          aria-label="Copy room code to clipboard"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <p className="lobby-hero__meta">
        <span className="lobby-hero__meta-status">{status}</span>
        <span className="lobby-hero__meta-dot" aria-hidden="true">·</span>
        <span>{playerCount} {playerCount === 1 ? 'player' : 'players'}</span>
      </p>
    </div>
  );
}