// client/src/pages/Voting.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Voting Screen — "Submit Your Verdict"
//
//  Regression fix (post-M2 reconnect testing):
//    round:rejoin now carries a `players` array (the round's roster with
//    isOnline flags). Voting.jsx previously only read `players` from
//    GameContext, which could be empty if the player reconnected directly
//    into /voting without passing through /lobby first — resulting in an
//    empty suspect grid. The rejoin handler now calls updateLobby with the
//    rejoin payload's players as a fallback whenever it's non-empty, so the
//    grid always has data to render regardless of how the player arrived.
//
//  All pre-existing multi-vote behaviour, the room:join reconnect-guard fix,
//  and the offline-tag rendering are preserved unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react';
import { useNavigate }                       from 'react-router-dom';
import { useGame }                           from '../context/GameContext';
import socket                                from '../services/socket';
import { useToast, ToastContainer }          from '../components/Toast';

// ── SuspectCard ──────────────────────────────────────────────────────────────

function SuspectCard({ player, isSelected, isMe, isSubmitted, isDisabled, onSelect }) {
  const disabled = isMe || isSubmitted || isDisabled;

  return (
    <button
      className={[
        'suspect-card',
        isSelected                 ? 'suspect-card--selected' : '',
        isMe                       ? 'suspect-card--you'      : '',
        isSubmitted && !isSelected ? 'suspect-card--dim'      : '',
        isDisabled  && !isSelected ? 'suspect-card--dim'      : '',
      ].join(' ').trim()}
      onClick={() => !disabled && onSelect(player.id)}
      disabled={disabled}
      aria-pressed={isSelected}
      aria-label={
        isMe
          ? `${player.nickname} (you — cannot vote for yourself)`
          : `Vote for ${player.nickname}`
      }
    >
      <div className="suspect-card__inner">
        <span className="suspect-card__num" aria-hidden="true">
          {String(player.id).slice(-2).padStart(2, '0')}
        </span>
        <span className="suspect-card__name">{player.nickname}</span>
        <div className="suspect-card__tags">
          {isMe && <span className="suspect-tag suspect-tag--you">YOU</span>}
          {isSelected && !isMe && (
            <span className="suspect-tag suspect-tag--selected">SELECTED</span>
          )}
          {player.isOnline === false && (
            <span className="suspect-tag suspect-tag--offline">OFFLINE</span>
          )}
        </div>
      </div>
      {isSelected && <div className="suspect-card__bar" aria-hidden="true" />}
    </button>
  );
}

// ── CountdownTimer ───────────────────────────────────────────────────────────

function CountdownTimer({ secondsLeft }) {
  const TOTAL  = 30;
  const pct    = Math.max(0, secondsLeft / TOTAL);
  const urgent = secondsLeft <= 10;

  return (
    <div className={`vote-timer ${urgent ? 'vote-timer--urgent' : ''}`}>
      <svg className="vote-timer__ring" viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="20" className="vote-timer__track" />
        <circle
          cx="24" cy="24" r="20"
          className="vote-timer__fill"
          style={{
            strokeDasharray:  `${2 * Math.PI * 20}`,
            strokeDashoffset: `${2 * Math.PI * 20 * (1 - pct)}`,
          }}
        />
      </svg>
      <span className="vote-timer__label">{secondsLeft}</span>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Voting() {
  const navigate = useNavigate();
  const {
    sessionToken, roomCode, playerId, roundData, players,
    setPhase, setRoundData, setIsHost, updateLobby,
  } = useGame();

  const { toasts, addToast } = useToast();

  const imposterCount = roundData?.imposterCount ?? 1;

  const [selectedIds,  setSelectedIds]  = useState([]);
  const [submitted,    setSubmitted]    = useState(false);
  const [secondsLeft,  setSecondsLeft]  = useState(30);
  const [socketError,  setSocketError]  = useState('');

  const category    = roundData?.category    ?? '';
  const roundNumber = roundData?.roundNumber ?? '';

  // ── Redirect guard ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken || !roomCode) navigate('/', { replace: true });
  }, [sessionToken, roomCode, navigate]);

  // ── Socket reconnect guard ─────────────────────────────────────────────
  // Only emit room:join when the socket was actually disconnected.
  useEffect(() => {
    if (!sessionToken) return;

    if (!socket.connected) {
      function joinRoom() {
        socket.emit('room:join', { sessionToken });
      }
      socket.connect();
      socket.once('connect', joinRoom);
      return () => {
        socket.off('connect', joinRoom);
      };
    }
  }, [sessionToken]);

  // ── Reset selection on round change ───────────────────────────────────
  useEffect(() => {
    setSelectedIds([]);
    setSubmitted(false);
    setSocketError('');
  }, [roundData?.roundId]);

  // ── Socket listeners ───────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken) return;

    function onTimer(data) {
      setSecondsLeft(data.secondsRemaining);
    }

    function onResult(data) {
      sessionStorage.setItem('lastRoundResult', JSON.stringify(data));
      setPhase('results');
      navigate('/result');
    }

    function onError(err) {
      setSocketError(err.message || 'Something went wrong.');
    }

    // Authoritative rejoin — only fires after a true reconnect.
    function onRoundRejoin(data) {
      setRoundData({
        roundId:       data.roundId,
        roundNumber:   data.roundNumber,
        totalRounds:   data.totalRounds,
        roundType:     data.roundType,
        imposterCount: data.imposterCount,
        clueOrder:     data.clueOrder,
        role:          data.role,
        receivedInfo:  data.receivedInfo,
        myClueOrder:   data.myClueOrder,
      });

      // ── Fix: fallback player roster for the suspect grid ─────────────
      // If the rejoin payload includes a player roster, merge it into
      // context so the grid renders immediately even if lobby:updated
      // hasn't arrived yet (e.g. reconnecting directly into /voting).
      if (Array.isArray(data.players) && data.players.length > 0) {
        updateLobby({ players: data.players });
      }

      if (data.hasVoted) setSubmitted(true);

      switch (data.phase) {
        case 'discussion':
          setPhase('round');
          navigate('/game', { replace: true });
          break;
        case 'results':
        case 'waiting':
          setPhase('results');
          navigate('/result', { replace: true });
          break;
        case 'voting':
        default:
          break;
      }
    }

    function onPlayerDisconnected({ nickname }) { addToast(`${nickname} disconnected`, 'warning'); }
    function onPlayerReconnected({ nickname })  { addToast(`${nickname} reconnected`, 'success'); }
    function onPlayerRemoved({ nickname })      { addToast(`${nickname} was removed from the room`, 'info'); }
    function onHostPromoted(data) {
      setIsHost(true);
      addToast(data.message || 'You are now the host.', 'info');
    }

    // ── Keep player roster fresh during voting too ──────────────────────
    // Voting.jsx previously never listened for lobby:updated at all.
    // Without this, a disconnect/reconnect mid-vote would never update the
    // offline tags on suspect cards or remove a permanently-removed player
    // from the grid.
    function onLobbyUpdated(data) {
      updateLobby({ players: data.players, status: data.status });
    }

    socket.on('vote:timer',          onTimer);
    socket.on('round:result',        onResult);
    socket.on('round:rejoin',        onRoundRejoin);
    socket.on('lobby:updated',       onLobbyUpdated);
    socket.on('player:disconnected', onPlayerDisconnected);
    socket.on('player:reconnected',  onPlayerReconnected);
    socket.on('player:removed',      onPlayerRemoved);
    socket.on('host:promoted',       onHostPromoted);
    socket.on('error',               onError);

    return () => {
      socket.off('vote:timer',          onTimer);
      socket.off('round:result',        onResult);
      socket.off('round:rejoin',        onRoundRejoin);
      socket.off('lobby:updated',       onLobbyUpdated);
      socket.off('player:disconnected', onPlayerDisconnected);
      socket.off('player:reconnected',  onPlayerReconnected);
      socket.off('player:removed',      onPlayerRemoved);
      socket.off('host:promoted',       onHostPromoted);
      socket.off('error',               onError);
    };
  }, [sessionToken, setPhase, setRoundData, setIsHost, updateLobby, navigate, addToast]);

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleSelect = useCallback((targetId) => {
    if (submitted) return;
    setSocketError('');
    setSelectedIds(prev => {
      if (prev.includes(targetId)) return prev.filter(id => id !== targetId);
      if (prev.length >= imposterCount) return prev;
      return [...prev, targetId];
    });
  }, [submitted, imposterCount]);

  const handleSubmit = useCallback(() => {
    if (submitted || selectedIds.length !== imposterCount) return;
    setSubmitted(true);
    socket.emit('vote:submit', { targetPlayerIds: selectedIds });
  }, [submitted, selectedIds, imposterCount]);

  // ── Derived ────────────────────────────────────────────────────────────

  const selectionFull = selectedIds.length === imposterCount;
  const canSubmit     = selectionFull && !submitted;

  const submitLabel = selectedIds.length === 0
    ? `Select ${imposterCount} Suspect${imposterCount === 1 ? '' : 's'} First`
    : !selectionFull
      ? `Select ${imposterCount - selectedIds.length} More`
      : imposterCount === 1
        ? 'Submit Vote'
        : 'Submit Votes';

  const instruction = submitted
    ? 'Vote submitted. Waiting for other agents…'
    : imposterCount === 1
      ? 'Select the suspect you believe is the impostor.'
      : `Select ${imposterCount} suspects you believe are the impostors. (${selectedIds.length}/${imposterCount} selected)`;

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="voting-page">
      <ToastContainer toasts={toasts} />

      <div className="voting-header">
        <div className="voting-header__left">
          <p className="voting-header__eyebrow">ROUND {roundNumber} · {category}</p>
          <h1 className="voting-header__title">Submit Verdict</h1>
        </div>
        <CountdownTimer secondsLeft={secondsLeft} />
      </div>

      <p className="voting-instruction">{instruction}</p>

      {socketError && (
        <p className="form-error" role="alert">{socketError}</p>
      )}

      <div className="suspect-grid">
        {players.map(player => {
          const isSelected = selectedIds.includes(player.id);
          const isMe       = player.id === playerId;
          const isDisabled = !isSelected && selectionFull;

          return (
            <SuspectCard
              key={player.id}
              player={player}
              isSelected={isSelected}
              isMe={isMe}
              isSubmitted={submitted}
              isDisabled={isDisabled}
              onSelect={handleSelect}
            />
          );
        })}
      </div>

      {!submitted && (
        <div className="voting-submit-wrapper">
          <button
            className="btn btn--primary btn--full voting-submit-btn"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitLabel}
          </button>
        </div>
      )}

      {submitted && (
        <div className="voting-submitted-banner">
          <span aria-hidden="true">✓</span> Vote recorded
        </div>
      )}
    </div>
  );
}
