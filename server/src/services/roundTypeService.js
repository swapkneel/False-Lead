// server/src/services/roundTypeService.js
// ─────────────────────────────────────────────────────────────────────────────
//  Decides which round type to run next.
//
//  Rules (in priority order):
//    1. chaos    — rare (1-in-8 chance), max once per game, only if enabled
//    2. special  — reverse_spy or similar_word chosen randomly if enabled,
//                  spread across the game so they don't cluster early
//    3. normal   — default fallback, always available
//
//  This service is pure logic — no DB access, no socket calls.
//  It receives everything it needs as arguments so it is easy to test.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// Round type constants — imported by other services so the string
// is never typed twice anywhere in the codebase.
const ROUND_TYPES = {
  NORMAL:       'normal',
  REVERSE_SPY:  'reverse_spy',
  SIMILAR_WORD: 'similar_word',
  CHAOS:        'chaos',
};

/**
 * Determines the round type for the upcoming round.
 *
 * @param {object} params
 * @param {object} params.settings          — room settings_json (already parsed)
 * @param {number} params.currentRound      — 1-based round number being created
 * @param {number} params.totalRounds       — total rounds in the game
 * @param {string[]} params.usedRoundTypes  — round types already used this game
 *
 * @returns {string}  one of the ROUND_TYPES values
 */
function selectRoundType({ settings, currentRound, totalRounds, usedRoundTypes }) {
  const special = settings.special_rounds || {};

  // ── 1. Chaos round ──────────────────────────────────────────────────────
  // Conditions: enabled, not yet used this game, random 1-in-8 chance,
  // and not on the very first or last round (bad UX).
  const chaosAlreadyUsed = usedRoundTypes.includes(ROUND_TYPES.CHAOS);
  const notFirstOrLast   = currentRound > 1 && currentRound < totalRounds;

  if (
    special.chaos === true &&
    !chaosAlreadyUsed &&
    notFirstOrLast &&
    Math.random() < 0.125   // 1-in-8
  ) {
    return ROUND_TYPES.CHAOS;
  }

  // ── 2. Special rounds ───────────────────────────────────────────────────
  // Build a pool of enabled specials, then randomly pick one.
  // Each special type fires at most once per game unless totalRounds is
  // large enough that repetition makes sense (> 5 rounds).
  const maxSpecialUses = totalRounds > 5 ? 2 : 1;

  const availableSpecials = [];

  if (special.reverse_spy === true) {
    const usedCount = usedRoundTypes.filter(t => t === ROUND_TYPES.REVERSE_SPY).length;
    if (usedCount < maxSpecialUses) {
      availableSpecials.push(ROUND_TYPES.REVERSE_SPY);
    }
  }

  if (special.similar_word === true) {
    const usedCount = usedRoundTypes.filter(t => t === ROUND_TYPES.SIMILAR_WORD).length;
    if (usedCount < maxSpecialUses) {
      availableSpecials.push(ROUND_TYPES.SIMILAR_WORD);
    }
  }

  // Only inject a special round after round 1 so players understand
  // the basic game before seeing a variant.
  if (availableSpecials.length > 0 && currentRound > 1) {
    // FIX (Issue 5): old formula produced triggerChance = 1.0 on round 2
    // of a 3-round game (2/max(2,2) = 1.0), meaning both specials always fired.
    //
    // New formula guarantees all enabled specials fire across the game,
    // but caps per-round chance at 0.6 so the distribution feels natural:
    //
    //   roundsRemaining = total - current          (rounds still to play after this one)
    //   specialsRemaining = how many specials left to inject
    //   base chance = specialsRemaining / (roundsRemaining + 1)  — needs to fire in remaining window
    //   capped at 0.6 so no single round feels overwhelmingly likely
    //
    // Examples for 5-round game with 2 specials enabled:
    //   Round 2: 2/(4) = 0.50 — moderate chance
    //   Round 3: 1/(3) = 0.33 — lower (one special already fired)
    //   Round 4: 1/(2) = 0.50 — rises as window closes
    //   Round 5: 1/(1) = 1.00 (capped 0.6) — guaranteed before last round
    const roundsRemaining   = totalRounds - currentRound;
    const specialsRemaining = availableSpecials.length;
    const rawChance         = specialsRemaining / (roundsRemaining + 1);
    const triggerChance     = Math.min(rawChance, 0.6);

    if (Math.random() < triggerChance) {
      const idx = Math.floor(Math.random() * availableSpecials.length);
      return availableSpecials[idx];
    }
  }

  // ── 3. Normal (default) ─────────────────────────────────────────────────
  return ROUND_TYPES.NORMAL;
}

module.exports = { selectRoundType, ROUND_TYPES };
