// client/src/routes/AppRoutes.jsx
import { Routes, Route, Navigate } from 'react-router-dom';
import Home  from '../pages/Home';
import Lobby from '../pages/Lobby';
import Game  from '../pages/Game';

// Placeholder — replace when voting screen is built
function VotingPlaceholder() {
  return (
    <div style={{ padding: '2rem', textAlign: 'center', color: '#e8eaf0' }}>
      <h2>Voting phase</h2>
      <p style={{ color: '#7b8099', marginTop: '0.5rem' }}>Voting screen coming next.</p>
    </div>
  );
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/"       element={<Home />}              />
      <Route path="/lobby"  element={<Lobby />}             />
      <Route path="/game"   element={<Game />}              />
      <Route path="/voting" element={<VotingPlaceholder />} />

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
