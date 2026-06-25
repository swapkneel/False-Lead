
import { useLocation, useNavigate } from "react-router-dom";

/**
 * PpPlaceholder.jsx
 * Temporary screen shown after Pass & Play setup.
 * Will be replaced by the actual game flow in future phases.
 */
const PpPlaceholder = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const config = location.state?.config;

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Game Starting Soon</h1>
        <p style={styles.subtitle}>
          Phase 2 will implement role assignment and gameplay.
        </p>

        {config && (
          <div style={styles.summary}>
            <p style={styles.summaryItem}>
              <strong>Players:</strong>{" "}
              {config.players.map((p) => p.name).join(", ")}
            </p>
            <p style={styles.summaryItem}>
              <strong>Rounds:</strong> {config.totalRounds}
            </p>
            <p style={styles.summaryItem}>
              <strong>Modifiers:</strong>{" "}
              {[
                config.gameModifiers.reverseSpyEnabled && "Reverse Spy",
                config.gameModifiers.similarWordEnabled && "Similar Word",
                config.gameModifiers.chaosEnabled && "Chaos",
              ]
                .filter(Boolean)
                .join(", ") || "None"}
            </p>
          </div>
        )}

        <button
          style={styles.backBtn}
          onClick={() => navigate("/pass-and-play")}
        >
          ← Back to Setup
        </button>
      </div>
    </div>
  );
};

const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "2rem 1rem",
    boxSizing: "border-box",
  },
  card: {
    textAlign: "center",
    maxWidth: 480,
    width: "100%",
  },
  title: {
    fontSize: "1.75rem",
    fontWeight: 700,
    marginBottom: "0.5rem",
  },
  subtitle: {
    opacity: 0.55,
    marginBottom: "1.5rem",
    fontSize: "0.9rem",
  },
  summary: {
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 10,
    padding: "1rem 1.25rem",
    textAlign: "left",
    marginBottom: "1.5rem",
  },
  summaryItem: {
    margin: "0.4rem 0",
    fontSize: "0.9rem",
  },
  backBtn: {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.25)",
    borderRadius: 8,
    color: "inherit",
    padding: "0.65rem 1.5rem",
    fontSize: "0.9rem",
    cursor: "pointer",
  },
};

export default PpPlaceholder;
