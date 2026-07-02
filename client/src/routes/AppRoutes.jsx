// client/src/routes/AppRoutes.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  M2 change: game-phase routes (/game, /voting, /result) are wrapped in
//  SessionGuard.
//
//  SessionGuard behaviour:
//    - If the player has a sessionToken + roomCode in context, render the
//      child route.  The child will emit room:join on mount and wait for
//      round:rejoin to confirm the correct phase.
//    - If there is no session at all, redirect to / immediately.
//    - It does NOT redirect based on gamePhase — the server's round:rejoin
//      is the authoritative source.  The guard only prevents completely
//      unauthenticated access.
//
//  /lobby has its own redirect guard inside Lobby.jsx (unchanged).
//  Pass-and-play routes are unaffected.
// ─────────────────────────────────────────────────────────────────────────────

import { Routes, Route, Navigate } from 'react-router-dom';
import { useGame }     from '../context/GameContext';
import Home            from '../pages/Home';
import Lobby           from '../pages/Lobby';
import Game            from '../pages/Game';
import Voting          from '../pages/Voting';
import Result          from '../pages/Result';
import PassPlay        from '../pages/PassPlay';
import PpPlaceholder   from '../pages/PpPlaceholder';
import PpRoleReveal    from '../components/passplay/PpRoleReveal';
import PpDiscussion    from '../components/passplay/PpDiscussion';

// ─────────────────────────────────────────────
//  Guard
// ─────────────────────────────────────────────

/**
 * Renders children if a session exists.
 * Redirects to / if not — prevents an unauthenticated user from landing
 * directly on /game, /voting, or /result with no session at all.
 *
 * Does NOT inspect gamePhase — the server's round:rejoin handles routing
 * to the correct screen once the socket connects.
 */
function SessionGuard({ children }) {
  const { sessionToken, roomCode } = useGame();
  if (!sessionToken || !roomCode) {
    return <Navigate to="/" replace />;
  }
  return children;
}

// ─────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/"       element={<Home />}   />
      <Route path="/lobby"  element={<Lobby />}  />

      <Route path="/game"   element={
        <SessionGuard><Game /></SessionGuard>
      } />
      <Route path="/voting" element={
        <SessionGuard><Voting /></SessionGuard>
      } />
      <Route path="/result" element={
        <SessionGuard><Result /></SessionGuard>
      } />

      <Route path="/pass-and-play"            element={<PassPlay />}       />
      <Route path="/pass-and-play/game"       element={<PpPlaceholder />}  />
      <Route path="/pass-and-play/roles"      element={<PpRoleReveal />}   />
      <Route path="/pass-and-play/discussion" element={<PpDiscussion />}   />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
