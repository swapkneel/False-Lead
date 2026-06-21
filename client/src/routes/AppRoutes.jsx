// client/src/routes/AppRoutes.jsx
import { Routes, Route, Navigate } from 'react-router-dom';
import Home    from '../pages/Home';
import Lobby   from '../pages/Lobby';
import Game    from '../pages/Game';
import Voting  from '../pages/Voting';
import Result  from '../pages/Result';
import PassPlay from "../pages/PassPlay";
import PpPlaceholder from "../pages/PpPlaceholder";

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/"       element={<Home />}   />
      <Route path="/lobby"  element={<Lobby />}  />
      <Route path="/game"   element={<Game />}   />
      <Route path="/voting" element={<Voting />} />
      <Route path="/result"         element={<Result />} />
      <Route path="/pass-and-play"  element={<PassPlay />} />
      <Route path="/pass-and-play/game" element={<PpPlaceholder />} />
      <Route path="*"               element={<Navigate to="/" replace />} />
    </Routes>
  );
}
