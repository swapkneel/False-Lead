// client/src/pages/Result.jsx
'use strict';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate }                               from 'react-router-dom';
import { useGame }                                   from '../context/GameContext';
import socket                                        from '../services/socket';

const ROUND_TYPE_LABELS = {
  normal:       'Normal Round',
  similar_word: 'Similar Word Round',
  reverse_spy:  'Reverse Spy Round',
  chaos:        'Chaos Round',
};

const ROLE_LABELS = {
  imposter:            'Impostor',
  similar_word_target: 'Odd One',
  reverse_spy_target:  'Informant',
  normal:              'Agent',
};

function RoundStamp({ roundType, roundNumber, totalRounds }) {
  return (
    <div className="rs-stamp">
      {roundNumber && (
        <div className="rs-stamp__round">ROUND {roundNumber} / {totalRounds}</div>
      )}
      <div className="rs-stamp__type">{ROUND_TYPE_LABELS[roundType] || roundType}</div>
    </div>
  );
}

// VerdictPanel — multi-elimination aware.
//
// Rules:
//   eliminatedPlayers.length > 0  → show each eliminated player, then tie notice if partial
//   eliminatedPlayers.length === 0 && isTie  → full tie, nobody eliminated
//   eliminatedPlayers.length === 0 && !isTie → no votes cast
//
// "isTie" means one or more later slots were blocked. It does NOT mean nobody
// was eliminated — partial eliminations (some slots filled, later slot tied)
// are valid. The tie banner is shown as a sub-note below confirmed eliminations.
function VerdictPanel({ eliminatedPlayers = [], targetPlayers = [], correctVote, isTie }) {
  const hasEliminations = eliminatedPlayers.length > 0;

  // Full tie: nobody eliminated at all
  if (!hasEliminations && isTie) {
    return (
      <div className="rs-verdict rs-verdict--tie">
        <div className="rs-verdict__title">VOTE RESULT</div>
        <div className="rs-verdict__tie-label">TIE</div>
        <p className="rs-verdict__sub">No player eliminated. The targets survive.</p>
      </div>
    );
  }

  // No votes cast
  if (!hasEliminations) {
    return (
      <div className="rs-verdict rs-verdict--nobody">
        <div className="rs-verdict__title">VOTE RESULT</div>
        <p className="rs-verdict__sub">No votes were cast.</p>
      </div>
    );
  }

  // One or more players eliminated
  // correctVote = true if at least one eliminated player was a target role
  const survivingTargets = targetPlayers.filter(
    t => !eliminatedPlayers.some(e => e.id === t.id)
  );

  return (
    <div className={`rs-verdict ${correctVote ? 'rs-verdict--correct' : 'rs-verdict--wrong'}`}>
      <div className="rs-verdict__title">ELIMINATED</div>

      {eliminatedPlayers.map((ep) => {
        const wasTarget = ['imposter', 'reverse_spy_target', 'similar_word_target'].includes(ep.role);
        return (
          <div key={ep.id} className="rs-verdict__entry">
            <div className="rs-verdict__name">{ep.nickname}</div>
            {wasTarget ? (
              <div className="rs-verdict__outcome rs-verdict__outcome--correct">
                <span>✓</span>
                <span>{ep.nickname} was the {ROLE_LABELS[ep.role] || 'Target'}</span>
              </div>
            ) : (
              <div className="rs-verdict__outcome rs-verdict__outcome--wrong">
                <span>✗</span>
                <span>{ep.nickname} was NOT a Target</span>
              </div>
            )}
          </div>
        );
      })}

      {/* Show surviving targets when at least one wrong elimination happened */}
      {!correctVote && survivingTargets.length > 0 && (
        <p className="rs-verdict__real">
          The actual {survivingTargets.length === 1 ? 'target' : 'targets'}:{' '}
          <strong>{survivingTargets.map(t => t.nickname).join(', ')}</strong>
        </p>
      )}

      {/* Partial tie notice: some slots were filled but later slots were blocked */}
      {isTie && (
        <p className="rs-verdict__sub rs-verdict__sub--tie">
          Further eliminations were tied.
        </p>
      )}
    </div>
  );
}

function WordReveal({ roundType, word, alternateWord }) {
  if (roundType === 'normal') {
    return (
      <div className="rs-reveal">
        <div className="rs-reveal__header">CLASSIFIED WORD</div>
        <div className="rs-reveal__word">{word}</div>
      </div>
    );
  }
  if (roundType === 'similar_word') {
    return (
      <div className="rs-reveal">
        <div className="rs-reveal__header">SIMILAR WORD ROUND</div>
        <div className="rs-reveal__row">
          <div className="rs-reveal__cell">
            <span className="rs-reveal__cell-label">MAIN WORD</span>
            <span className="rs-reveal__cell-value">{word}</span>
          </div>
          <div className="rs-reveal__cell">
            <span className="rs-reveal__cell-label">ODD WORD</span>
            <span className="rs-reveal__cell-value">{alternateWord}</span>
          </div>
        </div>
      </div>
    );
  }
  if (roundType === 'reverse_spy') {
    return (
      <div className="rs-reveal">
        <div className="rs-reveal__header">REVERSE SPY ROUND</div>
        <div className="rs-reveal__row">
          <div className="rs-reveal__cell">
            <span className="rs-reveal__cell-label">WORD</span>
            <span className="rs-reveal__cell-value">{word}</span>
          </div>
          <div className="rs-reveal__cell">
            <span className="rs-reveal__cell-label">HINT</span>
            <span className="rs-reveal__cell-value">{alternateWord}</span>
          </div>
        </div>
      </div>
    );
  }
  if (roundType === 'chaos') {
    return (
      <div className="rs-reveal">
        <div className="rs-reveal__header">CHAOS ROUND</div>
        <div className="rs-reveal__row">
          <div className="rs-reveal__cell">
            <span className="rs-reveal__cell-label">GROUP A</span>
            <span className="rs-reveal__cell-value">{word}</span>
          </div>
          <div className="rs-reveal__cell">
            <span className="rs-reveal__cell-label">GROUP B</span>
            <span className="rs-reveal__cell-value">{alternateWord}</span>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

/**
 * VoteTally — new panel above VoteBreakdown.
 * Shows every player's vote count sorted descending so players can
 * immediately see the outcome without manually counting.
 * voteCounts is the { [playerId]: count } object already in the result payload.
 * scores is the updated scores array — used to look up nicknames by playerId.
 */
function VoteTally({ voteCounts = {}, scores = [] }) {
  if (!Object.keys(voteCounts).length) return null;

  // Build nickname lookup from scores array (already contains all players)
  const nicknameMap = {};
  for (const p of scores) {
    nicknameMap[p.playerId] = p.nickname;
  }

  // Sort descending by vote count
  const rows = Object.entries(voteCounts)
    .map(([id, count]) => ({ playerId: Number(id), count }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="rs-panel">
      <div className="rs-panel__header">VOTE TALLY</div>
      <ul className="rs-tally-list">
        {rows.map(({ playerId, count }) => (
          <li key={playerId} className="rs-tally-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.35rem 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <span className="rs-tally-name">{nicknameMap[playerId] || `Player ${playerId}`}</span>
            <span className="rs-tally-count" style={{ fontVariantNumeric: 'tabular-nums', minWidth: '5rem', textAlign: 'right', opacity: 0.8 }}>{count} {count === 1 ? 'vote' : 'votes'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * VoteBreakdown — one row per voter, targets joined with ", ".
 * Input from server is one entry per (voter, target) pair.
 */
function VoteBreakdown({ voteBreakdown = [] }) {
  if (!voteBreakdown.length) return null;

  // Group by voterId, preserving first-seen order
  const voterOrder = [];
  const grouped = {};
  for (const v of voteBreakdown) {
    if (!grouped[v.voterId]) {
      voterOrder.push(v.voterId);
      grouped[v.voterId] = { voterNickname: v.voterNickname, targetNicknames: [] };
    }
    grouped[v.voterId].targetNicknames.push(v.targetNickname);
  }

  return (
    <div className="rs-panel">
      <div className="rs-panel__header">VOTE BREAKDOWN</div>
      <ul className="rs-vote-list">
        {voterOrder.map((voterId) => {
          const { voterNickname, targetNicknames } = grouped[voterId];
          return (
            <li key={voterId} className="rs-vote-item">
              <span className="rs-vote-voter">{voterNickname}</span>
              <span className="rs-vote-arrow">→</span>
              <span className="rs-vote-target">{targetNicknames.join(', ')}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ScoreChanges({ scores = [], scoreDeltas = {}, playerId }) {
  if (!scores.length) return null;
  return (
    <div className="rs-panel">
      <div className="rs-panel__header">SCORE CHANGES</div>
      <ul className="rs-score-list">
        {scores.map((player) => {
          const delta = scoreDeltas[player.playerId] ?? 0;
          const isMe  = player.playerId === playerId;
          return (
            <li key={player.playerId} className={`rs-score-item ${isMe ? 'rs-score-item--me' : ''}`}>
              <span className="rs-score-name">{player.nickname}</span>
              <span className={`rs-score-delta ${delta > 0 ? 'rs-score-delta--pos' : delta < 0 ? 'rs-score-delta--neg' : 'rs-score-delta--zero'}`}>
                {delta > 0 ? `+${delta}` : delta === 0 ? '±0' : delta}
              </span>
              <span className="rs-score-total">{player.score}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Leaderboard({ scores = [], playerId }) {
  if (!scores.length) return null;
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  return (
    <div className="rs-panel">
      <div className="rs-panel__header">STANDINGS</div>
      <ol className="rs-leaderboard">
        {sorted.map((player, i) => (
          <li key={player.playerId} className={`rs-lb-item ${player.playerId === playerId ? 'rs-lb-item--me' : ''}`}>
            <span className="rs-lb-rank">{i + 1}</span>
            <span className="rs-lb-name">{player.nickname}</span>
            <span className="rs-lb-score">{player.score}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function Result() {
  const navigate = useNavigate();
  const { sessionToken, roomCode, isHost, playerId, setPhase, setRoundData } = useGame();

  const [result, setResult] = useState(() => {
    const saved = sessionStorage.getItem('lastRoundResult');
    return saved ? JSON.parse(saved) : null;
  });
  const [nextRound, setNextRound] = useState(() => {
    const saved = sessionStorage.getItem('nextRoundInfo');
    return saved ? JSON.parse(saved) : null;
  });
  const [isGameOver, setIsGameOver] = useState(
    sessionStorage.getItem('gameFinished') === 'true'
  );

  const [starting,    setStarting]    = useState(false);
  const [socketError, setSocketError] = useState('');
  const roundCreatedRef = useRef(false);

  useEffect(() => {
    if (!sessionToken || !roomCode) navigate('/', { replace: true });
  }, [sessionToken, roomCode, navigate]);

  useEffect(() => {
    if (!sessionToken) return;

    function onRoundResult(data) {
      sessionStorage.removeItem('gameFinished');
      sessionStorage.setItem('lastRoundResult', JSON.stringify(data));
      setResult(data);
    }

    function onRoundNext(data) {
      setNextRound(data);
      setStarting(false);
      roundCreatedRef.current = false;
    }

    function onRoundCreated(data) {
      roundCreatedRef.current = true;
      setRoundData({
        roundId:       data.roundId,
        roundNumber:   data.roundNumber,
        totalRounds:   data.totalRounds,
        category:      data.category,
        clueOrder:     data.clueOrder,
        imposterCount: data.imposterCount,
      });
    }

    function onRoundInfo(data) {
      setRoundData({ role: data.role, receivedInfo: data.receivedInfo, myClueOrder: data.clueOrder });
      setPhase('round');
      navigate('/game');
    }

    function onGameFinished(data) {
      sessionStorage.setItem('gameFinished', 'true');
      if (data?.finalScores) {
        setResult(prev => prev ? { ...prev, scores: data.finalScores } : prev);
      }
      setIsGameOver(true);
      setNextRound(null);
      setPhase('finished');
    }

    function onError(err) {
      setStarting(false);
      setSocketError(err.message || 'Something went wrong.');
    }

    socket.on('round:result',  onRoundResult);
    socket.on('round:next',    onRoundNext);
    socket.on('round:created', onRoundCreated);
    socket.on('round:info',    onRoundInfo);
    socket.on('game:finished', onGameFinished);
    socket.on('error',         onError);

    return () => {
      socket.off('round:result',  onRoundResult);
      socket.off('round:next',    onRoundNext);
      socket.off('round:created', onRoundCreated);
      socket.off('round:info',    onRoundInfo);
      socket.off('game:finished', onGameFinished);
      socket.off('error',         onError);
    };
  }, [sessionToken, setRoundData, setPhase, navigate]);

  const handleStartNext = useCallback(() => {
    if (starting) return;
    sessionStorage.removeItem('nextRoundInfo');
    setStarting(true);
    setSocketError('');
    socket.emit('round:start-next');
  }, [starting]);

  if (!result) {
    return (
      <div className="rs-page rs-page--loading">
        <div className="loading-case">
          <div className="loading-folder">📋</div>
          <p className="loading-text">PROCESSING RESULTS…</p>
        </div>
      </div>
    );
  }

  const { roundType, word, alternateWord,
          eliminatedPlayers = [], targetPlayers = [],
          correctVote, isTie, voteCounts, voteBreakdown, scoreDeltas, scores } = result;

  const roundNumber = nextRound ? nextRound.nextRoundNumber - 1 : null;
  const totalRounds = nextRound ? nextRound.totalRounds : null;

  return (
    <div className="rs-page">

      <RoundStamp roundType={roundType} roundNumber={roundNumber} totalRounds={totalRounds} />

      <VerdictPanel
        eliminatedPlayers={eliminatedPlayers}
        targetPlayers={targetPlayers}
        correctVote={correctVote}
        isTie={isTie}
      />

      <WordReveal roundType={roundType} word={word} alternateWord={alternateWord} />

      <VoteTally voteCounts={voteCounts} scores={scores} />

      <VoteBreakdown voteBreakdown={voteBreakdown} />

      <ScoreChanges scores={scores} scoreDeltas={scoreDeltas} playerId={playerId} />

      <Leaderboard scores={scores} playerId={playerId} />

      {socketError && <p className="form-error" role="alert">{socketError}</p>}

      <div className="rs-next-wrapper">
        {isGameOver ? (
          <div className="rs-game-over">
            <p className="rs-game-over__title">Game Over</p>
            <button
              className="btn btn--ghost btn--full"
              onClick={() => {
                sessionStorage.removeItem('gameFinished');
                sessionStorage.removeItem('nextRoundInfo');
                navigate('/');
              }}
            >
              Back to Home
            </button>
          </div>
        ) : nextRound && isHost ? (
          <button
            className="btn btn--primary btn--full rs-next-btn"
            onClick={handleStartNext}
            disabled={starting}
          >
            {starting ? 'Starting…' : `Start Round ${nextRound.nextRoundNumber} of ${nextRound.totalRounds}`}
          </button>
        ) : nextRound && !isHost ? (
          <p className="rs-waiting">Waiting for host to start the next round…</p>
        ) : (
          <p className="rs-waiting">Calculating results…</p>
        )}
      </div>

    </div>
  );
}
