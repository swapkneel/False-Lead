// client/src/App.jsx
import { BrowserRouter } from 'react-router-dom';
import { GameProvider }  from './context/GameContext';
import AppRoutes         from './routes/AppRoutes';
import './index.css';

export default function App() {
  return (
    <BrowserRouter>
      <GameProvider>
        <div className="app-shell">
          <AppRoutes />
        </div>
      </GameProvider>
    </BrowserRouter>
  );
}
