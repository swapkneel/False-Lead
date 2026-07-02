// client/src/components/PlayerList.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Displays the list of players currently in the lobby.
//  Renders a host badge and highlights the current player (you).
//
//  M2 change:
//    - Players with isOnline === false receive the player-list-item--offline
//      class and an OFFLINE badge.
//    - No other behaviour changes.
// ─────────────────────────────────────────────────────────────────────────────

import { useGame } from '../context/GameContext';

/**
 * @param {object}   props
 * @param {object[]} props.players  — player list from lobby:updated
 *                                    each player may carry isOnline: boolean (M2)
 */
export default function PlayerList({ players = [] }) {
  const { playerId } = useGame();

  if (players.length === 0) {
    return <p className="player-list-empty">Waiting for players to join…</p>;
  }

  return (
    <ul className="player-list">
      {players.map((player) => {
        const isOffline = player.isOnline === false;

        return (
          <li
            key={player.id}
            className={[
              'player-list-item',
              player.id === playerId ? 'player-list-item--you'     : '',
              isOffline              ? 'player-list-item--offline'  : '',
            ].join(' ').trim()}
          >
            <span className="player-name">{player.nickname}</span>

            <span className="player-badges">
              {player.isHost && (
                <span className="badge badge--host" title="Host">HOST</span>
              )}
              {player.id === playerId && (
                <span className="badge badge--you" title="You">YOU</span>
              )}
              {isOffline && (
                <span className="player-offline-tag">OFFLINE</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
