
import PpSetup from "../components/passplay/PpSetup";

/**
 * PassPlay.jsx
 * Top-level page for the offline Pass & Play mode.
 * Renders the setup flow (Phase 1).
 * Does NOT touch any Socket.IO or backend code.
 */
const PassPlay = () => {
  return (
    <div className="passplay-page">
      <PpSetup />
    </div>
  );
};

export default PassPlay;
