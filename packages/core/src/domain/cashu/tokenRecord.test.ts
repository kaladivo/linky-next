import { Either, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { CashuProofState } from "./proofStates.js";
import { partitionProofGroupsByState } from "./proofStates.js";
import type { TokenRecord } from "./tokenRecord.js";
import {
  deleteTokenRecord,
  externalizeTokenRecord,
  isDefinitivelySpentErrorMessage,
  isPurgeableTokenRecord,
  markTokenRecordError,
  markTokenRecordInFlight,
  markTokenRecordIssued,
  markTokenRecordSpent,
  reconcileTokenRecord,
  reconcileTokenRecords,
  recoverTokenRecord,
  reserveTokenRecord,
  returnTokenRecordToWallet,
  selectPurgeableTokenRecords,
  tokenRecordErrorRecovery,
  tokenRecordFromMeltChange,
  tokenRecordFromReceive,
  tokenRecordFromTopup,
  tokenRecordsFromRestore,
  tokenRecordsFromSend,
  transitionTokenRecord,
} from "./tokenRecord.js";
import type { CashuProof } from "./tokenCodec.js";
import type { TokenState, TokenStateTransitionTag } from "./tokenState.js";
import {
  TOKEN_STATES,
  TOKEN_STATE_TRANSITIONS,
  TokenStateTransition,
  canTransitionTokenState,
} from "./tokenState.js";

const MINT = "https://mint.example.com";
const T0 = 1_700_000_000_000;
const T1 = T0 + 60_000;

const record = (overrides: Partial<TokenRecord> = {}): TokenRecord => ({
  id: "tok-1",
  mintUrl: MINT,
  unit: "sat",
  amount: 21,
  state: "accepted",
  token: "cashuBfixture",
  error: null,
  createdAtMillis: T0,
  updatedAtMillis: T0,
  ...overrides,
});

const proof = (amount: number, secret: string): CashuProof => ({
  id: "009a1f293253e41e",
  amount,
  secret,
  C: "02deadbeef",
});

const proofState = (state: "UNSPENT" | "SPENT" | "PENDING"): CashuProofState =>
  ({ Y: "02ab", state }) as CashuProofState;

const TRANSITION_VALUES = {
  Emit: TokenStateTransition.Emit(),
  MarkInFlight: TokenStateTransition.MarkInFlight(),
  Reserve: TokenStateTransition.Reserve(),
  Externalize: TokenStateTransition.Externalize(),
  Return: TokenStateTransition.Return(),
  MarkSpent: TokenStateTransition.MarkSpent(),
  MarkError: TokenStateTransition.MarkError({ message: "boom" }),
  Recover: TokenStateTransition.Recover(),
  Delete: TokenStateTransition.Delete(),
} as const;

const ALL_TAGS = Object.keys(TRANSITION_VALUES) as TokenStateTransitionTag[];

describe("transitionTokenRecord", () => {
  it.each(TOKEN_STATES.flatMap((from) => ALL_TAGS.map((tag) => [from, tag] as const)))(
    "applies or rejects (%s, %s) per the legal table",
    (from, tag) => {
      const start = record({ state: from, error: from === "error" ? "old failure" : null });
      const result = transitionTokenRecord(start, TRANSITION_VALUES[tag], T1);

      if (!canTransitionTokenState(from, tag)) {
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left._tag).toBe("IllegalTokenStateTransitionError");
          expect(result.left.from).toBe(from);
          expect(result.left.transition).toBe(tag);
        }
        return;
      }

      expect(Either.isRight(result)).toBe(true);
      if (Either.isRight(result)) {
        const next = result.right;
        expect(next.state).toBe(TOKEN_STATE_TRANSITIONS[tag].to);
        expect(next.updatedAtMillis).toBe(T1);
        expect(next.createdAtMillis).toBe(T0);
        expect(next.error).toBe(tag === "MarkError" ? "boom" : null);
        // Identity and value fields never change through a state transition.
        expect(next.id).toBe(start.id);
        expect(next.mintUrl).toBe(start.mintUrl);
        expect(next.unit).toBe(start.unit);
        expect(next.amount).toBe(start.amount);
        expect(next.token).toBe(start.token);
      }
    },
  );

  it("never mutates the input record", () => {
    const start = record();
    void transitionTokenRecord(start, TRANSITION_VALUES.Emit, T1);
    expect(start.state).toBe("accepted");
    expect(start.updatedAtMillis).toBe(T0);
  });
});

describe("named transition helpers", () => {
  it("walk the emit → in-flight → returned → reserved → returned path", () => {
    const issued = Either.getOrThrow(markTokenRecordIssued(record(), T1));
    expect(issued.state).toBe("issued");

    const pending = Either.getOrThrow(markTokenRecordInFlight(issued, T1 + 1));
    expect(pending.state).toBe("pending");

    const returned = Either.getOrThrow(returnTokenRecordToWallet(pending, T1 + 2));
    expect(returned.state).toBe("accepted");

    const reserved = Either.getOrThrow(reserveTokenRecord(returned, T1 + 3));
    expect(reserved.state).toBe("reserved");

    const back = Either.getOrThrow(returnTokenRecordToWallet(reserved, T1 + 4));
    expect(back.state).toBe("accepted");
  });

  it("externalizes for NFC/share and returns to the wallet", () => {
    const externalized = Either.getOrThrow(externalizeTokenRecord(record(), T1));
    expect(externalized.state).toBe("externalized");
    const back = Either.getOrThrow(returnTokenRecordToWallet(externalized, T1 + 1));
    expect(back.state).toBe("accepted");
    expect(back.error).toBeNull();
  });

  it("marks errors with a message and clears it on recovery", () => {
    const failed = Either.getOrThrow(markTokenRecordError(record(), "Token invalid", T1));
    expect(failed.state).toBe("error");
    expect(failed.error).toBe("Token invalid");

    const recovered = Either.getOrThrow(
      recoverTokenRecord(
        failed,
        {
          mintUrl: `${MINT}/`,
          unit: "",
          amount: 19,
          proofs: [proof(19, "s-new")],
          token: "cashuBreaccepted",
        },
        T1 + 1,
      ),
    );
    expect(recovered.state).toBe("accepted");
    expect(recovered.error).toBeNull();
    // The recovery re-accept replaced the stored token/value.
    expect(recovered.token).toBe("cashuBreaccepted");
    expect(recovered.amount).toBe(19);
    expect(recovered.mintUrl).toBe(MINT);
    expect(recovered.unit).toBe("sat");
  });

  it("rejects recovery of a non-error record", () => {
    const result = recoverTokenRecord(
      record(),
      { mintUrl: MINT, unit: "sat", amount: 1, proofs: [], token: "cashuBx" },
      T1,
    );
    expect(Either.isLeft(result)).toBe(true);
  });

  it("marks spent and allows nothing but deletion afterwards", () => {
    const spent = Either.getOrThrow(markTokenRecordSpent(record(), T1));
    expect(spent.state).toBe("spent");
    expect(Either.isLeft(returnTokenRecordToWallet(spent, T1 + 1))).toBe(true);
    expect(Either.isLeft(markTokenRecordError(spent, "x", T1 + 1))).toBe(true);
    const deleted = Either.getOrThrow(deleteTokenRecord(spent, T1 + 2));
    expect(deleted.state).toBe("deleted");
  });

  it("treats deleted as terminal", () => {
    const deleted = Either.getOrThrow(deleteTokenRecord(record(), T1));
    for (const tag of ALL_TAGS) {
      expect(Either.isLeft(transitionTokenRecord(deleted, TRANSITION_VALUES[tag], T1 + 1))).toBe(
        true,
      );
    }
  });
});

describe("constructors from #32 engine results", () => {
  it("receiveToken → accepted record", () => {
    const created = tokenRecordFromReceive(
      {
        mintUrl: `${MINT}///`,
        unit: "sat",
        amount: 42,
        proofs: [proof(32, "a"), proof(8, "b"), proof(2, "c")],
        token: "cashuBreceived",
      },
      { id: "row-1", atMillis: T0 },
    );
    expect(created).toEqual(
      record({ id: "row-1", amount: 42, token: "cashuBreceived", state: "accepted" }),
    );
  });

  it("createSendToken → issued record + accepted change record", () => {
    const { issued, keep } = tokenRecordsFromSend(
      {
        mintUrl: MINT,
        unit: "sat",
        sendAmount: 30,
        sendToken: "cashuBsend",
        sendProofs: [proof(30, "s")],
        keepAmount: 12,
        keepToken: Option.some("cashuBkeep"),
        keepProofs: [proof(8, "k1"), proof(4, "k2")],
      },
      { issuedId: "row-issued", keepId: "row-keep", atMillis: T0 },
    );

    expect(issued.state).toBe("issued");
    expect(issued.id).toBe("row-issued");
    expect(issued.amount).toBe(30);
    expect(issued.token).toBe("cashuBsend");

    expect(Option.isSome(keep)).toBe(true);
    if (Option.isSome(keep)) {
      expect(keep.value.state).toBe("accepted");
      expect(keep.value.id).toBe("row-keep");
      expect(keep.value.amount).toBe(12);
      expect(keep.value.token).toBe("cashuBkeep");
    }
  });

  it("createSendToken with exact inputs → no change record", () => {
    const { keep } = tokenRecordsFromSend(
      {
        mintUrl: MINT,
        unit: "sat",
        sendAmount: 30,
        sendToken: "cashuBsend",
        sendProofs: [proof(30, "s")],
        keepAmount: 0,
        keepToken: Option.none(),
        keepProofs: [],
      },
      { issuedId: "row-issued", keepId: "row-keep", atMillis: T0 },
    );
    expect(Option.isNone(keep)).toBe(true);
  });

  it("claimTopup → accepted record", () => {
    const created = tokenRecordFromTopup(
      {
        mintUrl: MINT,
        unit: "sat",
        amount: 100,
        proofs: [proof(64, "t1"), proof(32, "t2"), proof(4, "t3")],
        token: "cashuBtopup",
        recovered: false,
      },
      { id: "row-topup", atMillis: T0 },
    );
    expect(created.state).toBe("accepted");
    expect(created.amount).toBe(100);
  });

  it("payInvoice change → accepted record when present, none otherwise", () => {
    const base = {
      mintUrl: MINT,
      unit: "sat",
      quoteId: "q1",
      paidAmount: 90,
      feeReserve: 2,
      feePaid: 1,
      paymentPreimage: Option.none<string>(),
      changeProofs: [proof(9, "c1")],
    };
    const some = tokenRecordFromMeltChange(
      { ...base, changeAmount: 9, changeToken: Option.some("cashuBchange") },
      { id: "row-change", atMillis: T0 },
    );
    expect(Option.isSome(some)).toBe(true);
    if (Option.isSome(some)) {
      expect(some.value.state).toBe("accepted");
      expect(some.value.amount).toBe(9);
      expect(some.value.token).toBe("cashuBchange");
    }

    const none = tokenRecordFromMeltChange(
      { ...base, changeProofs: [], changeAmount: 0, changeToken: Option.none() },
      { id: "row-change", atMillis: T0 },
    );
    expect(Option.isNone(none)).toBe(true);
  });

  it("restoreFromMint → one accepted record per restored token", () => {
    const created = tokenRecordsFromRestore(
      {
        mintUrl: MINT,
        unit: "sat",
        scans: [],
        restoredTokens: [
          {
            mintUrl: MINT,
            unit: "sat",
            keysetId: "k1",
            amount: 10,
            proofCount: 2,
            token: "cashuBr1",
          },
          {
            mintUrl: MINT,
            unit: "sat",
            keysetId: "k2",
            amount: 5,
            proofCount: 1,
            token: "cashuBr2",
          },
        ],
        totalRestoredAmount: 15,
        totalRestoredProofs: 3,
      },
      { idFor: (index) => `restored-${index}`, atMillis: T0 },
    );
    expect(created.map((r) => [r.id, r.state, r.amount, r.token])).toEqual([
      ["restored-0", "accepted", 10, "cashuBr1"],
      ["restored-1", "accepted", 5, "cashuBr2"],
    ]);
  });
});

describe("reconciliation with checkProofStates outcomes", () => {
  const spendOutcomes: ReadonlyArray<[TokenState, TokenState]> = [
    ["accepted", "spent"],
    ["issued", "spent"],
    ["pending", "spent"],
    ["reserved", "spent"],
    ["externalized", "spent"],
    ["error", "spent"],
    ["spent", "spent"], // already spent — unchanged, not an error
    ["deleted", "deleted"], // tombstones never resurrect or change
  ];

  it.each(spendOutcomes)("spent outcome: %s → %s", (from, to) => {
    const result = reconcileTokenRecord(record({ state: from }), "spent", T1);
    expect(result.state).toBe(to);
  });

  it.each(TOKEN_STATES)("live outcome only moves pending → accepted (from %s)", (from) => {
    const result = reconcileTokenRecord(record({ state: from }), "live", T1);
    expect(result.state).toBe(from === "pending" ? "accepted" : from);
  });

  it.each(TOKEN_STATES)("unknown outcome never changes %s", (from) => {
    const start = record({ state: from });
    expect(reconcileTokenRecord(start, "unknown", T1)).toEqual(start);
  });

  it("applies a real partitionProofGroupsByState result by record id", () => {
    const claimed = record({ id: "claimed", state: "pending" });
    const undelivered = record({ id: "undelivered", state: "pending" });
    const waiting = record({ id: "waiting", state: "issued" });
    const limbo = record({ id: "limbo", state: "accepted" });
    const untouched = record({ id: "untouched", state: "accepted" });

    const groups = [
      { id: "claimed", proofs: [proof(4, "c1"), proof(2, "c2")] },
      { id: "undelivered", proofs: [proof(8, "u1")] },
      { id: "waiting", proofs: [proof(16, "w1"), proof(16, "w2")] },
      { id: "limbo", proofs: [proof(1, "l1")] },
    ];
    const states = [
      proofState("SPENT"), // claimed #1
      proofState("SPENT"), // claimed #2
      proofState("UNSPENT"), // undelivered
      proofState("UNSPENT"), // waiting #1 (partially spent group stays live)
      proofState("SPENT"), // waiting #2
      proofState("PENDING"), // limbo — proves nothing
    ];

    const partition = partitionProofGroupsByState(groups, states);
    const reconciled = reconcileTokenRecords(
      [claimed, undelivered, waiting, limbo, untouched],
      partition,
      T1,
    );

    expect(reconciled.map((r) => [r.id, r.state])).toEqual([
      ["claimed", "spent"], // all proofs SPENT → recipient claimed
      ["undelivered", "accepted"], // provably still ours → back to the wallet
      ["waiting", "issued"], // still live → keeps waiting to be claimed
      ["limbo", "accepted"], // unknown → untouched
      ["untouched", "accepted"], // not in the partition → untouched
    ]);
  });
});

describe("error recovery classification", () => {
  it.each([
    "Token already spent",
    "PROOFS ALREADY SPENT",
    "mint said: invalid proof",
    "invalid proofs supplied",
    "Token proofs missing",
    "invalid token",
  ])("classifies %j as definitively spent", (message) => {
    expect(isDefinitivelySpentErrorMessage(message)).toBe(true);
    expect(tokenRecordErrorRecovery(record({ state: "error", error: message }))).toEqual(
      Option.some("mark-spent"),
    );
  });

  it.each(["", "  ", "network timeout", "outputs have already been signed", "mint offline"])(
    "classifies %j as retryable",
    (message) => {
      expect(isDefinitivelySpentErrorMessage(message)).toBe(false);
    },
  );

  it("suggests re-accept for transient error records", () => {
    expect(tokenRecordErrorRecovery(record({ state: "error", error: "fetch failed" }))).toEqual(
      Option.some("reaccept"),
    );
    expect(tokenRecordErrorRecovery(record({ state: "error", error: null }))).toEqual(
      Option.some("reaccept"),
    );
  });

  it.each(TOKEN_STATES.filter((state) => state !== "error"))(
    "has no recovery action for %s records",
    (state) => {
      expect(Option.isNone(tokenRecordErrorRecovery(record({ state })))).toBe(true);
    },
  );
});

describe("cleanup policy", () => {
  it.each(TOKEN_STATES)("purgeability of %s matches the state policy", (state) => {
    expect(isPurgeableTokenRecord(record({ state }), T1)).toBe(
      state === "spent" || state === "deleted",
    );
  });

  it("honors the optional retention window", () => {
    const spent = record({ state: "spent", updatedAtMillis: T0 });
    expect(isPurgeableTokenRecord(spent, T0, { minAgeMillis: 1000 })).toBe(false);
    expect(isPurgeableTokenRecord(spent, T0 + 999, { minAgeMillis: 1000 })).toBe(false);
    expect(isPurgeableTokenRecord(spent, T0 + 1000, { minAgeMillis: 1000 })).toBe(true);
  });

  it("selects exactly the purgeable rows, order preserved", () => {
    const rows = [
      record({ id: "a", state: "spent" }),
      record({ id: "b", state: "accepted" }),
      record({ id: "c", state: "deleted" }),
      record({ id: "d", state: "issued" }),
      record({ id: "e", state: "error" }),
    ];
    expect(selectPurgeableTokenRecords(rows, T1).map((r) => r.id)).toEqual(["a", "c"]);
  });
});
