// client/src/pages/Lobby.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Lobby page.
//
//  M2 additions:
//    - Listens for player:disconnected, player:reconnected, player:removed,
//      host:promoted and shows toasts for each.
//    - PlayerList now receives players with isOnline flag — offline players
//      are rendered with a visual indicator.
//    - setIsHost called on host:promoted so the host controls appear
//      immediately for the newly promoted player.
//    - Start Game button counts only online players (players with isOnline).
//
//  All pre-existing behaviour is preserved unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useNavigate }         from 'react-router-dom';
import { useGame }             from '../context/GameContext';
import socket                  from '../services/socket';
import PlayerList              from '../components/PlayerList';
import RoomInfo                from '../components/RoomInfo';
import { useToast, ToastContainer } from '../components/Toast';

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
    setIsHost,
    resetSession,
  } = useGame();

  const { toasts, addToast } = useToast();

  const [socketError, setSocketError] = useState('');
  const [starting,    setStarting]    = useState(false);

  // ── Redirect if no session ───────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken || !roomCode) {
      navigate('/', { replace: true });
    }
  }, [sessionToken, roomCode, navigate]);

  // ── Socket lifecycle ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken || !roomCode) return;

    if (!socket.connected) {
      socket.connect();
    }

    function onConnect() {
      socket.emit('room:join', { sessionToken });
    }

    function onLobbyUpdated(data) {
      updateLobby({ players: data.players, status: data.status });
    }

    function onGameStarting() {
      setStarting(false);
      setPhase('round');
      navigate('/game');
    }

    function onHostPromoted(data) {
      setIsHost(true);
      addToast(data.message || 'You are now the host.', 'info');
    }

    // ── M2: reconnect/disconnect toasts ──────────────────────────────
    function onPlayerDisconnected({ nickname }) {
      addToast(`${nickname} disconnected`, 'warning');
    }

    function onPlayerReconnected({ nickname }) {
      addToast(`${nickname} reconnected`, 'success');
    }

    function onPlayerRemoved({ nickname }) {
      addToast(`${nickname} was removed from the room`, 'info');
    }

    function onError(err) {
      console.error('[lobby] socket error', err);
      setSocketError(err.message || 'Connection error. Please refresh.');
    }

    if (socket.connected) {
      socket.emit('room:join', { sessionToken });
    }

    socket.on('connect',            onConnect);
    socket.on('lobby:updated',      onLobbyUpdated);
    socket.on('game:starting',      onGameStarting);
    socket.on('host:promoted',      onHostPromoted);
    socket.on('player:disconnected', onPlayerDisconnected);
    socket.on('player:reconnected',  onPlayerReconnected);
    socket.on('player:removed',      onPlayerRemoved);
    socket.on('error',              onError);

    return () => {
      socket.off('connect',            onConnect);
      socket.off('lobby:updated',      onLobbyUpdated);
      socket.off('game:starting',      onGameStarting);
      socket.off('host:promoted',      onHostPromoted);
      socket.off('player:disconnected', onPlayerDisconnected);
      socket.off('player:reconnected',  onPlayerReconnected);
      socket.off('player:removed',      onPlayerRemoved);
      socket.off('error',              onError);
    };
  }, [sessionToken, roomCode, updateLobby, setPhase, setIsHost, navigate, addToast]);

  // ── Actions ──────────────────────────────────────────────────────────────

  function handleStartGame() {
    if (!isHost) return;
    // Count only online players — offline seats are reserved but can't play
    const onlineCount = players.filter(p => p.isOnline !== false).length;
    if (onlineCount < 3) {
      setSocketError('Need at least 3 connected players to start.');
      return;
    }
    setSocketError('');
    setStarting(true);
    socket.emit('game:start');
  }

  function handleLeave() {
    socket.emit('room:leave');
    resetSession();
    navigate('/');
  }

  // ── Derived ──────────────────────────────────────────────────────────────

  const onlineCount  = players.filter(p => p.isOnline !== false).length;
  const offlineCount = players.filter(p => p.isOnline === false).length;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="lobby-page">
      <ToastContainer toasts={toasts} />

      <header className="lobby-header">
        <RoomInfo
          roomCode={roomCode}
          status={roomStatus || 'waiting'}
          playerCount={onlineCount}
        />
      </header>

      <main className="lobby-main">
        <section className="lobby-players">
          <h2 className="section-title">
            Players{' '}
            <span className="player-count-badge">{onlineCount}</span>
            {offlineCount > 0 && (
              <span className="player-offline-badge">
                {offlineCount} offline
              </span>
            )}
          </h2>
          {/* PlayerList receives players with isOnline — it renders the
              offline indicator if isOnline === false */}
          <PlayerList players={players} />
        </section>

        {socketError && (
          <p className="form-error" role="alert">{socketError}</p>
        )}

        <section className="lobby-actions">
          {isHost ? (
            <>
              <p className="lobby-host-hint">
                {onlineCount < 3
                  ? 'Waiting for at least 3 connected players…'
                  : 'Everyone ready? Start the game.'}
              </p>
              <button
                className="btn btn--primary btn--full"
                onClick={handleStartGame}
                disabled={starting || onlineCount < 3}
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
