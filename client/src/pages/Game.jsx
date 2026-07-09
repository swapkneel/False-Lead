// client/src/pages/Game.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Round Screen — "The Case File" (Role Reveal)
//
//  Presentation pass:
//    - Root wrapper now carries the shared `.screen-transition` class (see
//      SHARED SCREEN TRANSITION in index.css) — same fade/slide/scale used
//      across every gameplay screen.
//    - The case file card's border fix (top strip → full restrained outline)
//      is CSS-only, via `.case-file` in index.css — no JSX change needed here.
//    - `CaseFootnote` (Discussion Order) reworked into a labeled section with
//      a speaking-order chip row, instead of one run-on paragraph.
//
//  All state, effects, socket event handlers, and emitted events are
//  byte-for-byte identical to the previous version — only JSX markup
//  inside the sub-components changed.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react';
import { useNavigate }                       from 'react-router-dom';
import { useGame }                           from '../context/GameContext';
import socket                                from '../services/socket';
import { useToast, ToastContainer }          from '../components/Toast';

// ── Role config ──────────────────────────────────────────────────────────────

const ROLE_CONFIG = {
  normal: {
    label: 'Field Agent', eyebrow: 'Standard Clearance',
    border: 'var(--brass)',
    infoLabel: 'Your Word',
    hint: 'Your word is the truth. Find the one who does not know it.',
  },
  imposter: {
    label: 'Infiltrator', eyebrow: 'Restricted Clearance',
    border: 'var(--oxblood)',
    infoLabel: 'Your Cover Clue',
    hint: 'You have a clue, not the word. Blend in. Do not get caught.',
  },
  reverse_spy_target: {
    label: 'Informant', eyebrow: 'Eyes Only',
    border: '#a064ff',
    infoLabel: 'Your Word',
    hint: 'You alone know the real word. The others are watching you.',
  },
};
// similar_word_target sees the normal Field Agent card — intentional deception
ROLE_CONFIG.similar_word_target = ROLE_CONFIG.normal;

const DEFAULT_CONFIG = {
  label: 'Agent', eyebrow: 'Unknown Clearance',
  border: 'var(--text-faint)',
  infoLabel: 'Your Info', hint: '',
};

function getRoleConfig(role) { return ROLE_CONFIG[role] || DEFAULT_CONFIG; }

// ── Sub-components ───────────────────────────────────────────────────────────

function CaseFileTag({ roundNumber, totalRounds }) {
  return (
    <div className="cf-tag-row">
      <span className="cf-tag">
        CASE {String(roundNumber).padStart(2, '0')} / {String(totalRounds).padStart(2, '0')}
      </span>
      <span className="cf-tag__classified">Classified</span>
    </div>
  );
}

function CaseFile({ role, receivedInfo }) {
  const cfg = getRoleConfig(role);
  return (
    <div className="case-file" style={{ '--card-border': cfg.border }}>
      <span className="case-file__role-eyebrow">{cfg.eyebrow}</span>
      <span className="case-file__role-name">{cfg.label}</span>
      <span className="case-file__word-label">{cfg.infoLabel}</span>
      <span className="case-file__word">{receivedInfo}</span>
      {cfg.hint && <p className="case-file__hint">{cfg.hint}</p>}
    </div>
  );
}

// Discussion Order — labeled supporting section with a step-chip speaking
// order row, separated from the "no discussion yet" note by a hairline
// divider. Gameplay logic (clueOrder / myClueOrder) is untouched — only the
// presentation of that same data changed.
function CaseFootnote({ clueOrder = [], myClueOrder }) {
  return (
    <div className="cf-footnote">
      {clueOrder.length > 0 && (
        <>
          <span className="cf-footnote__label">Speaking Order</span>
          <div className="cf-footnote__order">
            {clueOrder.map((entry, i) => (
              <span key={`${entry.nickname}-${i}`}>
                <span className={`cf-order-step ${entry.order === myClueOrder ? 'cf-order-step--me' : ''}`}>
                  {entry.nickname}
                </span>
                {i < clueOrder.length - 1 && <span className="cf-order-arrow" aria-hidden="true">→</span>}
              </span>
            ))}
          </div>
        </>
      )}
      <p className="cf-footnote__note">No discussion until every clue has been given.</p>
    </div>
  );
}

function ReadyControl({ readyCount, onlinePlayers, offlinePlayers, onReady, isReady }) {
  return (
    <>
      <span className="ready-pips">
        {Array.from({ length: onlinePlayers }).map((_, i) => (
          <span key={i} className={`ready-pip ${i < readyCount ? 'ready-pip--lit' : ''}`} />
        ))}
      </span>
      <span className="ready-count-label">{readyCount} / {onlinePlayers} ready</span>

      {offlinePlayers > 0 && (
        <p className="ready-offline-note">
          {offlinePlayers} offline player{offlinePlayers === 1 ? '' : 's'} auto-readied
        </p>
      )}

      <button
        className={`btn-game ${isReady ? 'btn-game--done' : ''}`}
        onClick={onReady}
        disabled={isReady}
        aria-pressed={isReady}
      >
        {isReady ? '✓ Ready' : 'Ready to Vote'}
        {!isReady && <span className="btn-game__arrow" aria-hidden="true">→</span>}
      </button>
    </>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Game() {
  const navigate = useNavigate();
  const {
    sessionToken, roomCode, roundData, players,
    setRoundData, setRoundPlayers, setPhase, setIsHost,
  } = useGame();

  const { toasts, addToast } = useToast();

  const [readyCount,  setReadyCount]  = useState(0);
  const [isReady,     setIsReady]     = useState(false);
  const [cardVisible, setCardVisible] = useState(false);

  // Round roster is now always populated by round:created before this screen
  // renders, so no fallback to clueOrder.length is needed.
  const onlinePlayers  = players.filter(p => p.isOnline !== false).length;
  const offlinePlayers = players.filter(p => p.isOnline === false).length;

  useEffect(() => {
    if (!sessionToken || !roomCode) navigate('/', { replace: true });
  }, [sessionToken, roomCode, navigate]);

  // Only emit room:join when socket was actually disconnected (page refresh).
  // Normal navigation from /lobby arrives with socket connected; emitting
  // room:join unconditionally would trigger a spurious round:rejoin.
  useEffect(() => {
    if (!sessionToken) return;
    if (!socket.connected) {
      function joinRoom() { socket.emit('room:join', { sessionToken }); }
      socket.connect();
      socket.once('connect', joinRoom);
      return () => socket.off('connect', joinRoom);
    }
  }, [sessionToken]);

  useEffect(() => {
    if (roundData?.role && roundData?.receivedInfo) {
      setTimeout(() => setCardVisible(true), 150);
    }
  }, [roundData?.roundId]);

  useEffect(() => {
    if (!sessionToken) return;

    function onRoundCreated(data) {
      // Set the authoritative round roster for all clients at round boundary
      if (Array.isArray(data.players)) setRoundPlayers(data.players);

      setRoundData({
        roundId:       data.roundId,
        roundNumber:   data.roundNumber,
        totalRounds:   data.totalRounds,
        roundType:     data.roundType,
        category:      data.category,
        clueOrder:     data.clueOrder,
        imposterCount: data.imposterCount,
      });
      // Reset ready state for the new round
      setReadyCount(0);
      setIsReady(false);
      setCardVisible(false);
    }

    function onRoundInfo(data) {
      setRoundData({ role: data.role, receivedInfo: data.receivedInfo, myClueOrder: data.clueOrder });
      setTimeout(() => setCardVisible(true), 150);
    }

    function onReadyUpdate(data) { setReadyCount(data.readyCount); }
    function onVotingStart()     { setPhase('voting'); navigate('/voting'); }

    // round:rejoin — authoritative, same payload shape as round:created
    function onRoundRejoin(data) {
      // Roster: same call as round:created handler
      if (Array.isArray(data.players)) setRoundPlayers(data.players);

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

      if (data.isReady)               setIsReady(true);
      if (data.readyCount != null)    setReadyCount(data.readyCount);
      if (data.role)                  setTimeout(() => setCardVisible(true), 150);

      switch (data.phase) {
        case 'voting':  setPhase('voting');  navigate('/voting', { replace: true }); break;
        case 'results':
        case 'waiting': setPhase('results'); navigate('/result', { replace: true }); break;
        default: break; // 'discussion' — already on the right screen
      }
    }

    function onPlayerDisconnected({ nickname }) { addToast(`${nickname} disconnected`, 'warning'); }
    function onPlayerReconnected({ nickname })  { addToast(`${nickname} reconnected`,  'success'); }
    function onPlayerRemoved({ nickname })      { addToast(`${nickname} was removed from the room`, 'info'); }
    function onHostPromoted(data) { setIsHost(true); addToast(data.message || 'You are now the host.', 'info'); }

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
  }, [sessionToken, setRoundData, setRoundPlayers, setPhase, setIsHost, navigate, addToast]);

  const handleReady = useCallback(() => {
    if (isReady) return;
    setIsReady(true);
    socket.emit('player:ready');
  }, [isReady]);

  if (!roundData?.roundId) {
    return (
      <div className="game-page game-page--loading screen-transition">
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
    <div className="game-page screen-transition">
      <ToastContainer toasts={toasts} />

      <CaseFileTag roundNumber={roundNumber} totalRounds={totalRounds} />

      <div className={`case-file-wrapper ${cardVisible ? 'case-file-wrapper--visible' : ''}`}>
        {role ? (
          <CaseFile role={role} receivedInfo={receivedInfo} />
        ) : (
          <div className="case-file-skeleton">
            <p className="loading-text">DECRYPTING ASSIGNMENT…</p>
          </div>
        )}
      </div>

      {clueOrder?.length > 0 && (
        <CaseFootnote clueOrder={clueOrder} myClueOrder={myClueOrder} />
      )}

      <div className="game-bottom">
        <ReadyControl
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