/**
 * deriveOwnerLaneMnemonics is a composition over deriveOwnerLane (whose
 * byte-level PoC compatibility is golden-tested); here we pin the
 * composition itself: all six domains present, each equal to its lane-0
 * derivation.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { SyncDomain } from "./DerivedIdentities.js";
import { deriveOwnerLane } from "./deriveOwnerLane.js";
import { deriveOwnerLaneMnemonics } from "./deriveOwnerLaneMnemonics.js";
import { MasterSecret } from "./MasterIdentity.js";

const secret = MasterSecret.make(Uint8Array.from({ length: 16 }, (_, i) => i + 1));

describe("deriveOwnerLaneMnemonics", () => {
  it("returns the lane-0 mnemonic for every sync domain", async () => {
    const mnemonics = await Effect.runPromise(deriveOwnerLaneMnemonics(secret));
    expect(Object.keys(mnemonics).sort()).toEqual([...SyncDomain.literals].sort());
    for (const domain of SyncDomain.literals) {
      const lane = await Effect.runPromise(deriveOwnerLane(secret, domain));
      expect(mnemonics[domain]).toBe(lane.mnemonic);
    }
  });
});
