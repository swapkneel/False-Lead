// client/src/routes/AppRoutes.jsx
import { Routes, Route, Navigate } from 'react-router-dom';
import Home    from '../pages/Home';
import Lobby   from '../pages/Lobby';
import Game    from '../pages/Game';
import Voting  from '../pages/Voting';
import Result  from '../pages/Result';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/"       element={<Home />}   />
      <Route path="/lobby"  element={<Lobby />}  />
      <Route path="/game"   element={<Game />}   />
      <Route path="/voting" element={<Voting />} />
      <Route path="/result" element={<Result />} />
      <Route path="*"       element={<Navigate to="/" replace />} />
    </Routes>
  );
}
