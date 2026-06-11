/**
 * Deterministic restore behavior: counter-range scanning with gap
 * detection, cursor/counter ratchet, knownSecrets filtering, spent
 * filtering, and the deep-scan fallback — the fund-recovery path.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { CounterStore, CounterStoreMemory } from "../../ports/CounterStore.js";
import {
  ALICE_SEED,
  aliceSecretAt,
  engineLayers,
  fakeKeysetRef,
  makeFundingToken,
  readCounter,
} from "./__tests__/helpers.js";
import { FAKE_MINT_URL, FakeMint, fakeMintHttpLayer } from "./__tests__/fakeMint.js";
import { receiveToken } from "./receiveToken.js";
import { restoreFromMint } from "./restore.js";
import { parseCashuToken } from "./tokenCodec.js";

/** Receives 7 sat with alice's seed so the mint holds signatures at 1..3. */
const seedWalletValue = (mint: FakeMint): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { token } = yield* makeFundingToken(mint, [1, 2, 4], "restore-seed");
      const received = yield* receiveToken({ seed: ALICE_SEED, token });
      return received.proofs.map((proof) => proof.secret);
    }).pipe(Effect.provide(engineLayers(mint))),
  );

describe("restoreFromMint", () => {
  it("recovers all unspent deterministic value after total counter loss", async () => {
    const mint = new FakeMint();
    const secrets = await seedWalletValue(mint);

    // New device: counters and cursors start at zero.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const restored = yield* restoreFromMint({ seed: ALICE_SEED, mintUrl: FAKE_MINT_URL });
        const counter = yield* readCounter(fakeKeysetRef(mint));
        const store = yield* CounterStore;
        const cursor = yield* store.getRestoreCursor(fakeKeysetRef(mint));
        return { restored, counter, cursor };
      }).pipe(Effect.provide(engineLayers(mint))),
    );

    expect(result.restored.totalRestoredAmount).toBe(7);
    expect(result.restored.totalRestoredProofs).toBe(3);
    expect(result.restored.restoredTokens).toHaveLength(1);
    const token = result.restored.restoredTokens[0]!;
    expect(token.amount).toBe(7);
    expect(token.keysetId).toBe(mint.keysetId);

    const parsed = await Effect.runPromise(parseCashuToken(token.token));
    expect(parsed.proofs.map((proof) => proof.secret).sort()).toEqual([...secrets].sort());

    // Counter and cursor ratcheted past the last signature (slot 3 → 4):
    // future operations cannot reuse the recovered range.
    expect(result.counter).toBe(4);
    expect(result.cursor).toBe(4);
  });

  it("does not re-report value the caller already has (knownSecrets)", async () => {
    const mint = new FakeMint();
    const secrets = await seedWalletValue(mint);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const restored = yield* restoreFromMint({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          knownSecrets: secrets,
        });
        const counter = yield* readCounter(fakeKeysetRef(mint));
        return { restored, counter };
      }).pipe(Effect.provide(engineLayers(mint))),
    );

    expect(result.restored.totalRestoredProofs).toBe(0);
    expect(result.restored.restoredTokens).toHaveLength(0);
    // The ratchet still advances — signatures exist in the scanned range.
    expect(result.counter).toBe(4);
  });

  it("skips spent proofs (only UNSPENT value is recovered)", async () => {
    const mint = new FakeMint();
    const secrets = await seedWalletValue(mint);
    for (const secret of secrets) mint.markSpent(secret);

    const result = await Effect.runPromise(
      restoreFromMint({ seed: ALICE_SEED, mintUrl: FAKE_MINT_URL }).pipe(
        Effect.provide(engineLayers(mint)),
      ),
    );

    expect(result.totalRestoredProofs).toBe(0);
    expect(result.restoredTokens).toHaveLength(0);
    expect(result.scans[0]?.scanned).toBe(true);
  });

  it("falls back to a deep scan from 0 when the window misses old value", async () => {
    const mint = new FakeMint();
    const secrets = await seedWalletValue(mint); // signatures at 1..3

    const httpLayer = fakeMintHttpLayer([[FAKE_MINT_URL, mint]]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // Simulate a wallet whose counter ran far ahead: the windowed scan
        // (highWater 5000, window 400 → start 4600) sees nothing.
        const store = yield* CounterStore;
        yield* store.ensureCounterAtLeast(fakeKeysetRef(mint), 5000);
        const restored = yield* restoreFromMint({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          rescanWindow: 400,
        });
        const counter = yield* readCounter(fakeKeysetRef(mint));
        const cursor = yield* store.getRestoreCursor(fakeKeysetRef(mint));
        return { restored, counter, cursor };
      }).pipe(Effect.provide(httpLayer), Effect.provide(CounterStoreMemory)),
    );

    expect(result.restored.totalRestoredAmount).toBe(7);
    const parsed = await Effect.runPromise(
      parseCashuToken(result.restored.restoredTokens[0]!.token),
    );
    expect(parsed.proofs.map((proof) => proof.secret).sort()).toEqual([...secrets].sort());
    // The counter never moves backwards.
    expect(result.counter).toBe(5000);
    expect(result.cursor).toBe(4);
  });

  it("restores across signature gaps within the gap limit", async () => {
    const mint = new FakeMint();
    await seedWalletValue(mint); // 1..3

    // More value at counters 120..121 (within the 300 gap budget), e.g. from
    // a session whose local state was lost after a collision bump.
    const { OutputData } = await import("@cashu/cashu-ts");
    for (const [counter, amount] of [
      [120, 2],
      [121, 8],
    ] as const) {
      mint.signOutput(
        OutputData.createSingleDeterministicData(amount, ALICE_SEED, counter, mint.keysetId)
          .blindedMessage,
      );
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const restored = yield* restoreFromMint({ seed: ALICE_SEED, mintUrl: FAKE_MINT_URL });
        const counter = yield* readCounter(fakeKeysetRef(mint));
        return { restored, counter };
      }).pipe(Effect.provide(engineLayers(mint))),
    );

    expect(result.restored.totalRestoredAmount).toBe(7 + 10);
    expect(result.restored.totalRestoredProofs).toBe(5);
    expect(result.counter).toBe(122);
    const parsed = await Effect.runPromise(
      parseCashuToken(result.restored.restoredTokens[0]!.token),
    );
    expect(parsed.proofs.map((proof) => proof.secret)).toContain(
      aliceSecretAt(mint.keysetId, 121),
    );
  });

  it("restore is deterministic: secrets equal the original proofs byte-for-byte", async () => {
    const mint = new FakeMint();
    const original = await seedWalletValue(mint);
    const onceMore = await Effect.runPromise(
      restoreFromMint({ seed: ALICE_SEED, mintUrl: FAKE_MINT_URL }).pipe(
        Effect.provide(engineLayers(mint)),
      ),
    );
    const parsed = await Effect.runPromise(
      parseCashuToken(onceMore.restoredTokens[0]!.token),
    );
    expect(parsed.proofs.map((proof) => proof.secret).sort()).toEqual([...original].sort());
    expect(parsed.memo._tag).toBe("Some"); // memo "restored"
  });
});
