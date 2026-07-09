// client/src/components/PlayerList.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Displays the player roster in the Briefing Room.
//
//  No avatar/monogram circles — this game has no profile pictures.
//  Distinction between players comes from typography, badges, and a real
//  card treatment per row (surface + border + left accent), not from a
//  bare list floating on the background. Behavior and props unchanged:
//    - isOnline === false → dimmed row + OFFLINE tag
//    - a brief brass flash marks host-transfer / online-offline flips
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { useGame } from '../context/GameContext';

/**
 * @param {object}   props
 * @param {object[]} props.players — player list from lobby:updated
 *                                   each player may carry isOnline: boolean
 */
export default function PlayerList({ players = [] }) {
  const { playerId } = useGame();
  const prevRef = useRef(new Map());
  const [flashIds, setFlashIds] = useState(() => new Set());

  // Detect host-transfer / online-offline flips since the last render and
  // give those rows a brief brass flash instead of a silent hard cut.
  useEffect(() => {
    const prev = prevRef.current;
    const changed = new Set();

    players.forEach((p) => {
      const prior = prev.get(p.id);
      if (prior && (prior.isHost !== p.isHost || prior.isOnline !== p.isOnline)) {
        changed.add(p.id);
      }
    });

    if (changed.size > 0) {
      setFlashIds(changed);
      const t = setTimeout(() => setFlashIds(new Set()), 900);
      prev.clear();
      players.forEach((p) => prev.set(p.id, { isHost: p.isHost, isOnline: p.isOnline }));
      return () => clearTimeout(t);
    }

    prev.clear();
    players.forEach((p) => prev.set(p.id, { isHost: p.isHost, isOnline: p.isOnline }));
  }, [players]);

  if (players.length === 0) {
    return <p className="roster-empty">Waiting for players to join…</p>;
  }

  return (
    <ul className="roster-list">
      {players.map((player) => {
        const isOffline = player.isOnline === false;
        const isYou     = player.id === playerId;
        const isChanged = flashIds.has(player.id);

        return (
          <li
            key={player.id}
            className={[
              'roster-row',
              player.isHost ? 'roster-row--host'    : '',
              isYou         ? 'roster-row--you'     : '',
              isOffline     ? 'roster-row--offline' : '',
              isChanged     ? 'roster-row--changed' : '',
            ].join(' ').trim()}
          >
            <span className="roster-row__name">{player.nickname}</span>

            <span className="roster-row__tags">
              {player.isHost && <span className="roster-tag roster-tag--host">Host</span>}
              {isYou         && <span className="roster-tag roster-tag--you">You</span>}
              {isOffline     && <span className="roster-tag roster-tag--offline">Offline</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}