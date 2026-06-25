import  { useState, useEffect, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { buildMockAssignments } from "./ppRoleAssignment";
import "./PpRoleReveal.css";

/**
 * PpRoleReveal.jsx
 * ─────────────────────────────────────────────────────────
 * Pass-device → Reveal Role → Hide Role → Next player loop.
 *
 * State machine per player:
 *   "pass"   → show "Pass device to <Name>" + Reveal Role button
 *   "reveal" → show role card + Hide Role button
 *
 * After all players have viewed their role, navigate to /pass-and-play/discussion.
 */

const PpRoleReveal = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const config = location.state?.config;

  // Redirect back to setup if no config (e.g. direct URL access)
  useEffect(() => {
    if (!config) {
      navigate("/pass-and-play", { replace: true });
    }
  }, [config, navigate]);

  const [assignments] = useState(() =>
    config ? buildMockAssignments(config) : []
  );

  // Index of the player currently holding the device
  const [currentIndex, setCurrentIndex] = useState(0);
  // "pass" | "reveal"
  const [phase, setPhase] = useState("pass");
  // Animate the card in
  const [cardVisible, setCardVisible] = useState(false);

  const currentAssignment = assignments[currentIndex];
  const isLastPlayer = currentIndex === assignments.length - 1;

  const handleReveal = useCallback(() => {
    setPhase("reveal");
    requestAnimationFrame(() => setCardVisible(true));
  }, []);

  const handleHide = useCallback(() => {
    setCardVisible(false);
    setTimeout(() => {
      if (isLastPlayer) {
        navigate("/pass-and-play/discussion", {
          state: { config, assignments },
        });
      } else {
        setCurrentIndex((i) => i + 1);
        setPhase("pass");
      }
    }, 300);
  }, [isLastPlayer, navigate, config, assignments]);

  if (!config || !currentAssignment) return null;

  return (
    <div className="pp-reveal">
      {/* Progress pill */}
      <div className="pp-reveal__progress">
        <span className="pp-reveal__progress-text">
          {currentIndex + 1} of {assignments.length}
        </span>
      </div>

      {phase === "pass" && (
        <PassScreen
          playerName={currentAssignment.playerName}
          onReveal={handleReveal}
        />
      )}

      {phase === "reveal" && (
        <RevealScreen
          assignment={currentAssignment}
          cardVisible={cardVisible}
          isLastPlayer={isLastPlayer}
          onHide={handleHide}
        />
      )}
    </div>
  );
};

/* ─────────────────────────────────────────────
   PassScreen — "Hand device to X"
───────────────────────────────────────────── */
const PassScreen = ({ playerName, onReveal }) => (
  <div className="pp-reveal__pass-screen">
    <div className="pp-reveal__device-icon" aria-hidden="true">📱</div>
    <p className="pp-reveal__instruction">Pass the device to</p>
    <h1 className="pp-reveal__player-name">{playerName}</h1>
    <p className="pp-reveal__sub">Only look at the screen when it's your turn.</p>
    <button className="pp-reveal__cta-btn" onClick={onReveal}>
      Reveal My Role
    </button>
  </div>
);

/* ─────────────────────────────────────────────
   RevealScreen — shows role card
───────────────────────────────────────────── */
const RevealScreen = ({ assignment, cardVisible, isLastPlayer, onHide }) => {
  const isImposter = assignment.role === "imposter";
  const isChaos = assignment.modifier === "chaos";
  const isReverse = assignment.modifier === "reverse";

  return (
    <div className="pp-reveal__reveal-screen">
      <p className="pp-reveal__for-name">
        For <strong>{assignment.playerName}</strong>
      </p>

      <div
        className={[
          "pp-role-card",
          isImposter ? "pp-role-card--imposter" : "pp-role-card--normal",
          cardVisible ? "pp-role-card--visible" : "",
        ].join(" ")}
        aria-live="polite"
      >
        <div className="pp-role-card__badge">
          <span className="pp-role-card__badge-label">ROLE</span>
          <span className="pp-role-card__badge-value">{assignment.roleLabel}</span>
        </div>

        {assignment.word ? (
          <div className="pp-role-card__word-section">
            <span className="pp-role-card__word-label">
              {isChaos
                ? "YOUR WORD"
                : isReverse && !isImposter
                ? "WORD"
                : "THE WORD IS"}
            </span>
            <span className="pp-role-card__word">{assignment.word}</span>
            {assignment.modifier === "similar" && (
              <span className="pp-role-card__modifier-note">
                ⚠ Your word may differ slightly from others
              </span>
            )}
          </div>
        ) : (
          <div className="pp-role-card__no-word">
            <span className="pp-role-card__no-word-text">
              {isReverse
                ? "You know the word — others don't."
                : "Figure out the word from the discussion."}
            </span>
          </div>
        )}
      </div>

      <button className="pp-reveal__hide-btn" onClick={onHide}>
        {isLastPlayer ? "Start Discussion →" : "Hide & Pass Device"}
      </button>
    </div>
  );
};

export default PpRoleReveal;
