// client/src/pages/Voting.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Voting Screen — "Submit Your Verdict"
//
//  Listens for:
//    vote:timer   — countdown seconds remaining
//    round:result — navigate to /result
//
//  Emits:
//    vote:submit  { targetPlayerId }
//
//  Players appear as "evidence cards" — tapping one selects it.
//  Submit is a separate button to prevent accidental votes.
//  Once submitted, the UI locks and shows a confirmation.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react';
import { useNavigate }                       from 'react-router-dom';
import { useGame }                           from '../context/GameContext';
import socket                                from '../services/socket';

// ─────────────────────────────────────────────
//  Evidence card — one per player
// ─────────────────────────────────────────────

function SuspectCard({ player, isSelected, isMe, isSubmitted, onSelect }) {
  const disabled = isMe || isSubmitted;

  return (
    <button
      className={[
        'suspect-card',
        isSelected  ? 'suspect-card--selected'  : '',
        isMe        ? 'suspect-card--you'        : '',
        isSubmitted && !isSelected ? 'suspect-card--dim' : '',
      ].join(' ').trim()}
      onClick={() => !disabled && onSelect(player.id)}
      disabled={disabled}
      aria-pressed={isSelected}
      aria-label={isMe ? `${player.nickname} (you — cannot vote for yourself)` : `Vote for ${player.nickname}`}
    >
      <div className="suspect-card__inner">
        {/* Evidence number stamp */}
        <span className="suspect-card__num" aria-hidden="true">
          {String(player.id).slice(-2).padStart(2, '0')}
        </span>

        {/* Name */}
        <span className="suspect-card__name">{player.nickname}</span>

        {/* Tags */}
        <div className="suspect-card__tags">
          {isMe && <span className="suspect-tag suspect-tag--you">YOU</span>}
          {isSelected && !isMe && (
            <span className="suspect-tag suspect-tag--selected">SELECTED</span>
          )}
        </div>
      </div>

      {/* Selection indicator bar */}
      {isSelected && <div className="suspect-card__bar" aria-hidden="true" />}
    </button>
  );
}

// ─────────────────────────────────────────────
//  Countdown ring
// ─────────────────────────────────────────────

function CountdownTimer({ secondsLeft }) {
  const TOTAL = 30;
  const pct   = Math.max(0, secondsLeft / TOTAL);
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

// ─────────────────────────────────────────────
//  Page
// ─────────────────────────────────────────────

export default function Voting() {
  const navigate = useNavigate();
  const { sessionToken, roomCode, playerId, roundData, players, setPhase } = useGame();

  const [selectedId,    setSelectedId]    = useState(null);
  const [submitted,     setSubmitted]     = useState(false);
  const [secondsLeft,   setSecondsLeft]   = useState(30);
  const [socketError,   setSocketError]   = useState('');

  const category    = roundData?.category    ?? '';
  const roundNumber = roundData?.roundNumber ?? '';
  const roundId     = roundData?.roundId;

  // ── Redirect guard ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken || !roomCode) navigate('/', { replace: true });
  }, [sessionToken, roomCode, navigate]);

  // ── Socket reconnect guard ──────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken) return;
    if (!socket.connected) {
      socket.connect();
      socket.emit('room:join', { sessionToken });
    }
  }, [sessionToken]);

  // ── Socket listeners ────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken) return;

    function onTimer(data) {
      setSecondsLeft(data.secondsRemaining);
    }

    function onResult(data) {
  console.log(
  'VOTING RECEIVED RESULT',
  JSON.stringify(data, null, 2)
);

  sessionStorage.setItem(
    'lastRoundResult',
    JSON.stringify(data)
  );

  setPhase('results');
  navigate('/result');
}

    function onError(err) {
      setSocketError(err.message || 'Something went wrong.');
    }

    socket.on('vote:timer',   onTimer);
    socket.on('round:result', onResult);
    socket.on('error',        onError);

    return () => {
      socket.off('vote:timer',   onTimer);
      socket.off('round:result', onResult);
      socket.off('error',        onError);
    };
  }, [sessionToken, setPhase, navigate]);

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleSelect = useCallback((targetId) => {
    if (submitted) return;
    setSelectedId(prev => prev === targetId ? null : targetId);
    setSocketError('');
  }, [submitted]);

  const handleSubmit = useCallback(() => {
    if (submitted || selectedId === null) return;
    setSubmitted(true);
    socket.emit('vote:submit', { targetPlayerId: selectedId });
  }, [submitted, selectedId]);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="voting-page">

      {/* Header */}
      <div className="voting-header">
        <div className="voting-header__left">
          <p className="voting-header__eyebrow">ROUND {roundNumber} · {category}</p>
          <h1 className="voting-header__title">Submit Verdict</h1>
        </div>
        <CountdownTimer secondsLeft={secondsLeft} />
      </div>

      {/* Instruction */}
      <p className="voting-instruction">
        {submitted
          ? 'Vote submitted. Waiting for other agents…'
          : 'Select the suspect you believe is the impostor.'}
      </p>

      {/* Error */}
      {socketError && (
        <p className="form-error" role="alert">{socketError}</p>
      )}

      {/* Suspect grid */}
      <div className="suspect-grid">
        {players.map(player => (
          <SuspectCard
            key={player.id}
            player={player}
            isSelected={selectedId === player.id}
            isMe={player.id === playerId}
            isSubmitted={submitted}
            onSelect={handleSelect}
          />
        ))}
      </div>

      {/* Submit — pinned to bottom */}
      {!submitted && (
        <div className="voting-submit-wrapper">
          <button
            className="btn btn--primary btn--full voting-submit-btn"
            onClick={handleSubmit}
            disabled={selectedId === null}
          >
            {selectedId === null ? 'Select a Suspect First' : 'Submit Vote'}
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
