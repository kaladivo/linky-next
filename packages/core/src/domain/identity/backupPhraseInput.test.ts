/**
 * Backup-phrase input analysis tests — behavior ported from the PoC's
 * `slip39Input.test.ts` plus paste/partial-input cases for the restore UI.
 */
import { describe, expect, it } from "vitest";

import {
  BACKUP_WORD_SUGGESTION_LIMIT,
  analyzeBackupPhraseInput,
  applyBackupWordSuggestion,
  normalizeBackupPhraseInput,
} from "./backupPhraseInput.js";
import { SLIP39_WORDLIST } from "./slip39Wordlist.js";

describe("normalizeBackupPhraseInput", () => {
  it("normalizes commas, semicolons, and mixed whitespace into single spaces", () => {
    expect(normalizeBackupPhraseInput("  academic,ACID\nacne   acquire ; acrobat ")).toBe(
      "academic acid acne acquire acrobat",
    );
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeBackupPhraseInput("  \n\t ")).toBe("");
  });
});

describe("analyzeBackupPhraseInput", () => {
  it("keeps a trailing partial word out of invalid state while it matches a prefix", () => {
    expect(analyzeBackupPhraseInput("academic ac").invalidWords).toEqual([]);
  });

  it("flags unknown completed words", () => {
    expect(analyzeBackupPhraseInput("academic nope").invalidWords).toEqual(["nope"]);
  });

  it("flags a trailing fragment once a separator completes it", () => {
    expect(analyzeBackupPhraseInput("academic ac ").invalidWords).toEqual(["ac"]);
    expect(analyzeBackupPhraseInput("academic ac ").activeFragment).toBe("");
  });

  it("offers prefix suggestions for the active fragment, capped at the limit", () => {
    const analysis = analyzeBackupPhraseInput("academic ac");
    expect(analysis.activeFragment).toBe("ac");
    expect(analysis.suggestions).toContain("acid");
    expect(analysis.suggestions.length).toBeLessThanOrEqual(BACKUP_WORD_SUGGESTION_LIMIT);
    for (const suggestion of analysis.suggestions) {
      expect(suggestion.startsWith("ac")).toBe(true);
      expect(SLIP39_WORDLIST).toContain(suggestion);
    }
  });

  it("offers no suggestions once the fragment is an exact wordlist word", () => {
    expect(analyzeBackupPhraseInput("academic acid").suggestions).toEqual([]);
  });

  it("reports separator fixups for pasted comma/newline input", () => {
    expect(analyzeBackupPhraseInput("academic,acid").hasSeparatorFixups).toBe(true);
    expect(analyzeBackupPhraseInput("academic acid").hasSeparatorFixups).toBe(false);
  });

  it("counts words and marks 20 valid words as a complete candidate", () => {
    const twenty = Array.from({ length: 20 }, () => "academic").join(" ");
    const analysis = analyzeBackupPhraseInput(twenty);
    expect(analysis.wordCount).toBe(20);
    expect(analysis.isCompleteCandidate).toBe(true);

    expect(analyzeBackupPhraseInput("academic acid").isCompleteCandidate).toBe(false);
    expect(
      analyzeBackupPhraseInput(twenty.replace("academic", "nope")).isCompleteCandidate,
    ).toBe(false);
  });

  it("handles empty input", () => {
    const analysis = analyzeBackupPhraseInput("");
    expect(analysis.wordCount).toBe(0);
    expect(analysis.invalidWords).toEqual([]);
    expect(analysis.suggestions).toEqual([]);
    expect(analysis.normalizedInput).toBe("");
  });
});

describe("applyBackupWordSuggestion", () => {
  it("replaces the active partial word with the selected suggestion", () => {
    expect(applyBackupWordSuggestion("academic ac", "acid")).toBe("academic acid");
  });

  it("appends the suggestion when the input ends with a separator", () => {
    expect(applyBackupWordSuggestion("academic ", "acid")).toBe("academic acid");
  });

  it("fills empty input with the suggestion", () => {
    expect(applyBackupWordSuggestion("", "acid")).toBe("acid");
  });

  it("normalizes when the suggestion is empty", () => {
    expect(applyBackupWordSuggestion("academic,ACID ", "")).toBe("academic acid");
  });
});
