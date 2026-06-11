/**
 * CounterStore port — persistence for the Cashu deterministic counters and
 * restore cursors (`cashu.restore-tokens` in the feature map).
 *
 * FUND-SAFETY CONTRACT: NUT-13 deterministic secrets are derived from
 * `(seed, keysetId, counter)`. Losing a counter forwards is recoverable
 * (restore scans), but reusing a counter produces colliding blinded
 * messages, and silently *changing key semantics* (how a `(mint, unit,
 * keyset)` triple maps to a stored counter) would strand counters and with
 * them the fast path to users' funds. The key derivation below mirrors the
 * PoC (`linky-poc/apps/web-app/src/utils/cashuDeterministic.ts`):
 * normalized mint URL (trimmed, trailing `/` stripped), unit defaulting to
 * `"sat"`, raw keyset id — all `encodeURIComponent`-escaped and joined with
 * `:`. Every Layer MUST use {@link counterStoreKey} so keys stay identical
 * across backends.
 *
 * Counters are NOT secrets (they are just integers), so a plain
 * `KeyValueStore` backend is acceptable. The production Layer comes from
 * `packages/evolu-store` (issue #35); until then the app may use
 * {@link CounterStoreKeyValue} over a persistent KeyValueStore, and tests
 * use {@link CounterStoreMemory}.
 *
 * `withCounterLock` serializes counter-consuming mint operations per keyset
 * (single-process FIFO, like the PoC's in-memory queue): get-counter →
 * network call → bump-counter must be atomic with respect to other wallet
 * operations on the same keyset or two operations would derive the same
 * secrets.
 */
import { Context, Data, Effect, Layer, Option } from "effect";

import { KeyValueStorage } from "./KeyValueStorage.js";

/** Identifies one deterministic counter lane: a keyset at a mint. */
export interface KeysetRef {
  readonly mintUrl: string;
  readonly unit: string;
  readonly keysetId: string;
}

export class CounterStoreError extends Data.TaggedError("CounterStoreError")<{
  readonly operation: "get" | "set";
  readonly key: string;
  readonly cause?: unknown;
}> {}

/** PoC-compatible mint URL normalization (trim + strip trailing slashes). */
export const normalizeMintUrl = (mintUrl: string): string =>
  String(mintUrl ?? "")
    .trim()
    .replace(/\/+$/, "");

/**
 * Canonical storage key for a keyset ref. All Layers must use this — the
 * `(mint, unit, keyset) -> counter` mapping is part of the funds contract.
 */
export const counterStoreKey = (prefix: string, ref: KeysetRef): string => {
  const mint = normalizeMintUrl(ref.mintUrl);
  const unit = String(ref.unit ?? "").trim() || "sat";
  const keysetId = String(ref.keysetId ?? "").trim();
  return `${prefix}:${encodeURIComponent(mint)}:${encodeURIComponent(unit)}:${encodeURIComponent(
    keysetId,
  )}`;
};

/** Key prefixes, matching the PoC's localStorage names (sans storage tech). */
export const COUNTER_KEY_PREFIX = "linky.cashu.detCounter.v1";
export const RESTORE_CURSOR_KEY_PREFIX = "linky.cashu.restoreCursor.v1";

export interface CounterStoreService {
  /** Current counter for the keyset; a never-seen keyset starts at 0. */
  readonly getCounter: (ref: KeysetRef) => Effect.Effect<number, CounterStoreError>;
  /** Advances the counter by `used` slots (floored at 0); returns the new value. */
  readonly bumpCounter: (ref: KeysetRef, used: number) => Effect.Effect<number, CounterStoreError>;
  /** Raises the counter to at least `atLeast`; never lowers it. Returns the new value. */
  readonly ensureCounterAtLeast: (
    ref: KeysetRef,
    atLeast: number,
  ) => Effect.Effect<number, CounterStoreError>;
  /** Restore scan cursor (next counter to scan from); defaults to 0. */
  readonly getRestoreCursor: (ref: KeysetRef) => Effect.Effect<number, CounterStoreError>;
  readonly setRestoreCursor: (
    ref: KeysetRef,
    cursor: number,
  ) => Effect.Effect<number, CounterStoreError>;
  /**
   * Runs `effect` while holding the per-keyset lock. Counter-consuming mint
   * operations (mint/swap/melt/receive with deterministic outputs) MUST run
   * inside this so the read-derive-bump sequence is not interleaved.
   */
  readonly withCounterLock: <A, E, R>(
    ref: KeysetRef,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class CounterStore extends Context.Tag("@linky/core/CounterStore")<
  CounterStore,
  CounterStoreService
>() {}

// ---------------------------------------------------------------------------
// Shared implementation over a tiny string-keyed backend
// ---------------------------------------------------------------------------

interface CounterBackend {
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, CounterStoreError>;
  readonly set: (key: string, value: string) => Effect.Effect<void, CounterStoreError>;
}

const clampNonNegativeInt = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const makeCounterStore = (backend: CounterBackend): CounterStoreService => {
  // Per-keyset FIFO semaphores; single-process, like the PoC's queue.
  const locks = new Map<string, Effect.Semaphore>();
  const lockFor = (key: string): Effect.Semaphore => {
    let semaphore = locks.get(key);
    if (semaphore === undefined) {
      semaphore = Effect.unsafeMakeSemaphore(1);
      locks.set(key, semaphore);
    }
    return semaphore;
  };

  const readNumber = (key: string): Effect.Effect<number, CounterStoreError> =>
    backend.get(key).pipe(
      Effect.map(
        Option.match({
          onNone: () => 0,
          onSome: (raw) => clampNonNegativeInt(Number(raw)),
        }),
      ),
    );

  const writeNumber = (key: string, value: number): Effect.Effect<number, CounterStoreError> =>
    backend.set(key, String(value)).pipe(Effect.as(value));

  return {
    getCounter: (ref) => readNumber(counterStoreKey(COUNTER_KEY_PREFIX, ref)),
    bumpCounter: (ref, used) => {
      const key = counterStoreKey(COUNTER_KEY_PREFIX, ref);
      return readNumber(key).pipe(
        Effect.flatMap((current) => writeNumber(key, current + clampNonNegativeInt(used))),
      );
    },
    ensureCounterAtLeast: (ref, atLeast) => {
      const key = counterStoreKey(COUNTER_KEY_PREFIX, ref);
      return readNumber(key).pipe(
        Effect.flatMap((current) =>
          writeNumber(key, Math.max(current, clampNonNegativeInt(atLeast))),
        ),
      );
    },
    getRestoreCursor: (ref) => readNumber(counterStoreKey(RESTORE_CURSOR_KEY_PREFIX, ref)),
    setRestoreCursor: (ref, cursor) =>
      writeNumber(counterStoreKey(RESTORE_CURSOR_KEY_PREFIX, ref), clampNonNegativeInt(cursor)),
    withCounterLock: (ref, effect) =>
      Effect.suspend(() =>
        lockFor(counterStoreKey(COUNTER_KEY_PREFIX, ref)).withPermits(1)(effect),
      ),
  };
};

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** In-memory CounterStore — tests and ephemeral runtimes. Fresh per build. */
export const CounterStoreMemory: Layer.Layer<CounterStore> = Layer.sync(CounterStore, () => {
  const store = new Map<string, string>();
  return makeCounterStore({
    get: (key) => Effect.sync(() => Option.fromNullable(store.get(key))),
    set: (key, value) => Effect.sync(() => void store.set(key, value)),
  });
});

/**
 * CounterStore backed by the KeyValueStorage port. Interim persistence until
 * the evolu-store Layer (#35) lands; also used by tests that need to assert
 * persistence across store rebuilds.
 */
export const CounterStoreKeyValue: Layer.Layer<
  CounterStore,
  never,
  KeyValueStorage.KeyValueStore
> = Layer.effect(
  CounterStore,
  Effect.map(KeyValueStorage.KeyValueStore, (kv) =>
      makeCounterStore({
        get: (key) =>
          kv
            .get(key)
            .pipe(
              Effect.mapError(
                (cause) => new CounterStoreError({ operation: "get", key, cause }),
              ),
            ),
        set: (key, value) =>
          kv
            .set(key, value)
            .pipe(
              Effect.mapError(
                (cause) => new CounterStoreError({ operation: "set", key, cause }),
              ),
            ),
      }),
  ),
);
