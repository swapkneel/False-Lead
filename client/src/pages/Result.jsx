// client/src/pages/Result.jsx
'use strict';
// Full results screen — see inline comments for detail

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

function VerdictPanel({ eliminatedPlayer, targetPlayer, correctVote, isTie }) {
  if (isTie) {
    return (
      <div className="rs-verdict rs-verdict--tie">
        <div className="rs-verdict__title">VOTE RESULT</div>
        <div className="rs-verdict__tie-label">TIE</div>
        <p className="rs-verdict__sub">No player eliminated. The target survives.</p>
      </div>
    );
  }
  if (!eliminatedPlayer) {
    return (
      <div className="rs-verdict rs-verdict--nobody">
        <div className="rs-verdict__title">VOTE RESULT</div>
        <p className="rs-verdict__sub">No votes were cast.</p>
      </div>
    );
  }
  return (
    <div className={`rs-verdict ${correctVote ? 'rs-verdict--correct' : 'rs-verdict--wrong'}`}>
      <div className="rs-verdict__title">ELIMINATED</div>
      <div className="rs-verdict__name">{eliminatedPlayer.nickname}</div>
      {correctVote ? (
        <div className="rs-verdict__outcome rs-verdict__outcome--correct">
          <span>✓</span>
          <span>{eliminatedPlayer.nickname} was the {ROLE_LABELS[eliminatedPlayer.role] || 'Target'}</span>
        </div>
      ) : (
        <>
          <div className="rs-verdict__outcome rs-verdict__outcome--wrong">
            <span>✗</span>
            <span>{eliminatedPlayer.nickname} was NOT the Target</span>
          </div>
          {targetPlayer && (
            <p className="rs-verdict__real">
              The actual {ROLE_LABELS[targetPlayer.role] || 'target'} was <strong>{targetPlayer.nickname}</strong>
            </p>
          )}
        </>
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

function VoteBreakdown({ voteBreakdown = [] }) {
  if (!voteBreakdown.length) return null;
  return (
    <div className="rs-panel">
      <div className="rs-panel__header">VOTE BREAKDOWN</div>
      <ul className="rs-vote-list">
        {voteBreakdown.map((v, i) => (
          <li key={i} className="rs-vote-item">
            <span className="rs-vote-voter">{v.voterNickname}</span>
            <span className="rs-vote-arrow">→</span>
            <span className="rs-vote-target">{v.targetNickname}</span>
          </li>
        ))}
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
  const [starting,    setStarting]  = useState(false);
  const [socketError, setSocketError] = useState('');
  const roundCreatedRef = useRef(false);

  useEffect(() => {
    if (!sessionToken || !roomCode) navigate('/', { replace: true });
  }, [sessionToken, roomCode, navigate]);

  useEffect(() => {
    if (!sessionToken) return;

    function onRoundResult(data) {
  console.log('ROUND RESULT RECEIVED', data);

  sessionStorage.setItem(
    'lastRoundResult',
    JSON.stringify(data)
  );

  setResult(data);
}

    function onRoundNext(data) {
  console.log('ROUND NEXT RECEIVED', data);

  setNextRound(data);
  setStarting(false);
  roundCreatedRef.current = false;
}

    // Navigation fix — must stay intact
    function onRoundCreated(data) {
      roundCreatedRef.current = true;
      setRoundData({
        roundId:     data.roundId,
        roundNumber: data.roundNumber,
        totalRounds: data.totalRounds,
        category:    data.category,
        clueOrder:   data.clueOrder,
      });
    }

    function onRoundInfo(data) {
      setRoundData({ role: data.role, receivedInfo: data.receivedInfo, myClueOrder: data.clueOrder });
      setPhase('round');
      navigate('/game');
    }

   function onGameFinished(data) {
  console.log('GAME FINISHED RECEIVED', data);

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

    console.log('RESULT SOCKET EFFECT MOUNTED');

    socket.on('round:result',  onRoundResult);
    socket.on('round:next',    onRoundNext);
    socket.on('round:created', onRoundCreated);
    socket.on('round:info',    onRoundInfo);
    socket.on('game:finished', onGameFinished);
    socket.on('error',         onError);

    console.log('RESULT RENDER', {
  nextRound,
  isHost,
  isGameOver
});

console.log('RESULT PAGE STATE', {
  nextRound,
  isHost,
  starting,
  hasResult: !!result
});

    return () => {
      console.log('RESULT SOCKET EFFECT CLEANUP');
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
  console.log('RESULT IS NULL', {
    nextRound,
    isGameOver
  });

  return (
    <div className="rs-page rs-page--loading">
      <div className="loading-case">
        <div className="loading-folder">📋</div>
        <p className="loading-text">PROCESSING RESULTS…</p>
      </div>
    </div>
  );
}

  const { roundType, word, alternateWord, eliminatedPlayer, targetPlayer,
          correctVote, isTie, voteBreakdown, scoreDeltas, scores } = result;

  // Derive roundNumber: nextRound.nextRoundNumber is the NEXT round, so current = next - 1
  const roundNumber = nextRound ? nextRound.nextRoundNumber - 1 : null;
  const totalRounds = nextRound ? nextRound.totalRounds : null;

  console.log('FINAL STATE', {
  isGameOver,
  nextRound,
  isHost,
  hasResult: !!result
});
  return (
    <div className="rs-page">

      <RoundStamp roundType={roundType} roundNumber={roundNumber} totalRounds={totalRounds} />

      <VerdictPanel
        eliminatedPlayer={eliminatedPlayer}
        targetPlayer={targetPlayer}
        correctVote={correctVote}
        isTie={isTie}
      />

      <WordReveal roundType={roundType} word={word} alternateWord={alternateWord} />

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
