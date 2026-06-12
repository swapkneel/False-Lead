// client/src/components/PlayerList.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Displays the list of players currently in the lobby.
//  Renders a host badge and highlights the current player (you).
// ─────────────────────────────────────────────────────────────────────────────

import { useGame } from '../context/GameContext';

/**
 * @param {object}   props
 * @param {object[]} props.players  — player list from lobby:updated
 */
export default function PlayerList({ players = [] }) {
  const { playerId } = useGame();

  if (players.length === 0) {
    return <p className="player-list-empty">Waiting for players to join…</p>;
  }

  return (
    <ul className="player-list">
      {players.map((player) => (
        <li
          key={player.id}
          className={`player-list-item ${player.id === playerId ? 'player-list-item--you' : ''}`}
        >
          <span className="player-name">{player.nickname}</span>

          <span className="player-badges">
            {player.isHost && (
              <span className="badge badge--host" title="Host">HOST</span>
            )}
            {player.id === playerId && (
              <span className="badge badge--you" title="You">YOU</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
