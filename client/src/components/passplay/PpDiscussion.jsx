
import { useLocation, useNavigate } from "react-router-dom";
import "./PpDiscussion.css";

/**
 * PpDiscussion.jsx
 * Phase 2 placeholder — confirms all roles assigned, shows player list.
 * Phase 3 replaces Start Voting with the real voting flow.
 */
const PpDiscussion = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const config = location.state?.config;
  const assignments = location.state?.assignments;

  if (!config || !assignments) {
    return (
      <div className="pp-discussion pp-discussion--empty">
        <p>No game in progress.</p>
        <button
          className="pp-discussion__back-btn"
          onClick={() => navigate("/pass-and-play")}
        >
          Back to Setup
        </button>
      </div>
    );
  }

  const handleStartVoting = () => {
    console.log("[Pass & Play] Start Voting — not yet implemented (Phase 3)");
    alert("Voting coming in Phase 3!");
  };

  return (
    <div className="pp-discussion">
      <header className="pp-discussion__header">
        <div className="pp-discussion__tick" aria-hidden="true">✓</div>
        <h1 className="pp-discussion__title">All roles assigned</h1>
        <p className="pp-discussion__subtitle">
          Discuss with the other players. Who do you think the imposter is?
        </p>
      </header>

      <div className="pp-discussion__round-badge">
        Round 1 of {config.totalRounds}
      </div>

      <div className="pp-discussion__players">
        {assignments.map((a) => (
          <div key={a.playerId} className="pp-discussion__player-chip">
            <span className="pp-discussion__player-initial">
              {a.playerName.charAt(0).toUpperCase()}
            </span>
            <span className="pp-discussion__player-name">{a.playerName}</span>
          </div>
        ))}
      </div>

      <div className="pp-discussion__actions">
        <button className="pp-discussion__vote-btn" onClick={handleStartVoting}>
          Start Voting
        </button>
        <button
          className="pp-discussion__back-btn"
          onClick={() => navigate("/pass-and-play")}
        >
          Abandon Game
        </button>
      </div>
    </div>
  );
};

export default PpDiscussion;
