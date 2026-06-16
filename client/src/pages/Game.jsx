// client/src/pages/Game.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Round Screen — "Opening the Case File"
//
//  Changes from previous version:
//    1. Round type is NEVER displayed publicly — header shows only
//       Round N/Total and Category.
//    2. similar_word_target removed from ROLE_CONFIG — that player
//       now receives role:'normal' from the server and sees identical UI.
//    3. Visual redesign: case-file / classified document aesthetic.
//    4. Listens for round:next to reset state for the next round.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react';
import { useNavigate }                       from 'react-router-dom';
import { useGame }                           from '../context/GameContext';
import socket                                from '../services/socket';

// ─────────────────────────────────────────────
//  Role configuration
//  similar_word_target deliberately absent — server sends 'normal' for that role.
//  Chaos players also receive 'normal'. This table only needs two real entries.
// ─────────────────────────────────────────────

const ROLE_CONFIG = {
  normal: {
    label:       'Field Agent',
    eyebrow:     'CLEARANCE LEVEL · STANDARD',
    icon:        '🔍',
    bg:          'rgba(0, 229, 195, 0.06)',
    border:      '#00e5c3',
    glow:        'rgba(0, 229, 195, 0.15)',
    infoLabel:   'CLASSIFIED WORD',
    hint:        'Your word is the truth. Find the one who does not know it.',
  },
  imposter: {
    label:       'Infiltrator',
    eyebrow:     'CLEARANCE LEVEL · RESTRICTED',
    icon:        '🎭',
    bg:          'rgba(255, 77, 106, 0.06)',
    border:      '#ff4d6a',
    glow:        'rgba(255, 77, 106, 0.18)',
    infoLabel:   'YOUR COVER CLUE',
    hint:        'You have a clue — not the word. Blend in. Do not get caught.',
  },
  reverse_spy_target: {
    label:       'Informant',
    eyebrow:     'CLEARANCE LEVEL · EYES ONLY',
    icon:        '📋',
    bg:          'rgba(160, 100, 255, 0.06)',
    border:      '#a064ff',
    glow:        'rgba(160, 100, 255, 0.18)',
    infoLabel:   'CLASSIFIED WORD',
    hint:        'You alone know the real word. The others are watching you.',
  },
};

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

// ─────────────────────────────────────────────
//  Sub-components
// ─────────────────────────────────────────────

function CaseFileHeader({ roundNumber, totalRounds, category }) {
  return (
    <div className="cf-header">
      <div className="cf-stamp-row">
        <span className="cf-case-label">CASE FILE</span>
        <span className="cf-round-num">{String(roundNumber).padStart(2,'0')} / {String(totalRounds).padStart(2,'0')}</span>
      </div>
      <div className="cf-category-row">
        <span className="cf-category-icon" aria-hidden="true">📁</span>
        <span className="cf-category">{category}</span>
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
      {/* Top strip — classification level */}
      <div className="evidence-card__strip">
        <span className="evidence-card__eyebrow">{cfg.eyebrow}</span>
        <span className="evidence-card__icon">{cfg.icon}</span>
      </div>

      {/* Role name */}
      <div className="evidence-card__role-row">
        <span className="evidence-card__role-tag">ROLE</span>
        <span className="evidence-card__role-name">{cfg.label}</span>
      </div>

      {/* The word / clue — dominant element */}
      <div className="evidence-card__word-block">
        <p className="evidence-card__word-label">{cfg.infoLabel}</p>
        <p className="evidence-card__word">{receivedInfo}</p>
      </div>

      {/* Flavour hint */}
      {cfg.hint && (
        <p className="evidence-card__hint">{cfg.hint}</p>
      )}

      {/* Decorative redaction bars */}
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
              <span className="witness-num">{String(entry.order).padStart(2,'0')}</span>
              <span className="witness-name">{entry.nickname}</span>
              {isMe && <span className="witness-you">YOU</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ReadyPanel({ readyCount, totalPlayers, onReady, isReady }) {
  return (
    <div className="ready-panel">
      <div className="ready-count-row">
        <span className="ready-pips">
          {Array.from({ length: totalPlayers }).map((_, i) => (
            <span key={i} className={`ready-pip ${i < readyCount ? 'ready-pip--lit' : ''}`} />
          ))}
        </span>
        <span className="ready-count-label">
          {readyCount} / {totalPlayers} ready
        </span>
      </div>
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

// ─────────────────────────────────────────────
//  Page
// ─────────────────────────────────────────────

export default function Game() {
  const navigate = useNavigate();
  const { sessionToken, roomCode, roundData, players, setRoundData, setPhase } = useGame();

  const [readyCount,  setReadyCount]  = useState(0);
  const [isReady,     setIsReady]     = useState(false);
  const [cardVisible, setCardVisible] = useState(false);

  const totalPlayers = players.length || (roundData?.clueOrder?.length ?? 0);

  useEffect(() => {
    if (!sessionToken || !roomCode) navigate('/', { replace: true });
  }, [sessionToken, roomCode, navigate]);

  useEffect(() => {
    if (!sessionToken) return;
    if (!socket.connected) {
      socket.connect();
      socket.emit('room:join', { sessionToken });
    }
  }, [sessionToken]);

  // If roundData already contains role when this component mounts (the normal
  // case for Round 2+, where Result.jsx stored everything before navigating),
  // show the card immediately without waiting for a socket event.
  useEffect(() => {
    if (roundData?.role && roundData?.receivedInfo) {
      setTimeout(() => setCardVisible(true), 150);
    }
  }, [roundData?.roundId]);  // re-run only when roundId changes (new round)

  useEffect(() => {
    if (!sessionToken) return;

    // ROOT CAUSE FIX:
    // round:created and round:info are now handled in Result.jsx BEFORE
    // navigation to /game. By the time Game.jsx mounts, context already has
    // the complete round data (public + private). Game.jsx does NOT need to
    // listen for round:created at all — data is already there.
    //
    // round:info is kept here as a safety net only: if somehow this component
    // is mounted and a new round:info arrives (e.g. host starts round 1 from
    // lobby directly), we store it and show the card.

    function onRoundCreated(data) {
  setRoundData({
    roundId: data.roundId,
    roundNumber: data.roundNumber,
    totalRounds: data.totalRounds,
    category: data.category,
    clueOrder: data.clueOrder,
  });
}

    function onRoundInfo(data) {
      // Safety net — normally this fires in Result.jsx before navigation.
      // If we receive it here it means Game.jsx was already mounted (round 1
      // started from lobby). Store and show.
      setRoundData({
        role:         data.role,
        receivedInfo: data.receivedInfo,
        myClueOrder:  data.clueOrder,
      });
      setTimeout(() => setCardVisible(true), 150);
    }

    function onReadyUpdate(data) { setReadyCount(data.readyCount); }

    function onVotingStart() {
      setPhase('voting');
      navigate('/voting');
    }

    socket.on('round:created', onRoundCreated);
    socket.on('round:info',   onRoundInfo);
    socket.on('ready:update', onReadyUpdate);
    socket.on('voting:start', onVotingStart);

    return () => {
      socket.off('round:created', onRoundCreated);
      socket.off('round:info',   onRoundInfo);
      socket.off('ready:update', onReadyUpdate);
      socket.off('voting:start', onVotingStart);
    };
  }, [sessionToken, setRoundData, setPhase, navigate]);

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

  const { roundNumber, totalRounds, category, clueOrder, role, receivedInfo, myClueOrder } = roundData;

  return (
    <div className="game-page">
      <CaseFileHeader
        roundNumber={roundNumber}
        totalRounds={totalRounds}
        category={category}
      />

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
          totalPlayers={totalPlayers}
          onReady={handleReady}
          isReady={isReady}
        />
      </div>
    </div>
  );
}
