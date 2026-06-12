// client/src/routes/AppRoutes.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Central route definitions.
//
//  All routes live here so there's one place to look when adding a new page.
//  The /game route is stubbed as a placeholder for the round screen,
//  which will be built in the next phase.
// ─────────────────────────────────────────────────────────────────────────────

import { Routes, Route, Navigate } from 'react-router-dom';
import Home  from '../pages/Home';
import Lobby from '../pages/Lobby';

// Thin placeholder so /lobby → /game navigation doesn't 404
// Replace with the real Game page in the next phase
function GamePlaceholder() {
  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <h2>Game in progress</h2>
      <p>Round screen coming in the next phase.</p>
    </div>
  );
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/"      element={<Home />}            />
      <Route path="/lobby" element={<Lobby />}           />
      <Route path="/game"  element={<GamePlaceholder />} />

      {/* Catch-all: redirect unknown paths to home */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
