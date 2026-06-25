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
 * One player (the "informant") receives the real word and knows their role.
 * All other players are impostors — they receive the hint and know they
 * are impostors. Goal: the majority must find the one informed player.
 *
 * FIX: previous version gave non-spy players role:'normal', which was wrong.
 * They should know they are impostors (they have a hint, not the word).
 * The informed player is role:'reverse_spy_target'.
 *
 * @param {object[]} players
 * @param {object}   wordEntry
 * @returns {object[]}
 */
function assignReverseSpy(players, wordEntry) {
  const shuffled   = shuffle([...players]);
  const informantId = shuffled[0].id;   // one random player gets the real word
  const clueOrder   = buildClueOrder(players);

  return players.map((p) => ({
    playerId:     p.id,
    role:         p.id === informantId ? 'reverse_spy_target' : 'imposter',
    receivedInfo: p.id === informantId ? wordEntry.word : wordEntry.hint,
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
function assignSimilarWord(players, wordEntry, similarCount) {
  const shuffled    = shuffle([...players]);
  const differentPlayers = new Set(
  shuffled
    .slice(0, similarCount)
    .map(p => p.id)
);
  const clueOrder   = buildClueOrder(players);

  // DESIGN: The odd player must believe they are normal.
  // We store 'similar_word_target' in dbRole for scoring,
  // but emit 'normal' as the socketRole so their UI is identical
  // to every other player. Only their word differs.
  return players.map((p) => {
    const isOdd = differentPlayers.has(p.id);
    return {
      playerId:     p.id,
      dbRole:       isOdd ? 'similar_word_target' : 'normal',   // persisted to round_players
      socketRole:   'normal',                                     // what the player sees
      receivedInfo: isOdd ? wordEntry.alternate_word : wordEntry.word,
      clueOrder:    clueOrder[p.id],
    };
  });
}

/**
 * CHAOS round.
 * Players are split into groups. Each group gets a different real word.
 * Nobody knows this is a chaos round — it appears to be a normal round
 * where everyone happens to give slightly different clues.
 *
 * Group distribution by player count:
 *   4 → 2/2      5 → 3/2      6 → 2/2/2
 *   7 → 3/2/2    8 → 3/3/2    9+ → equal thirds
 *
 * wordEntry.chaosGroups must be an array of 2-3 distinct real words
 * provided by wordService.selectWordsForChaos.
 *
 * @param {object[]} players
 * @param {object}   wordEntry   — must have chaosGroups: string[]
 * @returns {object[]}
 */
function assignChaos(players, wordEntry) {
  const groups    = wordEntry.chaosGroups || ['Alpha', 'Beta'];   // fallback never shown
  const n         = players.length;
  const clueOrder = buildClueOrder(players);

  // Decide how many groups to use (2 or 3)
  const useThreeGroups = groups.length >= 3 && n >= 6;
  const groupCount     = useThreeGroups ? 3 : 2;

  // Build group size distribution — largest group(s) first
  function buildGroupSizes(total, numGroups) {
    const base  = Math.floor(total / numGroups);
    const extra = total % numGroups;
    // First `extra` groups get base+1, rest get base
    return Array.from({ length: numGroups }, (_, i) => base + (i < extra ? 1 : 0));
  }

  const groupSizes  = buildGroupSizes(n, groupCount);
  const shuffled    = shuffle([...players]);

  // Assign each player to a group
  const playerGroups = [];
  let cursor = 0;
  for (let g = 0; g < groupCount; g++) {
    for (let i = 0; i < groupSizes[g]; i++) {
      playerGroups.push({ player: shuffled[cursor], groupIndex: g });
      cursor++;
    }
  }

  return shuffled.map((player, index) => ({
  playerId:     player.id,
  dbRole:       'imposter',
  socketRole:   'normal',
  receivedInfo: groups[index],
  clueOrder:    clueOrder[player.id],
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
  const similarCount = imposterCount;

  // assignNormal and assignReverseSpy return { role } directly.
  // assignSimilarWord and assignChaos return { dbRole, socketRole } to
  // distinguish what is stored in the DB vs what the player sees.
  // Normalise everything to { role, socketRole } before returning.
  let rawAssignments;

  switch (roundType) {
    case ROUND_TYPES.NORMAL:
      rawAssignments = assignNormal(players, wordEntry, imposterCount);
      break;
    case ROUND_TYPES.REVERSE_SPY:
      rawAssignments = assignReverseSpy(players, wordEntry);
      break;
    case ROUND_TYPES.SIMILAR_WORD:
    rawAssignments = assignSimilarWord(
        players,
        wordEntry,
        similarCount
    );
    break;
    case ROUND_TYPES.CHAOS:
      rawAssignments = assignChaos(players, wordEntry);
      break;
    default:
      console.warn(`[roleAssignment] Unknown round type "${roundType}", falling back to normal`);
      rawAssignments = assignNormal(players, wordEntry, imposterCount);
  }

  // Normalise: if dbRole/socketRole exist, promote them; otherwise copy role to both.
  return rawAssignments.map(a => ({
    ...a,
    role:       a.dbRole       ?? a.role,   // what goes into round_players.role (truth)
    socketRole: a.socketRole   ?? a.role,   // what is sent in round:info (what player sees)
  }));
}

module.exports = { buildAssignments, resolveImposterCount };