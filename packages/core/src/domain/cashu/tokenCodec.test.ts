/**
 * Token codec error paths and proof-state helpers (the golden test pins the
 * byte-exact happy paths against PoC fixtures).
 */
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { FakeMint } from "./__tests__/fakeMint.js";
import { mintValidProof } from "./__tests__/helpers.js";
import {
  dedupeProofs,
  filterUnspentProofs,
  partitionProofGroupsByState,
  type CashuProofState,
} from "./proofStates.js";
import {
  buildCashuShareUrl,
  encodeCashuToken,
  extractCashuTokenFromText,
  parseCashuToken,
} from "./tokenCodec.js";

describe("parseCashuToken error paths", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["definitely not a token", "unparseable"],
    ["cashuAnotbase64!!!", "unparseable"],
  ])("rejects %j with reason %s", async (input, reason) => {
    const failure = await Effect.runPromise(Effect.flip(parseCashuToken(input)));
    expect(failure._tag).toBe("InvalidCashuTokenError");
    expect(failure.reason).toBe(reason);
  });
});

describe("encodeCashuToken", () => {
  it("fails with reason unencodable for V4 with a non-hex keyset id", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        encodeCashuToken(
          {
            mintUrl: "https://testnut.cashu.space",
            unit: "sat",
            proofs: [{ id: "b64KeysetId==", amount: 1, secret: "s", C: "02aa" }],
          },
          { version: 4 },
        ),
      ),
    );
    expect(failure._tag).toBe("InvalidCashuTokenError");
    expect(failure.reason).toBe("unencodable");
  });
});

describe("buildCashuShareUrl", () => {
  it("rejects invalid tokens (never wraps garbage)", async () => {
    const failure = await Effect.runPromise(Effect.flip(buildCashuShareUrl("nope")));
    expect(failure._tag).toBe("InvalidCashuTokenError");
  });
});

describe("extractCashuTokenFromText", () => {
  it("returns none for token-free text", () => {
    expect(Option.isNone(extractCashuTokenFromText("hello world"))).toBe(true);
    expect(Option.isNone(extractCashuTokenFromText("https://linky.fit/contact/npub1abc"))).toBe(
      true,
    );
  });
});

describe("proof-state helpers", () => {
  const mint = new FakeMint();
  const proofA = mintValidProof(mint, 1, "state-a");
  const proofB = mintValidProof(mint, 2, "state-b");
  const proofC = mintValidProof(mint, 4, "state-c");

  const state = (y: string, value: string): CashuProofState =>
    ({ Y: y, state: value, witness: null }) as unknown as CashuProofState;

  it("dedupes identical proofs", () => {
    expect(dedupeProofs([proofA, proofB, proofA])).toEqual([proofA, proofB]);
  });

  it("keeps all proofs when the states array does not align", () => {
    expect(filterUnspentProofs([proofA, proofB], [state("y", "SPENT")])).toEqual([
      proofA,
      proofB,
    ]);
  });

  it("filters to UNSPENT when states align", () => {
    expect(
      filterUnspentProofs(
        [proofA, proofB],
        [state("ya", "SPENT"), state("yb", "UNSPENT")],
      ),
    ).toEqual([proofB]);
  });

  it("partitions groups into live / fully spent / unknown", () => {
    const partition = partitionProofGroupsByState(
      [
        { id: "live", proofs: [proofA, proofB] },
        { id: "spent", proofs: [proofC] },
        { id: "pending", proofs: [proofA] },
        { id: "truncated", proofs: [proofB] },
      ],
      [
        state("y1", "SPENT"),
        state("y2", "UNSPENT"),
        state("y3", "SPENT"),
        state("y4", "PENDING"),
        // nothing for "truncated"
      ],
    );
    expect(partition.liveGroups).toEqual([{ id: "live", proofs: [proofB] }]);
    expect(partition.fullySpentIds).toEqual(["spent"]);
    expect(partition.unknownStateIds).toEqual(["pending", "truncated"]);
  });
});
