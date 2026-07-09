// client/src/components/SplashScreen.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Splash overlay — Version 1.
//
//  This is NOT a routed page. It's rendered by App.jsx as an overlay sitting
//  on top of the app content, which is always mounted underneath. Sequence:
//
//    mount → overlay fades in from darkness → logo fades/rises in →
//    subtle ambient float → "Tap to begin" fades in, then pulses gently →
//    user taps anywhere → further taps disabled → light sweep passes across
//    the logo → logo lifts and scales down slightly → overlay fades away →
//    Main Menu fades/slides into place underneath.
//
//  The user can tap at any point — there is no forced minimum delay before
//  the tap handler becomes active. All entrance timing is CSS-only; only
//  the exit sequence needs small JS timers, to stage when the underlying
//  menu starts revealing and when it's safe to unmount this component.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useRef, useState } from 'react';
import logoUrl from '../assets/logo.png';

// These must stay in sync with the CSS exit timings in the "SPLASH SCREEN"
// section of index.css:
//   - the light sweep and logo lift both run on --motion-reveal (~500ms),
//     with the lift starting ~80ms after the sweep so the sweep reads first
//   - the overlay's own fade-out has a 300ms transition-delay, so the menu
//     underneath should start revealing at the same moment
const REVEAL_START_DELAY_MS = 300; // matches .splash's transition-delay
const EXIT_DURATION_MS       = 650; // covers sweep + lift + overlay fade, plus a small buffer

export default function SplashScreen({ onRevealStart, onFinish }) {
  const [exiting, setExiting] = useState(false);
  const triggeredRef = useRef(false);

  const handleBegin = useCallback(() => {
    if (triggeredRef.current) return;
    triggeredRef.current = true;

    // Disables further taps immediately (the CSS also sets
    // pointer-events: none on .splash--exiting for the same reason).
    setExiting(true);

    // The Main Menu begins fading/sliding into place once the overlay
    // itself starts fading — not instantly at tap — so the visible order
    // is: sweep → logo lifts → overlay fades / menu appears together.
    window.setTimeout(() => {
      onRevealStart?.();
    }, REVEAL_START_DELAY_MS);

    window.setTimeout(() => {
      onFinish?.();
    }, EXIT_DURATION_MS);
  }, [onRevealStart, onFinish]);

  return (
    <div
      className={`splash ${exiting ? 'splash--exiting' : ''}`}
      role="button"
      tabIndex={0}
      aria-label="Tap to begin"
      onClick={handleBegin}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleBegin();
        }
      }}
    >
      <div className="splash-logo-wrap">
        <img
          src={logoUrl}
          alt="False Lead"
          className="splash-logo"
          draggable="false"
        />
        <span className="splash-sweep" aria-hidden="true" />
      </div>

      <p className="splash-tap">Tap to begin</p>
    </div>
  );
}