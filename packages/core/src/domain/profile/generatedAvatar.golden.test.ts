/**
 * Golden tests for generated-avatar / default-profile compatibility (#17).
 *
 * The fixtures in `__fixtures__/generatedAvatar.golden.json` were generated
 * FROM THE POC's own `derivedProfile.ts` before this implementation was
 * written — see `__fixtures__/README.md`. They prove:
 *
 *   - same npub -> same initial avatar selection and DiceBear URL
 *   - every editor control cycles to the same next selection/URL as the PoC
 *     (sequential +1, except clothing's pseudo-random hop)
 *   - same npub -> same deterministic first name (en + cs), same default
 *     Lightning address
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AvatarEditorControlId, AvatarSelection } from "./generatedAvatar.js";
import {
  AVATAR_EDITOR_CONTROL_IDS,
  cycleGeneratedAvatar,
  deriveGeneratedAvatar,
  deriveInitialAvatarSelection,
} from "./generatedAvatar.js";
import { deriveDefaultLightningAddress, deriveDefaultProfile } from "./defaultProfile.js";

interface CycleFixture {
  readonly selection: AvatarSelection;
  readonly pictureUrl: string;
}

interface CaseFixture {
  readonly seed: string;
  readonly initialSelection: AvatarSelection;
  readonly pictureUrl: string;
  readonly cycles: Readonly<Record<AvatarEditorControlId, CycleFixture>>;
  readonly topTwice: CycleFixture;
  readonly defaultProfileEn: { name: string; lnAddress: string; pictureUrl: string };
  readonly defaultProfileCs: { name: string; lnAddress: string; pictureUrl: string };
  readonly lightningAddress: string;
}

const fixtures = JSON.parse(
  readFileSync(new URL("./__fixtures__/generatedAvatar.golden.json", import.meta.url), "utf8"),
) as { readonly cases: ReadonlyArray<CaseFixture> };

describe("generated avatar golden fixtures (PoC compatibility)", () => {
  it("covers npub seeds plus the fallback and empty seeds", () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(4);
    expect(fixtures.cases.some((c) => c.seed.startsWith("npub1"))).toBe(true);
    expect(fixtures.cases.some((c) => c.seed === "")).toBe(true);
  });

  for (const fixture of fixtures.cases) {
    describe(`seed ${JSON.stringify(fixture.seed)}`, () => {
      it("derives the PoC's initial avatar selection", () => {
        expect(deriveInitialAvatarSelection(fixture.seed)).toEqual(fixture.initialSelection);
      });

      it("builds the PoC's DiceBear URL", () => {
        expect(deriveGeneratedAvatar(fixture.seed).pictureUrl).toBe(fixture.pictureUrl);
      });

      for (const controlId of AVATAR_EDITOR_CONTROL_IDS) {
        it(`cycles "${controlId}" exactly like the PoC`, () => {
          const next = cycleGeneratedAvatar(fixture.initialSelection, controlId);
          const expected = fixture.cycles[controlId];
          expect(next.selection).toEqual(expected.selection);
          expect(next.pictureUrl).toBe(expected.pictureUrl);
        });
      }

      it("cycles top twice exactly like the PoC", () => {
        const once = cycleGeneratedAvatar(fixture.initialSelection, "top");
        const twice = cycleGeneratedAvatar(once.selection, "top");
        expect(twice.selection).toEqual(fixture.topTwice.selection);
        expect(twice.pictureUrl).toBe(fixture.topTwice.pictureUrl);
      });

      it("derives the PoC's default profile (en + cs) and Lightning address", () => {
        expect(deriveDefaultProfile(fixture.seed, "en")).toEqual(fixture.defaultProfileEn);
        expect(deriveDefaultProfile(fixture.seed, "cs")).toEqual(fixture.defaultProfileCs);
        expect(deriveDefaultLightningAddress(fixture.seed)).toBe(fixture.lightningAddress);
      });
    });
  }
});
