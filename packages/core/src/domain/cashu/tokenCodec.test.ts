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

describe("NUT-02 v2 keyset-id tokens (#44 — cashu-ts 2.9.0 decode fallback)", () => {
  // A v2 keyset id: version byte 0x01 + hash bytes (what cdk mints like
  // testnut.cashu.space issue since 0.17). cashu-ts 2.9.0 refuses to decode
  // such tokens without a keysets list; parseCashuToken identity-maps.
  const V2_ID = `01${"ab".repeat(32)}`;
  const v2Proof = {
    id: V2_ID,
    amount: 21,
    secret: "9a6f1f7d3f9f4e0d9af7e3c5b1d2a4c6e8f0a2b4c6d8e0f2a4b6c8d0e2f4a6b8",
    C: "02bc9097997d81afb2cc7346b5e4345a9346bd2a506eb7958598a72f0cf85163ea",
  };

  const encodedV2 = Effect.runSync(
    encodeCashuToken({
      mintUrl: "https://testnut.cashu.space",
      unit: "sat",
      proofs: [v2Proof],
    }),
  );

  it("parses a v2-keyset token, preserving the id exactly as encoded", () => {
    const parsed = Effect.runSync(parseCashuToken(encodedV2));
    expect(parsed.mintUrl).toBe("https://testnut.cashu.space");
    expect(parsed.amount).toBe(21);
    expect(parsed.unit).toBe("sat");
    expect(parsed.proofs).toHaveLength(1);
    // cashu-ts V4-encodes v2 ids in their NUT-02 SHORT form; the lenient
    // decode must hand back that id untouched (mint-bound flows re-map it
    // against real keysets in decodeTokenForMint).
    const decodedId = parsed.proofs[0]!.id;
    expect(decodedId.startsWith("01")).toBe(true);
    expect(V2_ID.startsWith(decodedId)).toBe(true);
    expect(parsed.proofs[0]!.secret).toBe(v2Proof.secret);
  });

  it("extractCashuTokenFromText finds v2-keyset tokens (chat-pay detection)", () => {
    expect(Option.getOrNull(extractCashuTokenFromText(encodedV2))).toBe(encodedV2);
    expect(Option.getOrNull(extractCashuTokenFromText(`payment:\n${encodedV2}\nenjoy`))).toBe(
      encodedV2,
    );
  });

  it("still rejects garbage that merely looks like a token", () => {
    const broken = `${encodedV2.slice(0, 40)}xx`;
    expect(Effect.runSync(Effect.either(parseCashuToken(broken)))._tag).toBe("Left");
  });
});
