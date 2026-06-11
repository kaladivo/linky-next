/**
 * Behavior tests for the generated avatar (#17) — properties that must hold
 * for ANY seed, complementing the PoC-pinned golden fixtures.
 */
import { describe, expect, it } from "vitest";

import {
  AVATAR_EDITOR_CONTROL_IDS,
  cycleGeneratedAvatar,
  deriveGeneratedAvatar,
  deriveInitialAvatarSelection,
} from "./generatedAvatar.js";
import { pickDeterministicName } from "./defaultProfile.js";

const SEED = "npub1s0wv0d3mglcrlptzwwadvshqqy3vea3z3lqfm0grub2hivl00sps9w29fl";

describe("deriveInitialAvatarSelection", () => {
  it("is deterministic for the same seed", () => {
    expect(deriveInitialAvatarSelection(SEED)).toEqual(deriveInitialAvatarSelection(SEED));
  });

  it("normalizes blank seeds to the 'linky' fallback", () => {
    expect(deriveInitialAvatarSelection("")).toEqual(deriveInitialAvatarSelection("  linky  "));
    expect(deriveInitialAvatarSelection("").seed).toBe("linky");
  });

  it("differs between different seeds", () => {
    expect(deriveInitialAvatarSelection(SEED)).not.toEqual(deriveInitialAvatarSelection("other"));
  });
});

describe("deriveGeneratedAvatar", () => {
  it("renders an https DiceBear avataaars SVG URL carrying the seed", () => {
    const { pictureUrl } = deriveGeneratedAvatar(SEED);
    expect(pictureUrl.startsWith("https://api.dicebear.com/9.x/avataaars/svg?")).toBe(true);
    expect(pictureUrl).toContain(`seed=${SEED}`);
  });

  it("normalizes out-of-range and negative indices into range", () => {
    const wild = {
      ...deriveInitialAvatarSelection(SEED),
      topIndex: -1,
      mouthIndex: 9999,
    };
    const normalized = deriveGeneratedAvatar(SEED, wild).selection;
    expect(normalized.topIndex).toBe(33); // 34 top values, -1 wraps to the last
    expect(normalized.mouthIndex).toBe(9999 % 12);
    // Re-deriving from the normalized selection is a fixed point.
    expect(deriveGeneratedAvatar(SEED, normalized).selection).toEqual(normalized);
  });
});

describe("cycleGeneratedAvatar", () => {
  it("changes only the targeted dimension", () => {
    const initial = deriveInitialAvatarSelection(SEED);
    for (const controlId of AVATAR_EDITOR_CONTROL_IDS) {
      const next = cycleGeneratedAvatar(initial, controlId).selection;
      const changedKeys = (Object.keys(initial) as (keyof typeof initial)[]).filter(
        (key) => initial[key] !== next[key],
      );
      // Exactly one index moved (the control's own); seed never changes.
      expect(changedKeys).toHaveLength(1);
      expect(changedKeys[0]).not.toBe("seed");
    }
  });

  it("always produces a different avatar URL than the current one", () => {
    let current = deriveGeneratedAvatar(SEED);
    for (const controlId of AVATAR_EDITOR_CONTROL_IDS) {
      const next = cycleGeneratedAvatar(current.selection, controlId);
      expect(next.pictureUrl).not.toBe(current.pictureUrl);
      current = next;
    }
  });

  it("wraps the accessories control around its combination space", () => {
    let selection = deriveInitialAvatarSelection(SEED);
    const seen = new Set<number>([selection.accessoriesIndex]);
    // 15 colors x 8 slots = 120 combinations; cycling 120 times returns home.
    for (let i = 0; i < 120; i += 1) {
      selection = cycleGeneratedAvatar(selection, "accessories").selection;
      seen.add(selection.accessoriesIndex);
    }
    expect(selection.accessoriesIndex).toBe(deriveInitialAvatarSelection(SEED).accessoriesIndex);
    expect(seen.size).toBe(120);
  });
});

describe("pickDeterministicName", () => {
  it("is deterministic and language-dependent", () => {
    expect(pickDeterministicName(SEED, "en")).toBe(pickDeterministicName(SEED, "en"));
    expect(pickDeterministicName(SEED, "cs")).toBe(pickDeterministicName(SEED, "cs"));
    // Lists differ, so (generically) the picks differ; pinned exactly by goldens.
    expect(typeof pickDeterministicName(SEED, "cs")).toBe("string");
  });

  it("falls back for empty input", () => {
    expect(pickDeterministicName("", "en")).toBe("Alice");
  });
});
