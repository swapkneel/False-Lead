// client/src/pages/Lobby.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Lobby page — "Briefing Room."
//
//  Presentation pass: root wrapper now carries the shared `.screen-transition`
//  class (see SHARED SCREEN TRANSITION in index.css) — same fade/slide/scale
//  entrance used across every gameplay screen. No other change.
//
//  v2 fixes the host-view layout regression: the action zone is no longer
//  position: fixed. It previously relied on a single hardcoded bottom
//  padding value on .lobby-page to clear a fixed bar, but the host's action
//  cluster (hint + Start Game + Leave) is taller than the non-host cluster
//  (hint + Leave), so the fixed bar overlapped the roster for hosts. The
//  page is now one flex column: a top group (room code hero + roster) and
//  a bottom group pushed down by margin-top: auto, so the gap between them
//  is real, safe negative space regardless of which cluster renders.
//
//  All socket wiring, state shape (lobbyPlayers from GameContext), and the
//  start/leave handlers are unchanged from the previous version.
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
    sessionToken, roomCode, isHost,
    lobbyPlayers,
    roomStatus,
    updateLobby, setPhase, setIsHost, resetSession,
  } = useGame();

  const { toasts, addToast } = useToast();
  const [socketError, setSocketError] = useState('');
  const [starting,    setStarting]    = useState(false);

  useEffect(() => {
    if (!sessionToken || !roomCode) navigate('/', { replace: true });
  }, [sessionToken, roomCode, navigate]);

  useEffect(() => {
    if (!sessionToken || !roomCode) return;

    if (!socket.connected) socket.connect();

    function onConnect()          { socket.emit('room:join', { sessionToken }); }
    function onLobbyUpdated(data) { updateLobby({ players: data.players, status: data.status }); }
    function onGameStarting()     { setStarting(false); setPhase('round'); navigate('/game'); }
    function onHostPromoted(data) { setIsHost(true); addToast(data.message || 'You are now the host.', 'info'); }
    function onPlayerDisconnected({ nickname }) { addToast(`${nickname} disconnected`, 'warning'); }
    function onPlayerReconnected({ nickname })  { addToast(`${nickname} reconnected`, 'success'); }
    function onPlayerRemoved({ nickname })      { addToast(`${nickname} was removed from the room`, 'info'); }
    function onError(err) { console.error('[lobby] socket error', err); setSocketError(err.message || 'Connection error. Please refresh.'); }

    if (socket.connected) socket.emit('room:join', { sessionToken });

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

  function handleStartGame() {
    if (!isHost) return;
    const onlineCount = lobbyPlayers.filter(p => p.isOnline !== false).length;
    if (onlineCount < 3) { setSocketError('Need at least 3 connected players to start.'); return; }
    setSocketError('');
    setStarting(true);
    socket.emit('game:start');
  }

  function handleLeave() {
    socket.emit('room:leave');
    resetSession();
    navigate('/');
  }

  const onlineCount  = lobbyPlayers.filter(p => p.isOnline !== false).length;
  const offlineCount = lobbyPlayers.filter(p => p.isOnline === false).length;

  return (
    <div className="lobby-page screen-transition">
      <ToastContainer toasts={toasts} />

      <div className="lobby-top">
        <RoomInfo roomCode={roomCode} status={roomStatus || 'waiting'} playerCount={onlineCount} />

        <section className="lobby-roster">
          <div className="lobby-roster__header">
            <span className="lobby-roster__title">Investigators · {onlineCount}</span>
            {offlineCount > 0 && (
              <span className="lobby-roster__offline-note">{offlineCount} offline</span>
            )}
          </div>

          <PlayerList players={lobbyPlayers} />
        </section>

        {socketError && <p className="form-error" role="alert">{socketError}</p>}
      </div>

      <div className="lobby-bottom">
        {isHost ? (
          <>
            <p className="lobby-bottom__hint">
              {onlineCount < 3 ? 'Waiting for at least 3 connected players…' : 'Everyone accounted for.'}
            </p>
            <button
              className="btn-game"
              onClick={handleStartGame}
              disabled={starting || onlineCount < 3}
            >
              {starting ? 'Starting…' : 'Begin Investigation'}
              {!starting && <span className="btn-game__arrow" aria-hidden="true">→</span>}
            </button>
          </>
        ) : (
          <p className="lobby-bottom__hint">Waiting for the host to begin…</p>
        )}

        <button className="text-action" onClick={handleLeave}>
          Leave Room
        </button>
      </div>
    </div>
  );
}