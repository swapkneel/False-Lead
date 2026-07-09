// client/src/App.jsx
import { useCallback, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { GameProvider }  from './context/GameContext';
import AppRoutes         from './routes/AppRoutes';
import SplashScreen      from './components/SplashScreen';
import './index.css';

export default function App() {
  // Splash is an overlay, not a route — AppRoutes is always mounted
  // underneath it. splashActive controls whether the overlay is rendered
  // at all; contentRevealed controls the fade/slide-in of the content
  // beneath it, which starts slightly before the overlay finishes fading
  // out so the transition reads as one continuous motion.
  const [splashActive, setSplashActive]   = useState(true);
  const [contentRevealed, setContentRevealed] = useState(false);

  const handleRevealStart  = useCallback(() => setContentRevealed(true), []);
  const handleSplashFinish = useCallback(() => setSplashActive(false), []);

  const showContent = contentRevealed || !splashActive;

  return (
    <BrowserRouter>
      <GameProvider>
        <div className="app-shell">
          <div
            className={`app-content ${showContent ? 'app-content--revealed' : ''}`}
            aria-hidden={splashActive && !contentRevealed}
          >
            <AppRoutes />
          </div>

          {splashActive && (
            <SplashScreen
              onRevealStart={handleRevealStart}
              onFinish={handleSplashFinish}
            />
          )}
        </div>
      </GameProvider>
    </BrowserRouter>
  );
}