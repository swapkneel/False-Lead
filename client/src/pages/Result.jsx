// client/src/pages/Result.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Result placeholder — shown after each round ends.
//
//  ROOT CAUSE FIX:
//  Previously, Result.jsx navigated to /game on round:created. Game.jsx then
//  mounted and tried to listen for round:info — but round:info had already
//  arrived and been dropped (no listener registered yet). This caused Round 2
//  to show stale receivedInfo from Round 1.
//
//  FIX: Result.jsx listens for BOTH round:created AND round:info.
//  It stores both payloads into context (setRoundData) before navigating.
//  When Game.jsx mounts, context already has the complete round data —
//  no race condition, no missed events.
//
//  Navigation trigger: round:info received (not round:created).
//  This guarantees private role data is in context before Game mounts.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate }                               from 'react-router-dom';
import { useGame }                                   from '../context/GameContext';
import socket                                        from '../services/socket';

export default function Result() {
  const navigate = useNavigate();
  const { sessionToken, roomCode, isHost, setPhase, setRoundData } = useGame();

  const [nextRound,   setNextRound]   = useState(null);
  const [starting,    setStarting]    = useState(false);
  const [socketError, setSocketError] = useState('');

  // Track whether we've received round:created for the next round.
  // round:info can only navigate once round:created has been stored.
  const roundCreatedRef = useRef(false);

  // ── Redirect guard ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken || !roomCode) navigate('/', { replace: true });
  }, [sessionToken, roomCode, navigate]);

  // ── Socket listeners ────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken) return;

    function onRoundNext(data) {
      // More rounds remain — show the appropriate UI.
      // Does NOT create a round. Host must click the button.
      setNextRound(data);
      setStarting(false);
      roundCreatedRef.current = false;   // reset for the next cycle
    }

    function onRoundCreated(data) {
      // Public round data arrived — store it immediately.
      // Do NOT navigate yet: round:info hasn't arrived, so receivedInfo
      // is not in context. Navigating now would cause the blank card bug.
      roundCreatedRef.current = true;
      setRoundData({
        roundId:     data.roundId,
        roundNumber: data.roundNumber,
        totalRounds: data.totalRounds,
        category:    data.category,
        clueOrder:   data.clueOrder,
      });
    }

    function onRoundInfo(data) {
      // Private role data arrived — store it, then navigate.
      // By this point round:created has already populated the public fields.
      // Both are now in context before Game.jsx mounts.
      setRoundData({
        role:         data.role,
        receivedInfo: data.receivedInfo,
        myClueOrder:  data.clueOrder,
      });

      setPhase('round');
      navigate('/game');
    }

    function onGameFinished() {
      setPhase('finished');
      navigate('/');
    }

    function onError(err) {
      setStarting(false);
      setSocketError(err.message || 'Something went wrong.');
    }

    socket.on('round:next',    onRoundNext);
    socket.on('round:created', onRoundCreated);
    socket.on('round:info',    onRoundInfo);
    socket.on('game:finished', onGameFinished);
    socket.on('error',         onError);

    return () => {
      socket.off('round:next',    onRoundNext);
      socket.off('round:created', onRoundCreated);
      socket.off('round:info',    onRoundInfo);
      socket.off('game:finished', onGameFinished);
      socket.off('error',         onError);
    };
  }, [sessionToken, setRoundData, setPhase, navigate]);

  // ── Host action ─────────────────────────────────────────────────────────
  const handleStartNext = useCallback(() => {
    if (starting) return;
    setStarting(true);
    setSocketError('');
    socket.emit('round:start-next');
  }, [starting]);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="result-placeholder">
      <div className="result-placeholder__inner">

        <span className="result-placeholder__icon" aria-hidden="true">📋</span>
        <h2 className="result-placeholder__title">Round Complete</h2>
        <p className="result-placeholder__sub">Full results screen coming soon.</p>

        {socketError && (
          <p className="form-error" role="alert" style={{ marginTop: '1rem' }}>
            {socketError}
          </p>
        )}

        {!nextRound && (
          <p className="result-placeholder__wait">Calculating results…</p>
        )}

        {nextRound && isHost && (
          <button
            className="btn btn--primary"
            style={{ marginTop: '1.5rem', minWidth: '200px' }}
            onClick={handleStartNext}
            disabled={starting}
          >
            {starting
              ? 'Starting…'
              : `Start Round ${nextRound.nextRoundNumber} of ${nextRound.totalRounds}`}
          </button>
        )}

        {nextRound && !isHost && (
          <p className="result-placeholder__wait" style={{ marginTop: '1rem' }}>
            Waiting for the host to start the next round…
          </p>
        )}

      </div>
    </div>
  );
}
