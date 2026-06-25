import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import "./PpSetup.css";

/* ─────────────────────────────────────────────
   Constants
───────────────────────────────────────────── */
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 10;

const DEFAULT_STATE = {
  numPlayers: MIN_PLAYERS,
  playerNames: Array(MIN_PLAYERS).fill(""),
  totalRounds: 3,
  reverseSpyEnabled: false,
  similarWordEnabled: false,
  chaosEnabled: false,
};

/* ─────────────────────────────────────────────
   Helpers
───────────────────────────────────────────── */
const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

/**
 * PpSetup
 * Collects all configuration for an offline Pass & Play game.
 * On submit: builds config object, console.logs it, navigates to placeholder.
 */
const PpSetup = () => {
  const navigate = useNavigate();

  const [numPlayers, setNumPlayers] = useState(DEFAULT_STATE.numPlayers);
  const [playerNames, setPlayerNames] = useState(DEFAULT_STATE.playerNames);
  const [totalRounds, setTotalRounds] = useState(DEFAULT_STATE.totalRounds);
  const [reverseSpyEnabled, setReverseSpyEnabled] = useState(DEFAULT_STATE.reverseSpyEnabled);
  const [similarWordEnabled, setSimilarWordEnabled] = useState(DEFAULT_STATE.similarWordEnabled);
  const [chaosEnabled, setChaosEnabled] = useState(DEFAULT_STATE.chaosEnabled);
  const [errors, setErrors] = useState({});

  /* ── Player count change ── */
  const handleNumPlayersChange = useCallback((delta) => {
    setNumPlayers((prev) => {
      const next = clamp(prev + delta, MIN_PLAYERS, MAX_PLAYERS);
      setPlayerNames((names) => {
        if (next > names.length) {
          // Add empty slots
          return [...names, ...Array(next - names.length).fill("")];
        }
        // Trim excess slots
        return names.slice(0, next);
      });
      return next;
    });
    // Clear player-related errors when count changes
    setErrors((prev) => {
      const updated = { ...prev };
      delete updated.players;
      return updated;
    });
  }, []);

  /* ── Name input change ── */
  const handleNameChange = useCallback((index, value) => {
    setPlayerNames((prev) => {
      const updated = [...prev];
      updated[index] = value;
      return updated;
    });
    // Clear individual name error
    setErrors((prev) => {
      const updated = { ...prev };
      if (updated.playerNames) {
        const nameErrors = { ...updated.playerNames };
        delete nameErrors[index];
        if (Object.keys(nameErrors).length === 0) {
          delete updated.playerNames;
        } else {
          updated.playerNames = nameErrors;
        }
      }
      return updated;
    });
  }, []);

  /* ── Rounds change ── */
  const handleRoundsChange = useCallback((delta) => {
    setTotalRounds((prev) => clamp(prev + delta, MIN_ROUNDS, MAX_ROUNDS));
  }, []);

  /* ── Validation ── */
  const validate = () => {
    const newErrors = {};

    if (numPlayers < MIN_PLAYERS) {
      newErrors.players = `At least ${MIN_PLAYERS} players required.`;
    }
    if (numPlayers > MAX_PLAYERS) {
      newErrors.players = `Maximum ${MAX_PLAYERS} players allowed.`;
    }

    const nameErrors = {};
    playerNames.forEach((name, i) => {
      if (!name.trim()) {
        nameErrors[i] = "Name required.";
      }
    });
    if (Object.keys(nameErrors).length > 0) {
      newErrors.playerNames = nameErrors;
    }

    // Check for duplicate names
    const trimmed = playerNames.map((n) => n.trim().toLowerCase());
    const seen = new Set();
    const dupes = {};
    trimmed.forEach((name, i) => {
      if (name && seen.has(name)) {
        dupes[i] = "Duplicate name.";
      }
      seen.add(name);
    });
    if (Object.keys(dupes).length > 0) {
      newErrors.playerNames = { ...(newErrors.playerNames || {}), ...dupes };
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  /* ── Submit ── */
  const handleStartGame = () => {
    if (!validate()) return;

    const config = {
      mode: "pass-and-play",
      players: playerNames.map((name, index) => ({
        id: index + 1,
        name: name.trim(),
      })),
      totalRounds,
      gameModifiers: {
        reverseSpyEnabled,
        similarWordEnabled,
        chaosEnabled,
      },
      createdAt: new Date().toISOString(),
    };

    console.log("[Pass & Play] Game config:", config);

    navigate("/pass-and-play/roles", { state: { config } });
  };

  /* ── Render ── */
  return (
    <div className="pp-setup">
      <header className="pp-setup__header">
        <h1 className="pp-setup__title">Pass &amp; Play</h1>
        <p className="pp-setup__subtitle">Set up your offline game</p>
      </header>

      <div className="pp-setup__body">

        {/* ── Player Count ── */}
        <section className="pp-setup__section">
          <h2 className="pp-setup__section-title">Players</h2>
          <div className="pp-setup__stepper">
            <button
              className="pp-stepper__btn"
              onClick={() => handleNumPlayersChange(-1)}
              disabled={numPlayers <= MIN_PLAYERS}
              aria-label="Remove player"
            >
              −
            </button>
            <span className="pp-stepper__value">{numPlayers}</span>
            <button
              className="pp-stepper__btn"
              onClick={() => handleNumPlayersChange(1)}
              disabled={numPlayers >= MAX_PLAYERS}
              aria-label="Add player"
            >
              +
            </button>
          </div>
          {errors.players && (
            <p className="pp-setup__error">{errors.players}</p>
          )}
        </section>

        {/* ── Player Names ── */}
        <section className="pp-setup__section">
          <h2 className="pp-setup__section-title">Player Names</h2>
          <div className="pp-setup__names-grid">
            {playerNames.map((name, index) => (
              <div key={index} className="pp-setup__name-field">
                <label
                  className="pp-setup__name-label"
                  htmlFor={`player-name-${index}`}
                >
                  Player {index + 1}
                </label>
                <input
                  id={`player-name-${index}`}
                  className={`pp-setup__name-input${
                    errors.playerNames?.[index] ? " pp-setup__name-input--error" : ""
                  }`}
                  type="text"
                  value={name}
                  onChange={(e) => handleNameChange(index, e.target.value)}
                  placeholder={`Player ${index + 1}`}
                  maxLength={24}
                  autoComplete="off"
                />
                {errors.playerNames?.[index] && (
                  <p className="pp-setup__field-error">
                    {errors.playerNames[index]}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* ── Total Rounds ── */}
        <section className="pp-setup__section">
          <h2 className="pp-setup__section-title">Rounds</h2>
          <div className="pp-setup__stepper">
            <button
              className="pp-stepper__btn"
              onClick={() => handleRoundsChange(-1)}
              disabled={totalRounds <= MIN_ROUNDS}
              aria-label="Decrease rounds"
            >
              −
            </button>
            <span className="pp-stepper__value">{totalRounds}</span>
            <button
              className="pp-stepper__btn"
              onClick={() => handleRoundsChange(1)}
              disabled={totalRounds >= MAX_ROUNDS}
              aria-label="Increase rounds"
            >
              +
            </button>
          </div>
        </section>

        {/* ── Game Modifiers ── */}
        <section className="pp-setup__section">
          <h2 className="pp-setup__section-title">Game Modifiers</h2>
          <div className="pp-setup__toggles">
            <ToggleRow
              id="reverse-spy"
              label="Reverse Spy"
              description="The spy knows the word — civilians don't."
              checked={reverseSpyEnabled}
              onChange={setReverseSpyEnabled}
            />
            <ToggleRow
              id="similar-word"
              label="Similar Word"
              description="Civilians receive a word similar to the spy's word."
              checked={similarWordEnabled}
              onChange={setSimilarWordEnabled}
            />
            <ToggleRow
              id="chaos"
              label="Chaos"
              description="Everyone gets a different word — figure out who belongs."
              checked={chaosEnabled}
              onChange={setChaosEnabled}
            />
          </div>
        </section>

        {/* ── Start Game ── */}
        <div className="pp-setup__actions">
          <button className="pp-setup__start-btn" onClick={handleStartGame}>
            Start Game
          </button>
        </div>
      </div>
    </div>
  );
};

/* ─────────────────────────────────────────────
   ToggleRow sub-component
───────────────────────────────────────────── */
const ToggleRow = ({ id, label, description, checked, onChange }) => (
  <div className="pp-toggle-row">
    <div className="pp-toggle-row__text">
      <span className="pp-toggle-row__label">{label}</span>
      <span className="pp-toggle-row__desc">{description}</span>
    </div>
    <button
      id={id}
      role="switch"
      aria-checked={checked}
      className={`pp-toggle${checked ? " pp-toggle--on" : ""}`}
      onClick={() => onChange((prev) => !prev)}
      aria-label={`${label} toggle`}
    >
      <span className="pp-toggle__thumb" />
    </button>
  </div>
);

export default PpSetup;
