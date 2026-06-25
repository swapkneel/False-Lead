/**
 * ppRoleAssignment.js
 * ─────────────────────────────────────────────────────────
 * Pure utility — no Socket.IO, no backend, no side effects.
 *
 * Generates MOCK role assignments from a Pass & Play config.
 * Phase 3 will replace buildMockAssignments() with real
 * category-based word selection; everything else stays the same.
 *
 * Role types
 * ──────────
 *   "normal"   – civilian, receives the word
 *   "imposter" – spy, no word (standard mode)
 *
 * Modifier overrides (Phase 3 will flesh these out fully)
 *   reverseSpyEnabled  – imposter receives the word; civilians don't
 *   similarWordEnabled – one civilian receives a similar-but-different word
 *   chaosEnabled       – everyone gets a different word
 *
 * For Phase 2 these flags are recorded on the assignment object so
 * the UI can render them, but the mock data doesn't vary by flag yet.
 */

const MOCK_WORD = "Pizza";
const MOCK_SIMILAR_WORD = "Pasta";

/**
 * @param {Object} config  – the config object from PpSetup
 * @returns {Assignment[]}
 *
 * Assignment shape:
 * {
 *   playerId:    number,
 *   playerName:  string,
 *   role:        "normal" | "imposter",
 *   word:        string | null,
 *   roleLabel:   string,   // display string e.g. "Civilian" / "Imposter"
 * }
 */
export function buildMockAssignments(config) {
  const { players, gameModifiers } = config;
  const {
    reverseSpyEnabled = false,
    similarWordEnabled = false,
    chaosEnabled = false,
  } = gameModifiers || {};

  // Pick one imposter — always the second player in the mock
  // (index 1, or 0 if only one player somehow)
  const imposterIndex = Math.min(1, players.length - 1);

  return players.map((player, index) => {
    const isImposter = index === imposterIndex;

    if (chaosEnabled) {
      // Everyone gets a unique word — no traditional imposter
      return {
        playerId: player.id,
        playerName: player.name,
        role: "normal",
        word: `${MOCK_WORD} ${index + 1}`, // distinct mock words
        roleLabel: "Civilian",
        modifier: "chaos",
      };
    }

    if (reverseSpyEnabled) {
      // Imposter knows the word; civilians are in the dark
      return {
        playerId: player.id,
        playerName: player.name,
        role: isImposter ? "imposter" : "normal",
        word: isImposter ? MOCK_WORD : null,
        roleLabel: isImposter ? "Imposter" : "Civilian",
        modifier: "reverse",
      };
    }

    if (similarWordEnabled && !isImposter && index === 2) {
      // Third player gets the similar word (mock rule)
      return {
        playerId: player.id,
        playerName: player.name,
        role: "normal",
        word: MOCK_SIMILAR_WORD,
        roleLabel: "Civilian",
        modifier: "similar",
      };
    }

    // Standard assignment
    return {
      playerId: player.id,
      playerName: player.name,
      role: isImposter ? "imposter" : "normal",
      word: isImposter ? null : MOCK_WORD,
      roleLabel: isImposter ? "Imposter" : "Civilian",
      modifier: "standard",
    };
  });
}