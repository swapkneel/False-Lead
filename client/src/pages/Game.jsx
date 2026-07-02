// client/src/pages/Game.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Round Screen — "Opening the Case File"
//
//  M2 additions:
//    - round:rejoin handler: restores roundData and ready state from server,
//      navigates away if the server says the phase is voting/results/waiting.
//    - Corrected socket reconnect guard: always emits room:join on mount
//      (not only when socket is disconnected) so a tab that stayed open
//      but lost its server session re-authenticates correctly.
//    - ReadyPanel now counts only online players for its pip display.
//    - Toasts for player:disconnected, player:reconnected, player:removed,
//      host:promoted.
//    - isReady initialised from round:rejoin payload.
//
//  Regression fix (post-M2):
//    - similar_word_target added to ROLE_CONFIG mapped to the normal card
//      appearance. The Similar Word target receives the alternate word and
//      is meant to believe they are a normal agent — showing the grey
//      DEFAULT_CONFIG card was incorrect.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react';
import { useNavigate }                       from 'react-router-dom';
import { useGame }                           from '../context/GameContext';
import socket                                from '../services/socket';
import { useToast, ToastContainer }          from '../components/Toast';

// ── Role config ──────────────────────────────────────────────────────────────
//
// similar_word_target intentionally maps to the normal config.
// That player receives the alternate word and should believe they are a
// standard Field Agent — showing them a distinct card would break the
// deception mechanic.

const ROLE_CONFIG = {
  normal: {
    label:     'Field Agent',
    eyebrow:   'CLEARANCE LEVEL · STANDARD',
    icon:      '🔍',
    bg:        'rgba(0, 229, 195, 0.06)',
    border:    '#00e5c3',
    glow:      'rgba(0, 229, 195, 0.15)',
    infoLabel: 'CLASSIFIED WORD',
    hint:      'Your word is the truth. Find the one who does not know it.',
  },
  imposter: {
    label:     'Infiltrator',
    eyebrow:   'CLEARANCE LEVEL · RESTRICTED',
    icon:      '🎭',
    bg:        'rgba(255, 77, 106, 0.06)',
    border:    '#ff4d6a',
    glow:      'rgba(255, 77, 106, 0.18)',
    infoLabel: 'YOUR COVER CLUE',
    hint:      'You have a clue — not the word. Blend in. Do not get caught.',
  },
  reverse_spy_target: {
    label:     'Informant',
    eyebrow:   'CLEARANCE LEVEL · EYES ONLY',
    icon:      '📋',
    bg:        'rgba(160, 100, 255, 0.06)',
    border:    '#a064ff',
    glow:      'rgba(160, 100, 255, 0.18)',
    infoLabel: 'CLASSIFIED WORD',
    hint:      'You alone know the real word. The others are watching you.',
  },
};

// similar_word_target sees the normal Field Agent card — intentional deception.
ROLE_CONFIG.similar_word_target = ROLE_CONFIG.normal;

const DEFAULT_CONFIG = {
  label:     'Agent',
  eyebrow:   'CLEARANCE LEVEL · UNKNOWN',
  icon:      '❓',
  bg:        'rgba(123,128,153,0.08)',
  border:    '#454961',
  glow:      'transparent',
  infoLabel: 'YOUR INFO',
  hint:      '',
};

function getRoleConfig(role) {
  return ROLE_CONFIG[role] || DEFAULT_CONFIG;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function CaseFileHeader({ roundNumber, totalRounds }) {
  return (
    <div className="cf-header">
      <div className="cf-stamp-row">
        <span className="cf-case-label">CASE FILE</span>
        <span className="cf-round-num">
          {String(roundNumber).padStart(2, '0')} / {String(totalRounds).padStart(2, '0')}
        </span>
      </div>
      <div className="cf-category-row">
        <span className="cf-category-icon" aria-hidden="true">📁</span>
        <span className="cf-category">CLASSIFIED</span>
      </div>
    </div>
  );
}

function EvidenceCard({ role, receivedInfo }) {
  const cfg = getRoleConfig(role);
  return (
    <div
      className="evidence-card"
      style={{
        '--card-border': cfg.border,
        '--card-bg':     cfg.bg,
        '--card-glow':   cfg.glow,
      }}
    >
      <div className="evidence-card__strip">
        <span className="evidence-card__eyebrow">{cfg.eyebrow}</span>
        <span className="evidence-card__icon">{cfg.icon}</span>
      </div>
      <div className="evidence-card__role-row">
        <span className="evidence-card__role-tag">ROLE</span>
        <span className="evidence-card__role-name">{cfg.label}</span>
      </div>
      <div className="evidence-card__word-block">
        <p className="evidence-card__word-label">{cfg.infoLabel}</p>
        <p className="evidence-card__word">{receivedInfo}</p>
      </div>
      {cfg.hint && <p className="evidence-card__hint">{cfg.hint}</p>}
      <div className="evidence-card__redact" aria-hidden="true">
        <span /><span /><span />
      </div>
    </div>
  );
}

function WitnessOrder({ clueOrder = [], myClueOrder }) {
  return (
    <div className="witness-panel">
      <div className="witness-panel__header">
        <span className="witness-panel__icon" aria-hidden="true">📋</span>
        <span className="witness-panel__title">WITNESS ORDER</span>
      </div>
      <ol className="witness-list">
        {clueOrder.map((entry) => {
          const isMe = entry.order === myClueOrder;
          return (
            <li key={entry.playerId} className={`witness-item ${isMe ? 'witness-item--me' : ''}`}>
              <span className="witness-num">{String(entry.order).padStart(2, '0')}</span>
              <span className="witness-name">{entry.nickname}</span>
              {isMe && <span className="witness-you">YOU</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ReadyPanel({ readyCount, onlinePlayers, offlinePlayers, onReady, isReady }) {
  return (
    <div className="ready-panel">
      <div className="ready-count-row">
        <span className="ready-pips">
          {Array.from({ length: onlinePlayers }).map((_, i) => (
            <span key={i} className={`ready-pip ${i < readyCount ? 'ready-pip--lit' : ''}`} />
          ))}
        </span>
        <span className="ready-count-label">
          {readyCount} / {onlinePlayers} ready
        </span>
      </div>

      {offlinePlayers > 0 && (
        <p className="ready-offline-note">
          {offlinePlayers} player{offlinePlayers === 1 ? '' : 's'} offline — auto-readied
        </p>
      )}

      <button
        className={`btn btn--full ready-btn ${isReady ? 'ready-btn--done' : 'btn--primary'}`}
        onClick={onReady}
        disabled={isReady}
        aria-pressed={isReady}
      >
        {isReady ? '✓ Ready to Vote' : 'Ready to Vote'}
      </button>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Game() {
  const navigate = useNavigate();
  const {
    sessionToken, roomCode, roundData, players,
    setRoundData, setPhase, setIsHost,
  } = useGame();

  const { toasts, addToast } = useToast();

  const [readyCount,  setReadyCount]  = useState(0);
  const [isReady,     setIsReady]     = useState(false);
  const [cardVisible, setCardVisible] = useState(false);

  const onlinePlayers  = players.filter(p => p.isOnline !== false).length
    || (roundData?.clueOrder?.length ?? 0);
  const offlinePlayers = players.filter(p => p.isOnline === false).length;

  // ── Redirect if no session ─────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken || !roomCode) navigate('/', { replace: true });
  }, [sessionToken, roomCode, navigate]);

  // ── Socket reconnect guard ─────────────────────────────────────────────
  //
  // Only emit room:join when the socket was actually disconnected.
  // Normal navigation from /lobby → /game arrives with the socket already
  // connected — round:created and round:info already populate roundData,
  // so emitting room:join here is unnecessary and would trigger a spurious
  // round:rejoin that could race with those events.
  //
  // True reconnect (page refresh) — socket is disconnected — still connects
  // and emits room:join, receiving round:rejoin to restore state.
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
    // Socket already connected — normal navigation, no rejoin needed.
  }, [sessionToken]);

  // ── Card entrance animation ────────────────────────────────────────────
  useEffect(() => {
    if (roundData?.role && roundData?.receivedInfo) {
      setTimeout(() => setCardVisible(true), 150);
    }
  }, [roundData?.roundId]);

  // ── Socket event listeners ─────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken) return;

    function onRoundCreated(data) {
      setRoundData({
        roundId:       data.roundId,
        roundNumber:   data.roundNumber,
        totalRounds:   data.totalRounds,
        roundType:     data.roundType,
        category:      data.category,
        clueOrder:     data.clueOrder,
        imposterCount: data.imposterCount,
      });
    }

    function onRoundInfo(data) {
      setRoundData({
        role:         data.role,
        receivedInfo: data.receivedInfo,
        myClueOrder:  data.clueOrder,
      });
      setTimeout(() => setCardVisible(true), 150);
    }

    function onReadyUpdate(data) {
      setReadyCount(data.readyCount);
    }

    function onVotingStart() {
      setPhase('voting');
      navigate('/voting');
    }

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

      if (data.isReady) setIsReady(true);
      if (data.readyCount != null) setReadyCount(data.readyCount);
      if (data.role) setTimeout(() => setCardVisible(true), 150);

      switch (data.phase) {
        case 'voting':
          setPhase('voting');
          navigate('/voting', { replace: true });
          break;
        case 'results':
        case 'waiting':
          setPhase('results');
          navigate('/result', { replace: true });
          break;
        case 'discussion':
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

    socket.on('round:created',       onRoundCreated);
    socket.on('round:info',          onRoundInfo);
    socket.on('ready:update',        onReadyUpdate);
    socket.on('voting:start',        onVotingStart);
    socket.on('round:rejoin',        onRoundRejoin);
    socket.on('player:disconnected', onPlayerDisconnected);
    socket.on('player:reconnected',  onPlayerReconnected);
    socket.on('player:removed',      onPlayerRemoved);
    socket.on('host:promoted',       onHostPromoted);

    return () => {
      socket.off('round:created',       onRoundCreated);
      socket.off('round:info',          onRoundInfo);
      socket.off('ready:update',        onReadyUpdate);
      socket.off('voting:start',        onVotingStart);
      socket.off('round:rejoin',        onRoundRejoin);
      socket.off('player:disconnected', onPlayerDisconnected);
      socket.off('player:reconnected',  onPlayerReconnected);
      socket.off('player:removed',      onPlayerRemoved);
      socket.off('host:promoted',       onHostPromoted);
    };
  }, [sessionToken, setRoundData, setPhase, setIsHost, navigate, addToast]);

  const handleReady = useCallback(() => {
    if (isReady) return;
    setIsReady(true);
    socket.emit('player:ready');
  }, [isReady]);

  if (!roundData?.roundId) {
    return (
      <div className="game-page game-page--loading">
        <div className="loading-case">
          <div className="loading-folder" aria-hidden="true">📂</div>
          <p className="loading-text">RETRIEVING CASE FILE…</p>
          <p className="loading-subtext">Stand by for your assignment</p>
        </div>
      </div>
    );
  }

  const { roundNumber, totalRounds, clueOrder, role, receivedInfo, myClueOrder } = roundData;

  return (
    <div className="game-page">
      <ToastContainer toasts={toasts} />

      <CaseFileHeader roundNumber={roundNumber} totalRounds={totalRounds} />

      <div className={`evidence-card-wrapper ${cardVisible ? 'evidence-card-wrapper--visible' : ''}`}>
        {role ? (
          <EvidenceCard role={role} receivedInfo={receivedInfo} />
        ) : (
          <div className="evidence-card-skeleton">
            <p className="loading-text">DECRYPTING ASSIGNMENT…</p>
          </div>
        )}
      </div>

      {clueOrder?.length > 0 && (
        <WitnessOrder clueOrder={clueOrder} myClueOrder={myClueOrder} />
      )}

      <div className="interrogation-notice">
        <span aria-hidden="true">🗣</span>
        <p>State your clue when it is your turn. No discussion until all clues are given.</p>
      </div>

      <div className="ready-panel-wrapper">
        <ReadyPanel
          readyCount={readyCount}
          onlinePlayers={onlinePlayers}
          offlinePlayers={offlinePlayers}
          onReady={handleReady}
          isReady={isReady}
        />
      </div>
    </div>
  );
}
