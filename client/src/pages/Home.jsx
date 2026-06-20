// client/src/pages/Home.jsx
// ─────────────────────────────────────────────────────────────────────────────
//  Home page. Two flows live here:
//    1. Create Room — player enters nickname, server creates room, player is host
//    2. Join Room   — player enters nickname + room code, joins existing room
//
//  Both flows end by calling setSession() then navigating to /lobby.
//
//  A session token is generated client-side using crypto.randomUUID().
//  For "Create Room", the token is sent as hostSessionId; the server
//  stores it and later uses it to identify the host.
//  For "Join Room", the server generates and returns a new token.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGame } from '../context/GameContext';
import { createRoom, joinRoom } from '../services/api';

// ── Small helper: which tab is active ───────────────────────────────────────
const TAB_CREATE = 'create';
const TAB_JOIN   = 'join';

export default function Home() {
  const navigate        = useNavigate();
  const { setSession }  = useGame();

  const [activeTab, setActiveTab] = useState(TAB_CREATE);

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

const [totalRounds, setTotalRounds] = useState(3);

  // Clear error whenever the player switches tabs or types
  function clearError() { setError(''); }

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
        <h1 className="home-title">False Lead</h1>
        <p className="home-subtitle">A social deduction party game</p>
      </header>

      <main className="home-main">
        {/* Tab switcher */}
        <div className="tab-bar" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === TAB_CREATE}
            className={`tab-btn ${activeTab === TAB_CREATE ? 'tab-btn--active' : ''}`}
            onClick={() => { setActiveTab(TAB_CREATE); clearError(); }}
          >
            Create Room
          </button>
          <button
            role="tab"
            aria-selected={activeTab === TAB_JOIN}
            className={`tab-btn ${activeTab === TAB_JOIN ? 'tab-btn--active' : ''}`}
            onClick={() => { setActiveTab(TAB_JOIN); clearError(); }}
          >
            Join Room
          </button>
        </div>

        {/* Create Room form */}
        {activeTab === TAB_CREATE && (
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

<div style={{ marginTop: '1rem', marginBottom: '1rem' }}>
  <p><strong>Number of Rounds</strong></p>

  <select
    value={totalRounds}
    onChange={(e) => setTotalRounds(Number(e.target.value))}
  >
    <option value={3}>3 Rounds</option>
    <option value={5}>5 Rounds</option>
    <option value={7}>7 Rounds</option>
    <option value={10}>10 Rounds</option>
  </select>
</div>

<div style={{ marginTop: '1rem', marginBottom: '1rem' }}>
  <p><strong>Special Rounds</strong></p>

  <label style={{ display: 'block' }}>
    <input
      type="checkbox"
      checked={specialRounds.reverse_spy}
      onChange={() =>
        setSpecialRounds(prev => ({
          ...prev,
          reverse_spy: !prev.reverse_spy,
        }))
      }
    />
    {' '}Reverse Spy
  </label>

  <label style={{ display: 'block' }}>
    <input
      type="checkbox"
      checked={specialRounds.similar_word}
      onChange={() =>
        setSpecialRounds(prev => ({
          ...prev,
          similar_word: !prev.similar_word,
        }))
      }
    />
    {' '}Similar Word
  </label>

  <label style={{ display: 'block' }}>
    <input
      type="checkbox"
      checked={specialRounds.chaos}
      onChange={() =>
        setSpecialRounds(prev => ({
          ...prev,
          chaos: !prev.chaos,
        }))
      }
    />
    {' '}Chaos
  </label>
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
        )}

        {/* Join Room form */}
        {activeTab === TAB_JOIN && (
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
        )}
      </main>
    </div>
  );
}
