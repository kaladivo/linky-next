/**
 * restorePhraseInput — pure state model for the restore screen's word-chip
 * editor (#18, `onboarding.restore-account`).
 *
 * The screen keeps committed words as editable chips plus one TextInput for
 * the word being typed (the "draft"). This module is the entire behavior:
 * React only forwards events and renders the derived view. Word-level
 * normalization/validation/suggestions come from core's restore-UI helpers
 * (`normalizeBackupPhraseInput`, `analyzeBackupPhraseInput`,
 * `applyBackupWordSuggestion`) — this model adds only the chip mechanics
 * (commit on separator, edit-in-place, paste-fills-everything).
 *
 * Forgiving-paste contract (feature map: "Restore must be forgiving about
 * separators and pasted input"): pasting a full phrase ANYWHERE — appending
 * or while editing a chip — replaces the whole entry. Separators (spaces,
 * commas, semicolons, newlines, any mix) all commit words.
 *
 * Everything passing through here is secret material: never log states,
 * drafts, or phrases.
 */
import {
  analyzeBackupPhraseInput,
  applyBackupWordSuggestion,
  BACKUP_PHRASE_WORD_COUNT,
  normalizeBackupPhraseInput,
  SLIP39_WORDLIST,
} from "@linky/core";

export interface RestorePhraseState {
  /** Committed words, in phrase order. May exceed 20 (shown as an error). */
  readonly words: ReadonlyArray<string>;
  /** Text currently in the input — never contains separators. */
  readonly draft: string;
  /**
   * When non-null, the draft edits `words[editingIndex]` in place instead of
   * appending. The original word stays in `words` until committed/deleted.
   */
  readonly editingIndex: number | null;
}

export const emptyRestorePhraseState: RestorePhraseState = {
  words: [],
  draft: "",
  editingIndex: null,
};

const WORD_SET = new Set<string>(SLIP39_WORDLIST);
const HAS_SEPARATOR = /[\s,;]/;
const ENDS_WITH_SEPARATOR = /[\s,;]$/;

const splitWords = (text: string): ReadonlyArray<string> => {
  const normalized = normalizeBackupPhraseInput(text);
  return normalized.length === 0 ? [] : normalized.split(" ");
};

const replaceSlot = (
  words: ReadonlyArray<string>,
  index: number,
  replacement: ReadonlyArray<string>,
): ReadonlyArray<string> => [...words.slice(0, index), ...replacement, ...words.slice(index + 1)];

/**
 * The input's text changed (typing or paste). Separators commit words:
 *
 * - no separator → just the draft updates;
 * - text splits into ≥20 words (a pasted full phrase) → it REPLACES the
 *   whole entry, wherever it was pasted;
 * - while editing a chip → the typed/pasted words replace that slot;
 * - otherwise → completed words append, a trailing fragment stays as draft.
 */
export const changeDraft = (state: RestorePhraseState, text: string): RestorePhraseState => {
  if (!HAS_SEPARATOR.test(text)) return { ...state, draft: text };

  const incoming = splitWords(text);
  const endsWithSeparator = ENDS_WITH_SEPARATOR.test(text);
  const completed = endsWithSeparator ? incoming : incoming.slice(0, -1);
  const trailing = endsWithSeparator ? "" : (incoming[incoming.length - 1] ?? "");

  // Pasted full phrase: replaces everything, no matter where it was pasted.
  // All words commit as chips — the last one is a pasted complete word, not
  // a fragment being typed.
  if (incoming.length >= BACKUP_PHRASE_WORD_COUNT) {
    return { words: incoming, draft: "", editingIndex: null };
  }

  if (state.editingIndex !== null) {
    // Editing a chip: everything typed into the slot lands in the slot
    // (incl. the trailing fragment — a mid-phrase paste is complete words).
    return {
      words: replaceSlot(state.words, state.editingIndex, incoming),
      draft: "",
      editingIndex: null,
    };
  }

  return { ...state, words: [...state.words, ...completed], draft: trailing };
};

/** Commits the draft (keyboard "done"). An empty draft cancels chip editing. */
export const commitDraft = (state: RestorePhraseState): RestorePhraseState => {
  const word = normalizeBackupPhraseInput(state.draft);
  if (word.length === 0) return { ...state, draft: "", editingIndex: null };
  if (state.editingIndex !== null) {
    return {
      words: replaceSlot(state.words, state.editingIndex, [word]),
      draft: "",
      editingIndex: null,
    };
  }
  return { ...state, words: [...state.words, word], draft: "" };
};

/**
 * A chip was tapped: commit whatever is in the input first, then load the
 * chip's word into the input for in-place editing.
 */
export const startEditingWord = (state: RestorePhraseState, index: number): RestorePhraseState => {
  const committed = commitDraft(state);
  const word = committed.words[index];
  if (word === undefined) return committed;
  return { ...committed, draft: word, editingIndex: index };
};

/**
 * Backspace on an empty input: while editing a chip, removes that chip;
 * otherwise pops the last chip back into the input for editing.
 */
export const deleteBackFromEmptyDraft = (state: RestorePhraseState): RestorePhraseState => {
  if (state.draft.length > 0) return state;
  if (state.editingIndex !== null) {
    return {
      words: replaceSlot(state.words, state.editingIndex, []),
      draft: "",
      editingIndex: null,
    };
  }
  const last = state.words[state.words.length - 1];
  if (last === undefined) return state;
  return { words: state.words.slice(0, -1), draft: last, editingIndex: null };
};

/** A suggestion pill was tapped: the suggested word replaces the draft. */
export const applySuggestion = (
  state: RestorePhraseState,
  suggestion: string,
): RestorePhraseState =>
  // Core's helper resolves fragment-vs-append on the flat draft; with a
  // separator-free draft this yields exactly the suggested word, which then
  // commits through the same path as typing it.
  commitDraft({ ...state, draft: applyBackupWordSuggestion(state.draft, suggestion) });

export type RestoreWordChipStatus = "valid" | "invalid" | "editing";

export interface RestoreWordChip {
  readonly index: number;
  /** Live text: the chip being edited shows the current draft. */
  readonly text: string;
  readonly status: RestoreWordChipStatus;
}

export interface RestorePhraseView {
  readonly chips: ReadonlyArray<RestoreWordChip>;
  /** Words entered so far, counting an in-progress draft (PoC's n/20). */
  readonly wordCount: number;
  /** Prefix completions for the draft (core's analyze, max 6). */
  readonly suggestions: ReadonlyArray<string>;
  /** Canonical phrase for `restoreIdentitySession` — secret, never log. */
  readonly phrase: string;
  /** True when the phrase is 20 known words (checksum still unchecked). */
  readonly canSubmit: boolean;
  readonly hasInvalidWords: boolean;
  readonly tooManyWords: boolean;
}

/** Derives everything the screen renders from the editor state. */
export const describeRestorePhrase = (state: RestorePhraseState): RestorePhraseView => {
  const draftWord = normalizeBackupPhraseInput(state.draft);
  const editing = state.editingIndex;

  const chips = state.words.map((word, index): RestoreWordChip => {
    if (index === editing) return { index, text: state.draft, status: "editing" };
    return { index, text: word, status: WORD_SET.has(word) ? "valid" : "invalid" };
  });

  // The phrase as it stands: the edited slot holds the live draft (dropped
  // entirely while its draft is empty), an appending draft counts as a word.
  const effectiveWords =
    editing !== null
      ? replaceSlot(state.words, editing, draftWord.length > 0 ? [draftWord] : [])
      : draftWord.length > 0
        ? [...state.words, draftWord]
        : state.words;
  const phrase = effectiveWords.join(" ");

  const analysis = analyzeBackupPhraseInput(state.draft);

  return {
    chips,
    wordCount: effectiveWords.length,
    suggestions: analysis.suggestions,
    phrase,
    // Core's full-phrase analysis is lenient about a trailing open prefix;
    // submitting additionally requires the draft itself to be a real word
    // (or empty), so "19 chips + a prefix" can never enable the button.
    canSubmit:
      analyzeBackupPhraseInput(phrase).isCompleteCandidate &&
      (draftWord.length === 0 || WORD_SET.has(draftWord)),
    hasInvalidWords: effectiveWords.some((word) => !WORD_SET.has(word)),
    tooManyWords: effectiveWords.length > BACKUP_PHRASE_WORD_COUNT,
  };
};
