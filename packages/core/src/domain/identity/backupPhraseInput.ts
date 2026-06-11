/**
 * Backup-phrase input helpers for the restore UI (#18).
 *
 * Pure, total functions over raw user input (typed or pasted): separator and
 * whitespace normalization, word-level validation against the SLIP-39
 * wordlist, and prefix suggestions for the word being typed. Behavior is
 * ported from the PoC's `slip39Input.ts` so the restore screen feels
 * identical.
 *
 * These helpers only check wordlist membership — whether 20 valid words form
 * a real backup phrase (checksum) is `restoreMasterIdentity` /
 * `isValidBackupPhrase`'s job.
 */
import { BACKUP_PHRASE_WORD_COUNT } from "./MasterIdentity.js";
import { SLIP39_WORDLIST } from "./slip39Wordlist.js";

/** Maximum number of prefix suggestions offered for the word being typed. */
export const BACKUP_WORD_SUGGESTION_LIMIT = 6;

const WORD_SET = new Set(SLIP39_WORDLIST);
const SEPARATORS = /[\s,;]+/;
const TRAILING_SEPARATOR = /[\s,;]+$/;
const SEPARATOR_FIXUPS = /[,;\n\r]/;

export interface BackupPhraseInputAnalysis {
  /** The word fragment currently being typed ("" after a separator). */
  readonly activeFragment: string;
  /** True when the raw input contained commas/semicolons/newlines that were normalized away. */
  readonly hasSeparatorFixups: boolean;
  /**
   * Completed words that are not in the SLIP-39 wordlist. The trailing
   * fragment is excluded while it is still a valid prefix of some word.
   */
  readonly invalidWords: ReadonlyArray<string>;
  /** True when the input has exactly 20 words, all from the wordlist (checksum not checked). */
  readonly isCompleteCandidate: boolean;
  /** Canonical form of the input: lowercase words joined by single spaces. */
  readonly normalizedInput: string;
  /** Wordlist completions for `activeFragment` (empty once it is an exact word). */
  readonly suggestions: ReadonlyArray<string>;
  readonly wordCount: number;
}

const splitInput = (value: string): ReadonlyArray<string> =>
  value
    .toLowerCase()
    .trim()
    .split(SEPARATORS)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);

/**
 * Normalizes raw backup-word input (typed or pasted) into lowercase words
 * separated by single spaces. Handles commas, semicolons, newlines, and any
 * whitespace runs as separators.
 */
export const normalizeBackupPhraseInput = (value: string): string =>
  splitInput(value).join(" ");

/** Analyzes raw input for the restore screen: see {@link BackupPhraseInputAnalysis}. */
export const analyzeBackupPhraseInput = (value: string): BackupPhraseInputAnalysis => {
  const normalizedInput = normalizeBackupPhraseInput(value);
  const words = normalizedInput.length === 0 ? [] : normalizedInput.split(" ");
  const loweredInput = value.toLowerCase();
  const endsWithSeparator = TRAILING_SEPARATOR.test(loweredInput);
  const rawFragments = loweredInput.split(SEPARATORS);
  const activeFragment = endsWithSeparator
    ? ""
    : (rawFragments[rawFragments.length - 1] ?? "").trim();
  const prefixMatches =
    activeFragment.length > 0
      ? SLIP39_WORDLIST.filter((word) => word.startsWith(activeFragment)).slice(
          0,
          BACKUP_WORD_SUGGESTION_LIMIT,
        )
      : [];

  const invalidWords = words.filter((word, index) => {
    const isOpenPrefix =
      !endsWithSeparator &&
      index === words.length - 1 &&
      word === activeFragment &&
      prefixMatches.length > 0;
    if (isOpenPrefix) return false;
    return !WORD_SET.has(word);
  });

  const suggestions =
    activeFragment.length > 0 && !WORD_SET.has(activeFragment) ? prefixMatches : [];

  return {
    activeFragment,
    hasSeparatorFixups: SEPARATOR_FIXUPS.test(value),
    invalidWords,
    isCompleteCandidate:
      words.length === BACKUP_PHRASE_WORD_COUNT && invalidWords.length === 0,
    normalizedInput,
    suggestions,
    wordCount: words.length,
  };
};

/**
 * Applies a picked suggestion to the input: replaces the word being typed,
 * or appends when the input ends with a separator. Returns the normalized
 * input.
 */
export const applyBackupWordSuggestion = (value: string, suggestion: string): string => {
  const normalizedSuggestion = normalizeBackupPhraseInput(suggestion);
  if (normalizedSuggestion.length === 0) return normalizeBackupPhraseInput(value);

  const analysis = analyzeBackupPhraseInput(value);
  const words =
    analysis.normalizedInput.length === 0 ? [] : analysis.normalizedInput.split(" ");

  if (analysis.activeFragment.length > 0 && words.length > 0) {
    return [...words.slice(0, -1), normalizedSuggestion].join(" ");
  }
  if (words.length === 0) return normalizedSuggestion;
  return `${words.join(" ")} ${normalizedSuggestion}`;
};
