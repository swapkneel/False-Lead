// client/src/pages/Home.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Home page — Main Menu.
//
//  Two flows live here:
//    1. Create Room — player enters nickname + settings, server creates room,
//       player is host
//    2. Join Room   — player enters nickname + room code, joins existing room
//
//  Both flows end by calling setSession() then navigating to /lobby.
//
//  A session token is generated client-side using crypto.randomUUID().
//  For "Create Room", the token is sent as hostSessionId; the server
//  stores it and later uses it to identify the host.
//  For "Join Room", the server generates and returns a new token.
//
//  Layout note: this is a menu, not a form-first page. The default view
//  shows three ranked actions (Create / Join / Pass & Play). Choosing
//  Create or Join moves into a focused step with a back button, rather
//  than permanently showing a tab bar + dense settings form. All handler
//  logic and state below is unchanged from the previous version — only
//  the surrounding structure and controls changed.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGame } from '../context/GameContext';
import { createRoom, joinRoom } from '../services/api';
import logoUrl from '../assets/logo.png';

// ── Which step is currently showing ─────────────────────────────────────────
const VIEW_MENU   = 'menu';
const VIEW_CREATE  = 'create';
const VIEW_JOIN    = 'join';

const IMPOSTER_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: '1',    label: '1' },
  { value: '2',    label: '2' },
  { value: '3',    label: '3' },
];

const ROUND_OPTIONS = [3, 5, 7, 10];

const SPECIAL_ROUND_OPTIONS = [
  { key: 'reverse_spy',  label: 'Reverse Spy' },
  { key: 'similar_word', label: 'Similar Word' },
  { key: 'chaos',        label: 'Chaos' },
];

export default function Home() {
  const navigate        = useNavigate();
  const { setSession }  = useGame();

  const [view, setView] = useState(VIEW_MENU);

  // Shared form state
  const [nickname, setNickname]   = useState('');
  const [roomCode, setRoomCode]   = useState('');
  const [loading,  setLoading]    = useState(false);
  const [error,    setError]      = useState('');
  const [specialRounds, setSpecialRounds] = useState({
    reverse_spy: true,
    similar_word: true,
    chaos: true,
  });

  const [imposterCount, setImposterCount] = useState('auto');
  const [totalRounds, setTotalRounds]     = useState(3);

  // Clear error whenever the player switches views or types
  function clearError() { setError(''); }

  function goToMenu() {
    setView(VIEW_MENU);
    clearError();
  }

  // ── Create Room ────────────────────────────────────────────────────────────
  async function handleCreate(e) {
    e.preventDefault();
    clearError();

    const trimmed = nickname.trim();
    if (!trimmed) return setError('Enter a nickname to continue.');

    setLoading(true);
    try {
      // Generate host session token client-side
      const hostSessionId = crypto.randomUUID();

      const { roomCode: newCode } = await createRoom({
        hostSessionId,
        totalRounds,
        settings: {
          special_rounds: specialRounds,
          imposter_count: imposterCount,
        },
      });

      // Immediately join the room so the host has a room_players row
      const { playerId, sessionToken } = await joinRoom({
        roomCode: newCode,
        nickname: trimmed,
      });

      setSession({
        playerId,
        nickname:     trimmed,
        sessionToken,
        roomCode:     newCode,
        isHost:       true,
      });

      navigate('/lobby');

    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Join Room ──────────────────────────────────────────────────────────────
  async function handleJoin(e) {
    e.preventDefault();
    clearError();

    const trimmedNick = nickname.trim();
    const trimmedCode = roomCode.trim().toUpperCase();

    if (!trimmedNick) return setError('Enter a nickname to continue.');
    if (!trimmedCode) return setError('Enter the room code.');
    if (trimmedCode.length !== 6) return setError('Room codes are 6 characters.');

    setLoading(true);
    try {
      const { playerId, sessionToken } = await joinRoom({
        roomCode: trimmedCode,
        nickname: trimmedNick,
      });

      setSession({
        playerId,
        nickname:     trimmedNick,
        sessionToken,
        roomCode:     trimmedCode,
        isHost:       false,
      });

      navigate('/lobby');

    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="home-page">
      <header className="home-header">
        <h1 className="home-logo">
          <img
            src={logoUrl}
            alt="False Lead"
            className="home-logo__img"
            draggable="false"
          />
        </h1>
        <p className="home-subtitle">A social deduction party game</p>
      </header>

      {/* ── Main menu — default view ──────────────────────────────────────── */}
      {view === VIEW_MENU && (
        <nav className="home-menu" aria-label="Main menu" key="menu">
          <button
            type="button"
            className="btn btn--primary btn--full home-menu-btn"
            onClick={() => { setView(VIEW_CREATE); clearError(); }}
          >
            Create Room
          </button>

          <button
            type="button"
            className="btn btn--ghost btn--full home-menu-btn"
            onClick={() => { setView(VIEW_JOIN); clearError(); }}
          >
            Join Room
          </button>

          <button
            type="button"
            className="home-menu-link"
            onClick={() => navigate('/pass-and-play')}
          >
            Pass &amp; Play
          </button>
        </nav>
      )}

      {/* ── Create Room step ──────────────────────────────────────────────── */}
      {view === VIEW_CREATE && (
        <section className="home-step" key="create">
          <div className="home-step__header">
            <button
              type="button"
              className="home-back-btn"
              onClick={goToMenu}
              aria-label="Back to menu"
            >
              ‹
            </button>
            <h2 className="home-step__title">Create Room</h2>
          </div>

          <form className="home-form" onSubmit={handleCreate} noValidate>
            <label className="field-label" htmlFor="create-nickname">
              Your nickname
            </label>
            <input
              id="create-nickname"
              className="field-input"
              type="text"
              placeholder="e.g. Swapnil"
              maxLength={20}
              value={nickname}
              onChange={(e) => { setNickname(e.target.value); clearError(); }}
              autoComplete="off"
              autoFocus
            />

            <div className="settings-block">
              <p className="settings-label">Imposters</p>
              <div className="pill-group" role="radiogroup" aria-label="Imposter count">
                {IMPOSTER_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={imposterCount === opt.value}
                    className={`pill ${imposterCount === opt.value ? 'pill--active' : ''}`}
                    onClick={() => setImposterCount(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-block">
              <p className="settings-label">Number of rounds</p>
              <div className="pill-group" role="radiogroup" aria-label="Number of rounds">
                {ROUND_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={totalRounds === n}
                    className={`pill ${totalRounds === n ? 'pill--active' : ''}`}
                    onClick={() => setTotalRounds(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-block">
              <p className="settings-label">Special rounds</p>
              <div className="toggle-row">
                {SPECIAL_ROUND_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    aria-pressed={specialRounds[opt.key]}
                    className={`toggle-chip ${specialRounds[opt.key] ? 'toggle-chip--active' : ''}`}
                    onClick={() =>
                      setSpecialRounds((prev) => ({
                        ...prev,
                        [opt.key]: !prev[opt.key],
                      }))
                    }
                  >
                    <span className="toggle-chip__check" aria-hidden="true">
                      {specialRounds[opt.key] ? '✓' : ''}
                    </span>
                    <span className="toggle-chip__label">{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {error && <p className="form-error" role="alert">{error}</p>}

            <button
              className="btn btn--primary btn--full"
              type="submit"
              disabled={loading}
            >
              {loading ? 'Creating…' : 'Create Room'}
            </button>
          </form>
        </section>
      )}

      {/* ── Join Room step ────────────────────────────────────────────────── */}
      {view === VIEW_JOIN && (
        <section className="home-step" key="join">
          <div className="home-step__header">
            <button
              type="button"
              className="home-back-btn"
              onClick={goToMenu}
              aria-label="Back to menu"
            >
              ‹
            </button>
            <h2 className="home-step__title">Join Room</h2>
          </div>

          <form className="home-form" onSubmit={handleJoin} noValidate>
            <label className="field-label" htmlFor="join-nickname">
              Your nickname
            </label>
            <input
              id="join-nickname"
              className="field-input"
              type="text"
              placeholder="e.g. Rahul"
              maxLength={20}
              value={nickname}
              onChange={(e) => { setNickname(e.target.value); clearError(); }}
              autoComplete="off"
              autoFocus
            />

            <label className="field-label" htmlFor="join-code">
              Room code
            </label>
            <input
              id="join-code"
              className="field-input field-input--code"
              type="text"
              placeholder="AB12CD"
              maxLength={6}
              value={roomCode}
              onChange={(e) => { setRoomCode(e.target.value.toUpperCase()); clearError(); }}
              autoComplete="off"
              spellCheck={false}
            />

            {error && <p className="form-error" role="alert">{error}</p>}

            <button
              className="btn btn--primary btn--full"
              type="submit"
              disabled={loading}
            >
              {loading ? 'Joining…' : 'Join Room'}
            </button>
          </form>
        </section>
      )}
    </div>
  );
}