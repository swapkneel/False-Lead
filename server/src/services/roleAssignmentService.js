// server/src/services/roleAssignmentService.js
// ─────────────────────────────────────────────────────────────────────────────
//  Builds the role assignment for every player in a round.
//
//  Returns an array of assignment objects — one per player — that are
//  later bulk-inserted into round_players by roundService.
//
//  This service is pure logic: no DB access, no socket calls.
//  Input: players array + word data + round type + imposter count setting.
//  Output: assignments array.
//
//  Assignment shape:
//  {
//    playerId:      number,
//    role:          'normal' | 'imposter' | 'reverse_spy_target' | 'similar_word_target',
//    receivedInfo:  string,   — exactly what will be shown on their screen
//    clueOrder:     number,   — 1-based turn position
//  }
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { ROUND_TYPES } = require('./roundTypeService');

// ─────────────────────────────────────────────
//  Imposter count resolver
// ─────────────────────────────────────────────

/**
 * Resolves how many imposters to assign.
 * "auto" uses the recommended count based on player count.
 * An explicit number is clamped to [1, playerCount - 1] so there
 * is always at least one non-imposter.
 *
 * @param {number|string} imposterCountSetting  — settings.imposter_count
 * @param {number}        playerCount
 * @returns {number}
 */
function resolveImposterCount(imposterCountSetting, playerCount) {
  if (imposterCountSetting === 'auto') {
    if (playerCount <= 5) return 1;
    if (playerCount <= 8) return 2;
    return 3;
  }

  const n = parseInt(imposterCountSetting, 10);
  if (isNaN(n)) return 1;
  return Math.min(Math.max(1, n), playerCount - 1);
}

// ─────────────────────────────────────────────
//  Shuffle helper
// ─────────────────────────────────────────────

/**
 * Fisher-Yates in-place shuffle.
 * Returns the same array (mutated) for chaining convenience.
 *
 * @param {any[]} arr
 * @returns {any[]}
 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─────────────────────────────────────────────
//  Assignment builders (one per round type)
// ─────────────────────────────────────────────

/**
 * NORMAL round.
 * Majority receive the secret word.
 * imposterCount players receive the hint.
 *
 * @param {object[]} players         — [{ id, nickname }]
 * @param {object}   wordEntry       — { word, hint }
 * @param {number}   imposterCount
 * @returns {object[]}
 */
function assignNormal(players, wordEntry, imposterCount) {
  const shuffled   = shuffle([...players]);
  const imposters  = new Set(shuffled.slice(0, imposterCount).map(p => p.id));
  const clueOrder  = buildClueOrder(players);

  return players.map((p) => ({
    playerId:     p.id,
    role:         imposters.has(p.id) ? 'imposter' : 'normal',
    receivedInfo: imposters.has(p.id) ? wordEntry.hint : wordEntry.word,
    clueOrder:    clueOrder[p.id],
  }));
}

/**
 * REVERSE SPY round.
 * One player receives the full word (the "spy").
 * Everyone else receives only the hint.
 * Goal: find the one person who knows the real word.
 *
 * @param {object[]} players
 * @param {object}   wordEntry
 * @returns {object[]}
 */
function assignReverseSpy(players, wordEntry) {
  const shuffled  = shuffle([...players]);
  const spyId     = shuffled[0].id;          // one random player gets the word
  const clueOrder = buildClueOrder(players);

  return players.map((p) => ({
    playerId:     p.id,
    role:         p.id === spyId ? 'reverse_spy_target' : 'normal',
    receivedInfo: p.id === spyId ? wordEntry.word : wordEntry.hint,
    clueOrder:    clueOrder[p.id],
  }));
}

/**
 * SIMILAR WORD round.
 * One player receives the alternate word.
 * Everyone else receives the primary word.
 * No one knows who has the different word.
 *
 * @param {object[]} players
 * @param {object}   wordEntry   — must have both word and alternate_word
 * @returns {object[]}
 */
function assignSimilarWord(players, wordEntry) {
  const shuffled    = shuffle([...players]);
  const oddPlayerId = shuffled[0].id;
  const clueOrder   = buildClueOrder(players);

  return players.map((p) => ({
    playerId:     p.id,
    role:         p.id === oddPlayerId ? 'similar_word_target' : 'normal',
    receivedInfo: p.id === oddPlayerId ? wordEntry.alternate_word : wordEntry.word,
    clueOrder:    clueOrder[p.id],
  }));
}

/**
 * CHAOS round.
 * Every player receives imposter-style treatment.
 * No word exists — everyone gets a generic cover hint.
 * Players don't know this is a chaos round; the game proceeds as normal.
 *
 * @param {object[]} players
 * @returns {object[]}
 */
function assignChaos(players) {
  const clueOrder = buildClueOrder(players);

  return players.map((p) => ({
    playerId:     p.id,
    role:         'imposter',
    receivedInfo: '???',    // everyone is lost — the chaos
    clueOrder:    clueOrder[p.id],
  }));
}

// ─────────────────────────────────────────────
//  Clue order builder
// ─────────────────────────────────────────────

/**
 * Assigns a random clue order to each player.
 * Returns a map of { [playerId]: clueOrderNumber }.
 *
 * @param {object[]} players
 * @returns {object}
 */
function buildClueOrder(players) {
  const order   = {};
  const shuffled = shuffle(players.map(p => p.id));
  shuffled.forEach((id, i) => { order[id] = i + 1; });
  return order;
}

// ─────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────

/**
 * Builds the full role assignment for a round.
 * Dispatches to the correct builder based on roundType.
 *
 * @param {object} params
 * @param {object[]} params.players         — connected players [{ id, nickname }]
 * @param {string}   params.roundType       — one of ROUND_TYPES
 * @param {object}   params.wordEntry       — full word_bank row
 * @param {object}   params.settings        — room settings_json (already parsed)
 *
 * @returns {object[]}  array of assignment objects, one per player
 */
function buildAssignments({ players, roundType, wordEntry, settings }) {
  const imposterCount = resolveImposterCount(
    settings.imposter_count,
    players.length
  );

  switch (roundType) {
    case ROUND_TYPES.NORMAL:
      return assignNormal(players, wordEntry, imposterCount);

    case ROUND_TYPES.REVERSE_SPY:
      return assignReverseSpy(players, wordEntry);

    case ROUND_TYPES.SIMILAR_WORD:
      return assignSimilarWord(players, wordEntry);

    case ROUND_TYPES.CHAOS:
      return assignChaos(players);

    default:
      // Unknown type — fall back to normal so the game never hard-crashes
      console.warn(`[roleAssignment] Unknown round type "${roundType}", falling back to normal`);
      return assignNormal(players, wordEntry, imposterCount);
  }
}

module.exports = { buildAssignments, resolveImposterCount };
