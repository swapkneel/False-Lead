// client/src/context/GameContext.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Global game state.
//
//  M2.5/M3 change — single authoritative roster model:
//
//  Previously `players` was written by both lobby:updated (room-level query)
//  and round:rejoin (round-level query as a fallback merge). These two sources
//  could diverge, causing suspect grids and ready panels to show different
//  sets depending on which event arrived last.
//
//  New model:
//    lobbyPlayers  — set by lobby:updated. Used only in Lobby.jsx.
//                    Shape: [{ id, nickname, isHost, isOnline, score }]
//
//    players       — set by round:created AND round:rejoin (identical event
//                    payload shape). Used by all in-game screens.
//                    Source: round_players JOIN room_players for the active
//                    round. This is the single authoritative in-game roster.
//
//  The client never needs to reconcile these two lists. Each screen reads
//  the appropriate one: Lobby reads lobbyPlayers, everything else reads
//  players. A mid-game lobby:updated (from a disconnect/reconnect broadcast)
//  no longer clobbers the round roster.
//
//  Actions:
//    setSession       — called after createRoom / joinRoom
//    updateLobby      — called on lobby:updated (writes lobbyPlayers only)
//    setRoundPlayers  — called on round:created and round:rejoin (writes players)
//    setPhase         — advances UI phase
//    setIsHost        — called on host:promoted
//    setRoundData     — merges round metadata
//    resetSession     — clears all state and localStorage
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const DEFAULT_STATE = {
  playerId:     null,
  nickname:     '',
  sessionToken: '',
  roomCode:     '',
  isHost:       false,

  // Pre-game lobby roster — written by lobby:updated only
  lobbyPlayers: [],

  // In-game round roster — written by round:created and round:rejoin only
  // Single authoritative source for all in-game screens
  players:      [],

  roomStatus:   '',
  gamePhase:    'home',
  roundData:    null,
};

const STORAGE_KEY = 'falselead_session';

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveToStorage(state) {
  try {
    const { playerId, nickname, sessionToken, roomCode, isHost, gamePhase } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      playerId, nickname, sessionToken, roomCode, isHost, gamePhase,
    }));
  } catch { /* ignore */ }
}

function clearStorage() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

const GameContext = createContext(null);

export function GameProvider({ children }) {
  const [state, setState] = useState(() => {
    const saved = loadFromStorage();
    if (saved && saved.sessionToken && saved.roomCode) {
      return { ...DEFAULT_STATE, ...saved, gamePhase: saved.gamePhase || 'lobby' };
    }
    return DEFAULT_STATE;
  });

  useEffect(() => {
    if (state.sessionToken) saveToStorage(state);
  }, [state.sessionToken, state.playerId, state.nickname,
      state.roomCode, state.isHost, state.gamePhase]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const setSession = useCallback(({ playerId, nickname, sessionToken, roomCode, isHost }) => {
    setState(prev => ({
      ...prev,
      playerId, nickname, sessionToken, roomCode,
      isHost:    isHost ?? false,
      gamePhase: 'lobby',
    }));
  }, []);

  /**
   * Called on lobby:updated.
   * Writes lobbyPlayers and roomStatus only — never touches players (round
   * roster). A mid-game disconnect broadcast cannot corrupt the round roster.
   */
  const updateLobby = useCallback(({ players, status }) => {
    setState(prev => ({
      ...prev,
      lobbyPlayers: players || prev.lobbyPlayers,
      roomStatus:   status  || prev.roomStatus,
    }));
  }, []);

  /**
   * Called on round:created and round:rejoin.
   * Sets the authoritative in-game player roster.
   * Both events send the same shape: [{ id, nickname, isHost, isOnline, score }]
   */
  const setRoundPlayers = useCallback((players) => {
    setState(prev => ({ ...prev, players: players || prev.players }));
  }, []);

  const setPhase = useCallback((phase) => {
    setState(prev => ({ ...prev, gamePhase: phase }));
  }, []);

  const setIsHost = useCallback((value) => {
    setState(prev => ({ ...prev, isHost: Boolean(value) }));
  }, []);

  const resetSession = useCallback(() => {
    clearStorage();
    setState(DEFAULT_STATE);
  }, []);

  /**
   * Merges round metadata from round:created / round:info / round:rejoin.
   * If incoming data has a different roundId → replace entirely (new round).
   * If no roundId in incoming data → merge (e.g. round:info adding role).
   */
  const setRoundData = useCallback((data) => {
    setState(prev => {
      const isNewRound = data.roundId && prev.roundData?.roundId !== data.roundId;
      return {
        ...prev,
        roundData: isNewRound
          ? data
          : { ...(prev.roundData || {}), ...data },
      };
    });
  }, []);

  const value = {
    ...state,
    setSession,
    updateLobby,
    setRoundPlayers,
    setPhase,
    setIsHost,
    setRoundData,
    resetSession,
  };

  return (
    <GameContext.Provider value={value}>
      {children}
    </GameContext.Provider>
  );
}

export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside <GameProvider>');
  return ctx;
}