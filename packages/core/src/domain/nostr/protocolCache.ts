/**
 * protocolCache — a small TTL cache over the `KeyValueStorage` port for
 * protocol-level fetch results (kind-0 profile metadata, NIP-38 status).
 *
 * This is the protocol layer's cache only: it makes repeated relay queries
 * cheap and gives offline reads a recent answer. Contact-level persistence
 * (what the user actually saved about a contact) is #25/#27's Evolu data —
 * never this cache.
 *
 * Semantics (PoC parity, `nostrProfile.ts` / `nostrStatus.ts`):
 *
 * - A stored entry is `{ fetchedAt, value | null }` — `null` is a cached
 *   NEGATIVE result ("looked, found nothing"), kept on a short TTL so a
 *   slow/unreliable relay round doesn't pin "no profile" for hours.
 * - Positive entries live on a long TTL (refresh cadence, PoC's 12 h
 *   picture-refresh window).
 * - The cache is best-effort by design: storage read failures and
 *   undecodable entries behave as a miss, write failures are ignored. A
 *   broken key-value store degrades to a network fetch, it never breaks the
 *   workflow — so cache users keep an empty error channel.
 *
 * Internal support module (not part of the package API); time comes from
 * Effect's `Clock`.
 */
import { Clock, Duration, Effect, Option, Schema } from "effect";

import { KeyValueStorage } from "../../ports/KeyValueStorage.js";

export interface ProtocolCache<A> {
  /**
   * `Option.none()` — miss (absent, undecodable, expired, or storage read
   * failed). `Option.some(value | null)` — hit; `null` is a cached negative.
   */
  readonly read: (
    key: string,
  ) => Effect.Effect<Option.Option<A | null>, never, KeyValueStorage.KeyValueStore>;
  /** Stores a positive (`value`) or negative (`null`) result. Best-effort. */
  readonly write: (
    key: string,
    value: A | null,
  ) => Effect.Effect<void, never, KeyValueStorage.KeyValueStore>;
}

export const makeProtocolCache = <A, I>(options: {
  readonly keyPrefix: string;
  readonly valueSchema: Schema.Schema<A, I>;
  readonly positiveTtl: Duration.DurationInput;
  readonly negativeTtl: Duration.DurationInput;
}): ProtocolCache<A> => {
  const EntrySchema = Schema.parseJson(
    Schema.Struct({
      fetchedAt: Schema.Number,
      value: Schema.NullOr(options.valueSchema),
    }),
  );
  const decodeEntry = Schema.decodeUnknownEither(EntrySchema);
  const encodeEntry = Schema.encodeSync(EntrySchema);
  const positiveTtlMs = Duration.toMillis(options.positiveTtl);
  const negativeTtlMs = Duration.toMillis(options.negativeTtl);

  return {
    read: (key) =>
      Effect.gen(function* () {
        const kv = yield* KeyValueStorage.KeyValueStore;
        const raw = yield* kv
          .get(options.keyPrefix + key)
          .pipe(Effect.orElseSucceed(() => Option.none<string>()));
        if (Option.isNone(raw)) return Option.none<A | null>();
        const decoded = decodeEntry(raw.value);
        if (decoded._tag === "Left") return Option.none<A | null>();
        const nowMs = yield* Clock.currentTimeMillis;
        const ttlMs = decoded.right.value === null ? negativeTtlMs : positiveTtlMs;
        if (nowMs - decoded.right.fetchedAt > ttlMs) return Option.none<A | null>();
        return Option.some<A | null>(decoded.right.value);
      }),
    write: (key, value) =>
      Effect.gen(function* () {
        const kv = yield* KeyValueStorage.KeyValueStore;
        const nowMs = yield* Clock.currentTimeMillis;
        yield* kv
          .set(options.keyPrefix + key, encodeEntry({ fetchedAt: nowMs, value }))
          .pipe(Effect.ignore);
      }),
  };
};
