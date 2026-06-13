// client/src/pages/Game.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Round Screen.
//
//  Listens for:
//    round:created  — public round info (category, type, clue order)
//    round:info     — private role info for this player only
//    ready:update   — how many players are ready
//    voting:start   — navigate to /voting
//
//  Both round:created and round:info arrive quickly after each other.
//  We store them separately in roundData (via setRoundData) and merge.
//  The screen renders as soon as round:created arrives; the role card
//  fades in once round:info arrives.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react';
import { useNavigate }                       from 'react-router-dom';
import { useGame }                           from '../context/GameContext';
import socket                                from '../services/socket';

// ─────────────────────────────────────────────
//  Role configuration
//  Drives the card colour, icon, label, and hint text per role.
// ─────────────────────────────────────────────



const ROLE_CONFIG = {
  normal: {
    label:    'Agent',
    icon:     '🔍',
    colorVar: '--role-agent',
    bg:       'rgba(0, 229, 195, 0.08)',
    border:   'rgba(0, 229, 195, 0.35)',
    glow:     'rgba(0, 229, 195, 0.18)',
    hint:     'You know the secret. Find the impostor among you.',
  },
  imposter: {
    label:    'Impostor',
    icon:     '🎭',
    colorVar: '--role-impostor',
    bg:       'rgba(255, 77, 106, 0.08)',
    border:   'rgba(255, 77, 106, 0.4)',
    glow:     'rgba(255, 77, 106, 0.2)',
    hint:     'You have a clue, not the word. Blend in. Survive.',
  },
  similar_word_target: {
    label:    'Odd One',
    icon:     '🃏',
    colorVar: '--role-odd',
    bg:       'rgba(255, 170, 0, 0.08)',
    border:   'rgba(255, 170, 0, 0.4)',
    glow:     'rgba(255, 170, 0, 0.2)',
    hint:     'Your word is different. Blend in — no one must notice.',
  },
  reverse_spy_target: {
    label:    'Informant',
    icon:     '📋',
    colorVar: '--role-informant',
    bg:       'rgba(160, 100, 255, 0.08)',
    border:   'rgba(160, 100, 255, 0.4)',
    glow:     'rgba(160, 100, 255, 0.2)',
    hint:     'You alone know the real word. Everyone else has only the clue.',
  },
};

// Fallback for any unexpected role value
const DEFAULT_ROLE_CONFIG = {
  label:  'Unknown',
  icon:   '❓',
  bg:     'rgba(123, 128, 153, 0.1)',
  border: 'rgba(123, 128, 153, 0.3)',
  glow:   'transparent',
  hint:   '',
};

function getRoleConfig(role) {
  return ROLE_CONFIG[role] || DEFAULT_ROLE_CONFIG;
}

// Human-readable round type labels
const ROUND_TYPE_LABELS = {
  normal:       'Standard Round',
  reverse_spy:  'Reverse Spy',
  similar_word: 'Similar Word',
  chaos:        'Standard Round',   // chaos disguises itself
};

// ─────────────────────────────────────────────
//  Sub-components
// ─────────────────────────────────────────────

/**
 * Displays the player's secret role and received information.
 * The most important element on screen — gets the most visual weight.
 */


function RoleCard({ role, receivedInfo, hint }) {
  const cfg = getRoleConfig(role);

  return (
    <div
      className="role-card"
      style={{
        background:   cfg.bg,
        borderColor:  cfg.border,
        boxShadow:    `0 0 32px ${cfg.glow}`,
      }}
    >
      <div className="role-card-header">
        <span className="role-icon" aria-hidden="true">{cfg.icon}</span>
        <div>
          <p className="role-eyebrow">Your Role</p>
          <h2 className="role-label">{cfg.label}</h2>
        </div>
      </div>

      <div className="role-divider" style={{ borderColor: cfg.border }} />

      <div className="role-info-block">
        <p className="role-info-label">
          {role === 'imposter' ? 'Your Clue' : 'Your Word'}
        </p>
        <p
          className="role-info-value"
          style={{ color: cfg.border.replace('0.4)', '0.9)').replace('0.35)', '0.9)') }}
        >
          {receivedInfo}
        </p>
      </div>

      {hint && <p className="role-hint">{hint}</p>}
    </div>
  );
}

/**
 * Shows who speaks in what order this round.
 * The current player's row is highlighted.
 */
function ClueOrderList({ clueOrder = [], myClueOrder, players = [] }) {
  return (
    <div className="clue-order-panel">
      <h3 className="panel-title">
        <span className="panel-title-icon">💬</span> Speaking Order
      </h3>
      <ol className="clue-order-list">
        {clueOrder.map((entry) => {
          const isMe = entry.order === myClueOrder;
          return (
            <li
              key={entry.playerId}
              className={`clue-order-item ${isMe ? 'clue-order-item--me' : ''}`}
            >
              <span className="clue-order-num">{entry.order}</span>
              <span className="clue-order-name">
                {entry.nickname}
                {isMe && <span className="clue-order-you-tag">you</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Round header: round counter, round type badge, category.
 */
function RoundHeader({ roundNumber, totalRounds, roundType, category }) {
  const typeLabel = ROUND_TYPE_LABELS[roundType] || roundType;

  return (
    <div className="round-header">
      <div className="round-counter">
        <span className="round-counter-current">{roundNumber}</span>
        <span className="round-counter-sep">/</span>
        <span className="round-counter-total">{totalRounds}</span>
      </div>

      <div className="round-meta">
        <span className="round-type-badge">{typeLabel}</span>
        <span className="round-category">
          <span className="round-category-icon" aria-hidden="true">📁</span>
          {category}
        </span>
      </div>
    </div>
  );
}

/**
 * Ready system: button + live count of players who are ready.
 */
function ReadyPanel({ readyCount, totalPlayers, onReady, isReady }) {
  const allReady = readyCount >= totalPlayers && totalPlayers > 0;

  return (
    <div className="ready-panel">
      <div className="ready-count-row">
        <span className="ready-pips">
          {Array.from({ length: totalPlayers }).map((_, i) => (
            <span
              key={i}
              className={`ready-pip ${i < readyCount ? 'ready-pip--lit' : ''}`}
              aria-hidden="true"
            />
          ))}
        </span>
        <span className="ready-count-label">
          {readyCount} / {totalPlayers}
          {allReady ? ' · Starting…' : ' ready'}
        </span>
      </div>

      <button
        className={`btn btn--full ready-btn ${isReady ? 'ready-btn--done' : 'btn--primary'}`}
        onClick={onReady}
        disabled={isReady}
        aria-pressed={isReady}
      >
        {isReady ? '✓ Ready' : 'Ready to Vote'}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Main page component
// ─────────────────────────────────────────────

export default function Game() {
  const navigate = useNavigate();
  const {
    sessionToken,
    roomCode,
    roundData,
    players,
    setRoundData,
    setPhase,
  } = useGame();

  const [readyCount,    setReadyCount]    = useState(0);
  const [isReady,       setIsReady]       = useState(false);
  const [roleVisible,   setRoleVisible]   = useState(false);

  // totalPlayers from live players list in context, fallback to clueOrder length
  const totalPlayers = players.length ||
    (roundData?.clueOrder ? roundData.clueOrder.length : 0);

  // ── Redirect if no session ─────────────────────────────────────────────
  useEffect(() => {
  console.log("GAME COMPONENT MOUNTED");
}, []);
  
  useEffect(() => {
    if (!sessionToken || !roomCode) {
      navigate('/', { replace: true });
    }
  }, [sessionToken, roomCode, navigate]);

  // ── Authenticate socket if needed ──────────────────────────────────────
  // The socket may have been authenticated during Lobby but socket events
  // don't require re-joining — the socket room persists across navigation.
  useEffect(() => {
    if (!sessionToken) return;
    if (!socket.connected) {
      socket.connect();
      socket.emit('room:join', { sessionToken });
    }
  }, [sessionToken]);

  // ── Socket listeners ───────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionToken) return;

    // Public round info: category, type, speaking order
    function onRoundCreated(data) {
      // data: { roundId, roundNumber, totalRounds, roundType, category, clueOrder }
      setRoundData({
        roundId:     data.roundId,
        roundNumber: data.roundNumber,
        totalRounds: data.totalRounds,
        roundType:   data.roundType,
        category:    data.category,
        clueOrder:   data.clueOrder,
      });
      setIsReady(false);
      setReadyCount(0);
      setRoleVisible(false);
    }

    // Private info: role + secret word/hint
    function onRoundInfo(data) {
      // data: { roundId, role, receivedInfo, clueOrder, isImposter, isOddOne, isSpy }
      setRoundData({
        role:         data.role,
        receivedInfo: data.receivedInfo,
        myClueOrder:  data.clueOrder,
        isImposter:   data.isImposter,
        isOddOne:     data.isOddOne,
        isSpy:        data.isSpy,
      });
      // Small delay so the card entrance feels intentional
      setTimeout(() => setRoleVisible(true), 120);
    }

    // Live count of players who clicked Ready
    function onReadyUpdate(data) {
      // data: { readyCount, totalPlayers }
      setReadyCount(data.readyCount);
    }

    // All players ready — backend starts voting phase
    function onVotingStart() {
      setPhase('voting');
      navigate('/voting');
    }

    socket.on('round:created', onRoundCreated);
    socket.on('round:info', onRoundInfo);

    socket.on('ready:update',   onReadyUpdate);
    socket.on('voting:start',   onVotingStart);

    return () => {
      socket.off('round:created',  onRoundCreated);
      socket.off('round:info',     onRoundInfo);
      socket.off('ready:update',   onReadyUpdate);
      socket.off('voting:start',   onVotingStart);
    };
  }, [sessionToken, setRoundData, setPhase, navigate]);

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleReady = useCallback(() => {
    if (isReady) return;
    setIsReady(true);
    socket.emit('player:ready');
  }, [isReady]);

  // ── Loading state ──────────────────────────────────────────────────────
  // Show a case-file themed waiting screen while round data arrives
  if (!roundData?.roundId) {
    return (
      <div className="game-page game-page--loading">
        <div className="loading-case">
          <span className="loading-icon" aria-hidden="true">📂</span>
          <p className="loading-text">Opening case file…</p>
        </div>
      </div>
    );
  }

  const {
    roundNumber, totalRounds, roundType, category,
    clueOrder, role, receivedInfo, myClueOrder,
  } = roundData;

  const roleHint = role ? getRoleConfig(role).hint : '';

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="game-page">

      {/* ── Top: round context ── */}
      <RoundHeader
        roundNumber={roundNumber}
        totalRounds={totalRounds}
        roundType={roundType}
        category={category}
      />

      {/* ── Centre: role card — the dominant element ── */}
      <div className={`role-card-wrapper ${roleVisible ? 'role-card-wrapper--visible' : ''}`}>
        {role ? (
          <RoleCard
            role={role}
            receivedInfo={receivedInfo}
            hint={roleHint}
          />
        ) : (
          <div className="role-card-skeleton" aria-busy="true">
            <p className="loading-text">Receiving your assignment…</p>
          </div>
        )}
      </div>

      {/* ── Speaking order ── */}
      {clueOrder && clueOrder.length > 0 && (
        <ClueOrderList
          clueOrder={clueOrder}
          myClueOrder={myClueOrder}
        />
      )}

      {/* ── Discussion reminder ── */}
      <div className="discussion-notice">
        <span className="discussion-icon" aria-hidden="true">🗣</span>
        <p>Discuss with your group. Give clues in the order above.</p>
      </div>

      {/* ── Ready panel: pinned to bottom ── */}
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
