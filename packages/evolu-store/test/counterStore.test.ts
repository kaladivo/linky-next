/**
 * Evolu-backed CounterStore (issue #35) — the production Layer for core's
 * #32 port over the local-only `_cashuCounter` table. Real Evolu on local
 * SQLite, `transports: []`.
 *
 * Covered, mirroring the #32 port contract tests (`counterStore.test.ts`
 * in core): zero defaults, bump round-trips, the monotonic ratchet,
 * counter/cursor separation, mint-URL normalization sharing one counter
 * lane, and per-keyset lock serialization. Plus the storage-specific
 * pieces: persistence in `_cashuCounter` rows, locality (counters never
 * appear in `evolu_history` — they must not sync; see the regression-hazard
 * note in `counterStore.ts`), and restore-reconnect (a re-derived owner
 * instance over the same database file reads the counters AND the wallet
 * tokens back).
 */
import BetterSqlite from "better-sqlite3";
import { Effect } from "effect";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CounterStore, deriveOwnerLane, MasterSecret } from "@linky/core";
import type { KeysetRef } from "@linky/core";

import {
  createCashuCounterStoreLayer,
  createLinkyStore,
  createTokensRepository,
  SYNC_DOMAINS,
} from "../src/index";
import type { LaneMnemonics, LinkyStore } from "../src/index";
import { createNodeEvoluDeps } from "./nodeEvoluDeps";

/** Fixed test master secret (16 bytes), unique per test file. Dev/test only. */
const MASTER_SECRET_HEX = "c0ffee00c0ffee00c0ffee00c0ffee00";

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));

const DB_NAME = "linky-counter-store-test";
const DB_NAME_RESTORED = "linky-counter-store-restored";

const ref: KeysetRef = {
  mintUrl: "https://testnut.cashu.space",
  unit: "sat",
  keysetId: "009a1f293253e41e",
};

const otherRef: KeysetRef = { ...ref, keysetId: "00ffffffffffffff" };

const originalCwd = process.cwd();
let tempDir: string;
let laneMnemonics: LaneMnemonics;
let store: LinkyStore;

const deriveLaneMnemonics = async (): Promise<LaneMnemonics> => {
  const masterSecret = MasterSecret.make(fromHex(MASTER_SECRET_HEX));
  const entries = await Promise.all(
    SYNC_DOMAINS.map(async (domain) => {
      const lane = await Effect.runPromise(deriveOwnerLane(masterSecret, domain));
      return [domain, lane.mnemonic] as const;
    }),
  );
  return Object.fromEntries(entries) as unknown as LaneMnemonics;
};

const runWith = <A, E>(
  target: LinkyStore,
  program: Effect.Effect<A, E, CounterStore>,
): Promise<A> => Effect.runPromise(program.pipe(Effect.provide(createCashuCounterStoreLayer(target))));

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "linky-counter-store-test-"));
  process.chdir(tempDir);

  laneMnemonics = await deriveLaneMnemonics();
  const result = createLinkyStore(createNodeEvoluDeps(), {
    name: DB_NAME,
    laneMnemonics,
    transports: [],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("createLinkyStore failed");
  store = result.value;
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("port contract over Evolu persistence", () => {
  it("starts at 0, bumps by used slots, and round-trips", async () => {
    const result = await runWith(
      store,
      Effect.gen(function* () {
        const counters = yield* CounterStore;
        const initial = yield* counters.getCounter(ref);
        yield* counters.bumpCounter(ref, 3);
        yield* counters.bumpCounter(ref, 2);
        const after = yield* counters.getCounter(ref);
        return { initial, after };
      }),
    );
    expect(result).toEqual({ initial: 0, after: 5 });
  });

  it("ensureCounterAtLeast never lowers the counter (monotonic ratchet)", async () => {
    const result = await runWith(
      store,
      Effect.gen(function* () {
        const counters = yield* CounterStore;
        yield* counters.ensureCounterAtLeast(otherRef, 10);
        const raised = yield* counters.getCounter(otherRef);
        yield* counters.ensureCounterAtLeast(otherRef, 4);
        const stillRaised = yield* counters.getCounter(otherRef);
        return { raised, stillRaised };
      }),
    );
    expect(result).toEqual({ raised: 10, stillRaised: 10 });
  });

  it("keeps restore cursors separate from counters", async () => {
    const result = await runWith(
      store,
      Effect.gen(function* () {
        const counters = yield* CounterStore;
        yield* counters.setRestoreCursor(ref, 42);
        const cursor = yield* counters.getRestoreCursor(ref);
        const counter = yield* counters.getCounter(ref);
        return { cursor, counter };
      }),
    );
    expect(result).toEqual({ cursor: 42, counter: 5 });
  });

  it("treats trailing-slash mint URLs as the same counter lane (PoC key contract)", async () => {
    const counter = await runWith(
      store,
      Effect.gen(function* () {
        const counters = yield* CounterStore;
        return yield* counters.getCounter({ ...ref, mintUrl: `${ref.mintUrl}/` });
      }),
    );
    expect(counter).toBe(5);
  });

  it("serializes counter-consuming sections per keyset (lock contract)", async () => {
    const lockRef: KeysetRef = { ...ref, keysetId: "00aaaaaaaaaaaaaa" };
    const observed = await runWith(
      store,
      Effect.gen(function* () {
        const counters = yield* CounterStore;
        const criticalSection = Effect.gen(function* () {
          const before = yield* counters.getCounter(lockRef);
          // Yield so unlocked fibers would interleave and read stale values.
          yield* Effect.yieldNow();
          yield* Effect.yieldNow();
          yield* counters.bumpCounter(lockRef, 1);
          return before;
        });
        return yield* Effect.all(
          [
            counters.withCounterLock(lockRef, criticalSection),
            counters.withCounterLock(lockRef, criticalSection),
          ],
          { concurrency: 2 },
        );
      }),
    );
    expect([...observed].sort()).toEqual([0, 1]);
  });
});

describe("locality (decision: counters do NOT sync, matching the PoC)", () => {
  it("persists counters as _cashuCounter rows that never reach evolu_history", async () => {
    // Dedicated store: ONLY counter writes happen here, so any
    // evolu_history entry would have to come from them.
    const isolated = createLinkyStore(createNodeEvoluDeps(), {
      name: "linky-counter-locality-test",
      laneMnemonics,
      transports: [],
    });
    expect(isolated.ok).toBe(true);
    if (!isolated.ok) return;

    await runWith(
      isolated.value,
      Effect.gen(function* () {
        const counters = yield* CounterStore;
        yield* counters.bumpCounter(ref, 7);
        yield* counters.setRestoreCursor(ref, 3);
        return yield* counters.getCounter(ref);
      }),
    );

    const db = new BetterSqlite(join(tempDir, "linky-counter-locality-test.db"), {
      readonly: true,
    });
    try {
      const rows = db.prepare(`select key, value from _cashuCounter`).all() as Array<{
        key: string;
        value: string;
      }>;
      // PoC-identical canonical keys and plain integer values (funds contract).
      expect(rows).toContainEqual({
        key: "linky.cashu.detCounter.v1:https%3A%2F%2Ftestnut.cashu.space:sat:009a1f293253e41e",
        value: "7",
      });
      expect(rows).toContainEqual({
        key: "linky.cashu.restoreCursor.v1:https%3A%2F%2Ftestnut.cashu.space:sat:009a1f293253e41e",
        value: "3",
      });

      // The whole point of the local-only table: counter mutations bypass
      // the sync pipeline entirely (never reach evolu_history), so a lower
      // remote counter can never overwrite a higher local one — see the
      // fund-safety note in counterStore.ts.
      const historyCount = (
        db.prepare(`select count(*) as count from evolu_history`).get() as { count: number }
      ).count;
      expect(historyCount).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("restore-reconnect", () => {
  it("re-derived owner instance over the same database reads counters and tokens back", async () => {
    // Write one wallet token next to the counters, then "restore": copy the
    // SQLite file and boot a fresh instance from a fresh derivation of the
    // same master secret (byte-identical owners, issue #13).
    const tokens = createTokensRepository(store);
    const inserted = tokens.insert({
      mintUrl: ref.mintUrl,
      amount: 21,
      state: "accepted",
      token: "cashuArestore-fixture",
    });
    expect(inserted.ok).toBe(true);

    // Ensure writes are flushed through the worker before copying.
    await runWith(
      store,
      Effect.gen(function* () {
        const counters = yield* CounterStore;
        return yield* counters.getCounter(ref);
      }),
    );

    for (const suffix of [".db", ".db-wal", ".db-shm"]) {
      const source = join(tempDir, `${DB_NAME}${suffix}`);
      if (existsSync(source)) {
        copyFileSync(source, join(tempDir, `${DB_NAME_RESTORED}${suffix}`));
      }
    }

    const restored = createLinkyStore(createNodeEvoluDeps(), {
      name: DB_NAME_RESTORED,
      laneMnemonics: await deriveLaneMnemonics(),
      transports: [],
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    // Counters survive: same values through the port on the new instance.
    const counters = await runWith(
      restored.value,
      Effect.gen(function* () {
        const counterStore = yield* CounterStore;
        const counter = yield* counterStore.getCounter(ref);
        const cursor = yield* counterStore.getRestoreCursor(ref);
        const ratcheted = yield* counterStore.getCounter(otherRef);
        return { counter, cursor, ratcheted };
      }),
    );
    expect(counters).toEqual({ counter: 5, cursor: 42, ratcheted: 10 });

    // Tokens survive too, scoped to the re-derived wallet owner.
    const restoredTokens = await createTokensRepository(restored.value).list();
    expect(restoredTokens).toHaveLength(1);
    expect(restoredTokens[0]!.token).toBe("cashuArestore-fixture");
    expect(restored.value.owners.wallet.id).toBe(store.owners.wallet.id);
  });
});
