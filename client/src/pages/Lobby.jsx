// client/src/pages/Lobby.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Lobby page. Everything that happens before the game starts.
//
//  On mount:
//    1. Connect the socket (if not connected)
//    2. Emit room:join with the session token
//    3. Listen for lobby:updated → update player list in context
//    4. Listen for game:starting → navigate to /game (future route)
//
//  On unmount:
//    - Remove all listeners added here (critical — prevents memory leaks
//      and duplicate handlers if the component remounts)
//
//  The socket connection stays alive across navigation because it's a
//  singleton. Only the event listeners are added/removed per component.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useNavigate }         from 'react-router-dom';
import { useGame }             from '../context/GameContext';
import socket                  from '../services/socket';
import PlayerList              from '../components/PlayerList';
import RoomInfo                from '../components/RoomInfo';

export default function Lobby() {
  const navigate = useNavigate();
  const {
    sessionToken,
    roomCode,
    isHost,
    players,
    roomStatus,
    updateLobby,
    setPhase,
    resetSession,
  } = useGame();

  const [socketError, setSocketError] = useState('');
  const [starting,    setStarting]    = useState(false);

  // ── Redirect if no session ───────────────────────────────────────────────
  // Handles someone navigating directly to /lobby without a session
  useEffect(() => {
    if (!sessionToken || !roomCode) {
      navigate('/', { replace: true });
    }
  }, [sessionToken, roomCode, navigate]);

  // ── Socket lifecycle ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken || !roomCode) return;

    // ── Connect and authenticate ───────────────────────────────────────
    if (!socket.connected) {
      socket.connect();
    }

    function onConnect() {
      // Authenticate into the room immediately after connecting (or reconnecting)
      socket.emit('room:join', { sessionToken });
    }

    function onLobbyUpdated(data) {
      // data: { roomCode, status, preset, totalRounds, settings, playerCount, players }
      updateLobby({ players: data.players, status: data.status });
    }

    function onGameStarting() {

    
      // Server confirmed game is starting — move to round phase
      setStarting(false);
      setPhase('round');
      navigate('/game');   // /game route will be built in the next phase
    }

    function onHostPromoted(data) {
      // This socket's player was just promoted to host
      // The context isHost flag will update via the next lobby:updated broadcast
      console.log('[lobby] Promoted to host:', data.message);
    }

    function onError(err) {
      console.error('[lobby] socket error', err);
      setSocketError(err.message || 'Connection error. Please refresh.');
    }

    // If already connected, authenticate immediately
    if (socket.connected) {
      socket.emit('room:join', { sessionToken });
    }

    // Register all listeners
    socket.on('connect',        onConnect);
    socket.on('lobby:updated',  onLobbyUpdated);
    socket.on('game:starting',  onGameStarting);
    socket.on('host:promoted',  onHostPromoted);
    socket.on('error',          onError);

    // ── Cleanup — always remove the exact functions we added ──────────
    return () => {
      socket.off('connect',       onConnect);
      socket.off('lobby:updated', onLobbyUpdated);
      socket.off('game:starting', onGameStarting);
      socket.off('host:promoted', onHostPromoted);
      socket.off('error',         onError);
    };
  }, [sessionToken, roomCode, updateLobby, setPhase, navigate]);

  // ── Host: start game ─────────────────────────────────────────────────────
  function handleStartGame() {
    if (!isHost) return;
    if (players.length < 2) {
      setSocketError('Need at least 2 players to start.');
      return;
    }
    setSocketError('');
    setStarting(true);
    socket.emit('game:start');
  }

  // ── Host: force vote start ───────────────────────────────────────────────
  function handleLeave() {
    socket.emit('room:leave');
    resetSession();
    navigate('/');
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="lobby-page">
      <header className="lobby-header">
        <RoomInfo
          roomCode={roomCode}
          status={roomStatus || 'waiting'}
          playerCount={players.length}
        />
      </header>

      <main className="lobby-main">
        <section className="lobby-players">
          <h2 className="section-title">
            Players <span className="player-count-badge">{players.length}</span>
          </h2>
          <PlayerList players={players} />
        </section>

        {socketError && (
          <p className="form-error" role="alert">{socketError}</p>
        )}

        <section className="lobby-actions">
          {isHost ? (
            <>
              <p className="lobby-host-hint">
                {players.length < 2
                  ? 'Waiting for at least one more player…'
                  : 'Everyone ready? Start the game.'}
              </p>
              <button
                className="btn btn--primary btn--full"
                onClick={handleStartGame}
                disabled={starting || players.length < 2}
              >
                {starting ? 'Starting…' : 'Start Game'}
              </button>
            </>
          ) : (
            <p className="lobby-waiting-hint">
              Waiting for the host to start the game…
            </p>
          )}

          <button
            className="btn btn--ghost btn--full"
            onClick={handleLeave}
          >
            Leave Room
          </button>
        </section>
      </main>
    </div>
  );
}
