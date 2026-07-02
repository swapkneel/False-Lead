// client/src/context/GameContext.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Global game state shared across all pages and components.
//
//  Persisted to localStorage so a page refresh during a game can attempt
//  to restore the session.  The session token is the key — it lets the
//  player reconnect to their room via Socket.IO without re-joining via REST.
//
//  M2 changes:
//    - gamePhase is now persisted to localStorage as a cold-start fallback.
//      Once the socket reconnects, round:rejoin overrides it authoritatively.
//    - updateLobby now preserves isOnline on each player (set by the server
//      via the isOnline field on lobby:updated player entries).
//    - setIsHost added so the host:promoted handler can update context without
//      a full re-join flow.
//    - Storage now includes gamePhase so a cold refresh lands on the right
//      route while waiting for the server to confirm.
//
//  State shape:
//  {
//    playerId:     number | null,
//    nickname:     string,
//    sessionToken: string,
//    roomCode:     string,
//    isHost:       boolean,
//    players:      Player[],       ← each has isOnline: boolean (M2)
//    roomStatus:   string,
//    gamePhase:    string,
//    roundData:    RoundData | null,
//  }
//
//  gamePhase values: 'home' | 'lobby' | 'round' | 'voting' | 'results' | 'finished'
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
  gamePhase:    'home',

  // Round data — populated when round:created + round:info both arrive,
  // or restored wholesale from round:rejoin.
  roundData: null,
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
    // Persist identity fields + gamePhase as a cold-start fallback.
    // gamePhase will be immediately overridden by round:rejoin once the
    // socket reconnects — it is only used to choose the initial route.
    const { playerId, nickname, sessionToken, roomCode, isHost, gamePhase } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      playerId, nickname, sessionToken, roomCode, isHost, gamePhase,
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
    const saved = loadFromStorage();
    if (saved && saved.sessionToken && saved.roomCode) {
      return {
        ...DEFAULT_STATE,
        ...saved,
        // Use persisted gamePhase as the cold-start fallback.
        // round:rejoin will override this once the socket connects.
        gamePhase: saved.gamePhase || 'lobby',
      };
    }
    return DEFAULT_STATE;
  });

  // Persist whenever identity or phase changes
  useEffect(() => {
    if (state.sessionToken) {
      saveToStorage(state);
    }
  }, [
    state.sessionToken,
    state.playerId,
    state.nickname,
    state.roomCode,
    state.isHost,
    state.gamePhase,
  ]);

  // ── Setters ───────────────────────────────────────────────────────────────

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
   * Called on lobby:updated.
   * Players now carry isOnline: boolean from the server — preserve it.
   */
  const updateLobby = useCallback(({ players, status }) => {
    setState(prev => ({
      ...prev,
      players:    players || prev.players,
      roomStatus: status  || prev.roomStatus,
    }));
  }, []);

  const setPhase = useCallback((phase) => {
    setState(prev => ({ ...prev, gamePhase: phase }));
  }, []);

  /**
   * Flip isHost in context.
   * Called when this socket receives host:promoted so the Start Game
   * button and other host-only controls appear immediately.
   */
  const setIsHost = useCallback((value) => {
    setState(prev => ({ ...prev, isHost: Boolean(value) }));
  }, []);

  const resetSession = useCallback(() => {
    clearStorage();
    setState(DEFAULT_STATE);
  }, []);

  /**
   * Stores round data from round:created / round:info events.
   * If the incoming data has a different roundId → replace entirely (new round).
   * If no roundId in incoming data → merge into existing round (e.g. round:info).
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
