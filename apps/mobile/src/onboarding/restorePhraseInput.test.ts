/**
 * restorePhraseInput tests — the chip-editor mechanics added on top of
 * core's restore-UI helpers (core's own behavior is pinned in
 * packages/core/src/domain/identity/backupPhraseInput.test.ts).
 *
 * ALICE_PHRASE is the committed throwaway dev identity
 * (dev/test-identities/alice.json) — PoC-format golden material that must
 * stay restorable through this UI.
 */
import { describe, expect, it } from "vitest";

import {
  applySuggestion,
  changeDraft,
  commitDraft,
  deleteBackFromEmptyDraft,
  describeRestorePhrase,
  emptyRestorePhraseState,
  type RestorePhraseState,
  startEditingWord,
} from "./restorePhraseInput";

const ALICE_PHRASE =
  "rich busy academic academic carpet decent royal picture declare bucket " +
  "bracelet brother fangs wavy ancestor scandal retailer rocky drift unwrap";
const ALICE_WORDS = ALICE_PHRASE.split(" ");

const stateWithWords = (words: ReadonlyArray<string>): RestorePhraseState => ({
  words,
  draft: "",
  editingIndex: null,
});

describe("changeDraft", () => {
  it("keeps separator-free typing in the draft", () => {
    const state = changeDraft(emptyRestorePhraseState, "acad");
    expect(state).toEqual({ words: [], draft: "acad", editingIndex: null });
  });

  it("commits the word when a separator is typed", () => {
    const state = changeDraft({ ...emptyRestorePhraseState, draft: "academic" }, "academic ");
    expect(state.words).toEqual(["academic"]);
    expect(state.draft).toBe("");
  });

  it("appends completed words and keeps a trailing fragment as draft", () => {
    const state = changeDraft(stateWithWords(["rich"]), "busy academic aca");
    expect(state.words).toEqual(["rich", "busy", "academic"]);
    expect(state.draft).toBe("aca");
  });

  it("fills all words from a pasted full phrase", () => {
    const state = changeDraft(emptyRestorePhraseState, ALICE_PHRASE);
    expect(state.words).toEqual(ALICE_WORDS);
    expect(state.draft).toBe("");
  });

  it("normalizes commas, newlines, and case in pasted input", () => {
    const messy = ALICE_WORDS.map((w, i) => (i % 2 === 0 ? w.toUpperCase() : w)).join(",\n  ");
    const state = changeDraft(emptyRestorePhraseState, messy);
    expect(state.words).toEqual(ALICE_WORDS);
  });

  it("replaces the whole entry when a full phrase is pasted over existing words", () => {
    const state = changeDraft(stateWithWords(["wrong", "words"]), `${ALICE_PHRASE} `);
    expect(state.words).toEqual(ALICE_WORDS);
    expect(state.editingIndex).toBeNull();
  });

  it("replaces the whole entry when a full phrase is pasted into an edited chip", () => {
    const editing: RestorePhraseState = { words: ["wrong"], draft: "wrong", editingIndex: 0 };
    const state = changeDraft(editing, ALICE_PHRASE);
    expect(state.words).toEqual(ALICE_WORDS);
    expect(state.editingIndex).toBeNull();
  });

  it("writes a committed word into the edited slot", () => {
    const editing: RestorePhraseState = {
      words: ["rich", "bussy", "academic"],
      draft: "busy",
      editingIndex: 1,
    };
    const state = changeDraft(editing, "busy ");
    expect(state.words).toEqual(["rich", "busy", "academic"]);
    expect(state.editingIndex).toBeNull();
    expect(state.draft).toBe("");
  });
});

describe("commitDraft", () => {
  it("appends a non-empty draft", () => {
    const state = commitDraft({ ...emptyRestorePhraseState, draft: "Rich" });
    expect(state.words).toEqual(["rich"]);
  });

  it("cancels chip editing on an empty draft, keeping the original word", () => {
    const state = commitDraft({ words: ["rich"], draft: "", editingIndex: 0 });
    expect(state).toEqual(stateWithWords(["rich"]));
  });
});

describe("startEditingWord / deleteBackFromEmptyDraft", () => {
  it("loads the tapped chip into the draft", () => {
    const state = startEditingWord(stateWithWords(["rich", "busy"]), 1);
    expect(state).toEqual({ words: ["rich", "busy"], draft: "busy", editingIndex: 1 });
  });

  it("commits an in-progress draft before editing a chip", () => {
    const state = startEditingWord({ ...stateWithWords(["rich"]), draft: "busy" }, 0);
    expect(state.words).toEqual(["rich", "busy"]);
    expect(state.draft).toBe("rich");
    expect(state.editingIndex).toBe(0);
  });

  it("pops the last chip back into the draft on backspace", () => {
    const state = deleteBackFromEmptyDraft(stateWithWords(["rich", "busy"]));
    expect(state).toEqual({ words: ["rich"], draft: "busy", editingIndex: null });
  });

  it("removes the edited chip on backspace over an emptied draft", () => {
    const state = deleteBackFromEmptyDraft({ words: ["rich", "busy"], draft: "", editingIndex: 0 });
    expect(state).toEqual(stateWithWords(["busy"]));
  });
});

describe("applySuggestion", () => {
  it("replaces the typed fragment and commits the suggestion", () => {
    const state = applySuggestion({ ...stateWithWords(["rich"]), draft: "bu" }, "busy");
    expect(state.words).toEqual(["rich", "busy"]);
    expect(state.draft).toBe("");
  });

  it("writes the suggestion into the edited chip", () => {
    const state = applySuggestion({ words: ["rich", "xx"], draft: "bu", editingIndex: 1 }, "busy");
    expect(state.words).toEqual(["rich", "busy"]);
    expect(state.editingIndex).toBeNull();
  });
});

describe("describeRestorePhrase", () => {
  it("flags words outside the wordlist as invalid chips", () => {
    const view = describeRestorePhrase(stateWithWords(["rich", "definitelynotaword"]));
    expect(view.chips.map((chip) => chip.status)).toEqual(["valid", "invalid"]);
    expect(view.hasInvalidWords).toBe(true);
    expect(view.canSubmit).toBe(false);
  });

  it("shows the live draft in the edited chip", () => {
    const view = describeRestorePhrase({ words: ["rich", "busy"], draft: "bu", editingIndex: 1 });
    expect(view.chips[1]).toEqual({ index: 1, text: "bu", status: "editing" });
  });

  it("counts an in-progress draft toward the word count", () => {
    const view = describeRestorePhrase({ ...stateWithWords(["rich"]), draft: "bu" });
    expect(view.wordCount).toBe(2);
  });

  it("offers prefix suggestions for the draft", () => {
    const view = describeRestorePhrase({ ...emptyRestorePhraseState, draft: "acad" });
    expect(view.suggestions).toContain("academic");
  });

  it("accepts alice's full phrase as a complete candidate", () => {
    const view = describeRestorePhrase(stateWithWords(ALICE_WORDS));
    expect(view.wordCount).toBe(20);
    expect(view.hasInvalidWords).toBe(false);
    expect(view.canSubmit).toBe(true);
    expect(view.phrase).toBe(ALICE_PHRASE);
  });

  it("never enables submit while the 20th word is only an open prefix", () => {
    const view = describeRestorePhrase({
      ...stateWithWords(ALICE_WORDS.slice(0, 19)),
      draft: "unw", // prefix of "unwrap" — 20 words for core's lenient analysis
    });
    expect(view.wordCount).toBe(20);
    expect(view.canSubmit).toBe(false);
  });

  it("flags more than 20 words", () => {
    const view = describeRestorePhrase(stateWithWords([...ALICE_WORDS, "academic"]));
    expect(view.tooManyWords).toBe(true);
    expect(view.canSubmit).toBe(false);
  });
});
