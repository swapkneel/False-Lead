// client/src/context/GameContext.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Global game state shared across all pages and components.
//
//  Persisted to localStorage so a page refresh during a game restores
//  the session. The session token is the key — it lets the player
//  reconnect to their room via Socket.IO without re-joining via REST.
//
//  State shape:
//  {
//    playerId:    number | null,
//    nickname:    string,
//    sessionToken: string,        — UUID, used for socket auth + reconnect
//    roomCode:    string,
//    isHost:      boolean,
//    players:     Player[],       — live list from lobby:updated
//    roomStatus:  string,         — mirrors rooms.status
//    gamePhase:   string,         — client-side phase tracker
//  }
//
//  gamePhase is distinct from roomStatus:
//    roomStatus is the DB value ('waiting', 'voting', 'in_progress', 'finished')
//    gamePhase is what the client UI shows ('home', 'lobby', 'round', 'results')
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useState, useEffect, useCallback } from 'react';

// ─────────────────────────────────────────────
//  Default state
// ─────────────────────────────────────────────

const DEFAULT_STATE = {
  playerId:     null,
  nickname:     '',
  sessionToken: '',
  roomCode:     '',
  isHost:       false,
  players:      [],
  roomStatus:   '',
  gamePhase:    'home',   // 'home' | 'lobby' | 'round' | 'voting' | 'results' | 'finished'

  // Round data — populated when round:created + round:info both arrive
  roundData: null,
  // Shape: { roundId, roundNumber, totalRounds, roundType, category,
  //   clueOrder:[{playerId,nickname,order}], role, receivedInfo,
  //   isImposter, isOddOne, isSpy }
};

const STORAGE_KEY = 'falselead_session';

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveToStorage(state) {
  try {
    // Only persist identity fields — UI phase is derived on load
    const { playerId, nickname, sessionToken, roomCode, isHost } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      playerId, nickname, sessionToken, roomCode, isHost,
    }));
  } catch {
    // localStorage unavailable (private browsing with restrictions, etc.)
  }
}

function clearStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────
//  Context
// ─────────────────────────────────────────────

const GameContext = createContext(null);

export function GameProvider({ children }) {
  const [state, setState] = useState(() => {
    // Rehydrate from localStorage on first render.
    // If a session exists, the player will reconnect via socket on Lobby mount.
    const saved = loadFromStorage();
    if (saved && saved.sessionToken && saved.roomCode) {
      return {
        ...DEFAULT_STATE,
        ...saved,
        gamePhase: 'lobby',   // assume they were in lobby if session exists
      };
    }
    return DEFAULT_STATE;
  });

  // Persist identity fields whenever they change
  useEffect(() => {
    if (state.sessionToken) {
      saveToStorage(state);
    }
  }, [state.sessionToken, state.playerId, state.nickname, state.roomCode, state.isHost]);

  // ── Setters ───────────────────────────────────────────────────────────────

  /**
   * Called after a successful createRoom or joinRoom API call.
   * Stores the player's identity and navigates them to the lobby phase.
   */
  const setSession = useCallback(({ playerId, nickname, sessionToken, roomCode, isHost }) => {
    setState(prev => ({
      ...prev,
      playerId,
      nickname,
      sessionToken,
      roomCode,
      isHost:    isHost ?? false,
      gamePhase: 'lobby',
    }));
  }, []);

  /**
   * Called when the server emits lobby:updated.
   * Updates the live player list and room status.
   */
  const updateLobby = useCallback(({ players, status }) => {
    setState(prev => ({
      ...prev,
      players:    players || prev.players,
      roomStatus: status  || prev.roomStatus,
    }));
  }, []);

  /**
   * Advances the client to a new game phase.
   * Used by socket event listeners to transition the UI.
   */
  const setPhase = useCallback((phase) => {
    setState(prev => ({ ...prev, gamePhase: phase }));
  }, []);

  /**
   * Clears all state and localStorage. Called when game ends or player
   * navigates home.
   */
  const resetSession = useCallback(() => {
    clearStorage();
    setState(DEFAULT_STATE);
  }, []);

  /**
   * Stores data from round:created and round:info.
   * Called twice per round — merges both payloads together.
   */
  const setRoundData = useCallback((data) => {
    setState(prev => ({
      ...prev,
      roundData: { ...( prev.roundData || {}), ...data },
    }));
  }, []);

  const value = {
    // State
    ...state,

    // Actions
    setSession,
    updateLobby,
    setPhase,
    setRoundData,
    resetSession,
  };

  return (
    <GameContext.Provider value={value}>
      {children}
    </GameContext.Provider>
  );
}

/**
 * Hook for consuming game context.
 * Throws a clear error if used outside GameProvider.
 */
export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside <GameProvider>');
  return ctx;
}
