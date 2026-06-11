/**
 * Custom Nostr key override tests (#20): nsec validation (valid / invalid
 * vectors), activate/revert round-trip against an in-memory SecureStorage
 * Layer, switch-time recording via TestClock, active-identity resolution in
 * both branches, session integration, and the no-secret-in-error contract.
 *
 * The valid vector was generated with `nostr-tools@2.23.5` (the PoC's
 * NIP-19 codec — `nip19.nsecEncode` / `getPublicKey` / `nip19.npubEncode`),
 * independent of this repo's implementation. It is the NIP-19 spec example
 * key, NOT a real account. nostr-tools also confirmed the invalid-vector
 * semantics: raw hex is rejected by `nip19.decode` (PoC parity).
 */
import { Clock, Effect, Layer, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { Randomness } from "../../ports/Randomness.js";
import { SecureStorage, SecureStorageError } from "../../ports/SecureStorage.js";
import {
  CUSTOM_NOSTR_KEY_STORAGE_KEY,
  activateCustomNostrKey,
  loadCustomNostrKey,
  nostrIdentityFromNsec,
  resolveActiveNostrIdentity,
  revertToDerivedNostrKey,
} from "./customNostrKey.js";
import { deriveNostrIdentity } from "./deriveNostrIdentity.js";
import {
  clearIdentitySession,
  createIdentitySession,
  loadSession,
} from "./identitySession.js";
import { MasterSecret } from "./MasterIdentity.js";

/** Generated with nostr-tools@2.23.5 (see file doc). */
const VECTOR = {
  skHex: "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa",
  nsec: "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
  pubkeyHex: "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e",
  npub: "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg",
} as const;

/** bech32-valid `nsec` payloads that are NOT valid secp256k1 scalars. */
const ZERO_SCALAR_NSEC = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqwkhnav";
const OVER_ORDER_NSEC = "nsec1lllllllllllllllllllllllllllllllllllllllllllllllllllsvg5z5m";
/** bech32-valid `nsec` payloads with the wrong byte length (31 / 33 bytes). */
const SHORT_PAYLOAD_NSEC = "nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqy9t5sdr";
const LONG_PAYLOAD_NSEC = "nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsz8vejvw";
/** A perfectly valid bech32 key — with the wrong (npub) prefix. */
const NPUB_PREFIXED = "npub1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs8j9gdm";

const SecureStorageMemory = (store: Map<string, string>) =>
  Layer.sync(SecureStorage, () => ({
    get: (key: string) => Effect.sync(() => Option.fromNullable(store.get(key))),
    set: (key: string, value: string) => Effect.sync(() => void store.set(key, value)),
    delete: (key: string) => Effect.sync(() => void store.delete(key)),
  }));

const SecureStorageFailing = Layer.succeed(SecureStorage, {
  get: (key) =>
    Effect.fail(new SecureStorageError({ operation: "get", key, cause: "keychain locked" })),
  set: (key) =>
    Effect.fail(new SecureStorageError({ operation: "set", key, cause: "keychain locked" })),
  delete: (key) =>
    Effect.fail(new SecureStorageError({ operation: "delete", key, cause: "keychain locked" })),
});

/** Deterministic Randomness for the session-integration tests. */
const RandomnessFixed = Layer.succeed(Randomness, {
  nextBytes: (byteCount: number) =>
    Effect.sync(() => Uint8Array.from({ length: byteCount }, (_, i) => (i * 37 + 11) % 256)),
});

const run = <A, E>(
  effect: Effect.Effect<A, E, SecureStorage | Randomness>,
  store: Map<string, string>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.merge(SecureStorageMemory(store), RandomnessFixed))),
  );

const flip = <A, E>(
  effect: Effect.Effect<A, E, SecureStorage | Randomness>,
  store: Map<string, string>,
) => run(Effect.flip(effect), store);

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

describe("nostrIdentityFromNsec — validation", () => {
  it("accepts a valid nsec and derives the matching npub (nostr-tools vector)", async () => {
    const identity = await Effect.runPromise(nostrIdentityFromNsec(VECTOR.nsec));
    expect(identity.nsec).toBe(VECTOR.nsec);
    expect(identity.npub).toBe(VECTOR.npub);
    expect(identity.publicKeyHex).toBe(VECTOR.pubkeyHex);
    expect(toHex(identity.secretKey)).toBe(VECTOR.skHex);
  });

  it("trims surrounding whitespace and canonicalizes uppercase bech32", async () => {
    const padded = await Effect.runPromise(nostrIdentityFromNsec(`  ${VECTOR.nsec}\n`));
    expect(padded.npub).toBe(VECTOR.npub);

    // All-uppercase is valid bech32 (nostr-tools accepts it too); the
    // returned nsec/npub are canonical lowercase.
    const upper = await Effect.runPromise(nostrIdentityFromNsec(VECTOR.nsec.toUpperCase()));
    expect(upper.nsec).toBe(VECTOR.nsec);
    expect(upper.npub).toBe(VECTOR.npub);
  });

  it.each([
    ["empty string", "", "empty"],
    ["whitespace only", "   \n", "empty"],
    ["raw hex (PoC rejects hex)", VECTOR.skHex, "malformed"],
    ["npub instead of nsec", NPUB_PREFIXED, "malformed"],
    ["bad checksum", VECTOR.nsec.slice(0, -1) + (VECTOR.nsec.endsWith("5") ? "6" : "5"), "malformed"],
    ["not bech32 at all", "definitely not a key", "malformed"],
    ["31-byte payload", SHORT_PAYLOAD_NSEC, "malformed"],
    ["33-byte payload", LONG_PAYLOAD_NSEC, "malformed"],
    ["zero scalar", ZERO_SCALAR_NSEC, "invalid-scalar"],
    ["scalar >= curve order", OVER_ORDER_NSEC, "invalid-scalar"],
  ])("rejects %s with reason %s", async (_label, input, reason) => {
    const error = await Effect.runPromise(Effect.flip(nostrIdentityFromNsec(input)));
    expect(error._tag).toBe("InvalidNsecError");
    expect(error.reason).toBe(reason);
  });

  it("never echoes the pasted input in the error", async () => {
    const error = await Effect.runPromise(Effect.flip(nostrIdentityFromNsec(VECTOR.skHex)));
    const serialized = [JSON.stringify(error), String(error), error.stack ?? ""].join("\n");
    expect(serialized).not.toContain(VECTOR.skHex);
  });
});

describe("activate / revert round-trip", () => {
  it("activateCustomNostrKey persists the override and records the switch time", async () => {
    const store = new Map<string, string>();
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(1_750_000_000_400); // not a whole second
      return yield* activateCustomNostrKey(VECTOR.nsec);
    });
    const active = await Effect.runPromise(
      program.pipe(
        Effect.provide(SecureStorageMemory(store)),
        Effect.provide(TestContext.TestContext),
      ),
    );

    expect(active.source).toBe("custom");
    expect(active.identity.npub).toBe(VECTOR.npub);
    // PoC parity: Math.ceil(Date.now() / 1000).
    expect(active.activatedAtSec).toBe(1_750_000_001);

    const stored = JSON.parse(store.get(CUSTOM_NOSTR_KEY_STORAGE_KEY)!);
    expect(stored).toEqual({ nsec: VECTOR.nsec, activatedAtSec: 1_750_000_001 });
  });

  it("loadCustomNostrKey round-trips the stored override", async () => {
    const store = new Map<string, string>();
    await run(activateCustomNostrKey(VECTOR.nsec), store);

    const loaded = await run(loadCustomNostrKey, store);
    expect(Option.isSome(loaded)).toBe(true);
    if (Option.isNone(loaded)) return;
    expect(loaded.value.identity.npub).toBe(VECTOR.npub);
    expect(loaded.value.activatedAtSec).toBeGreaterThan(0);
  });

  it("revertToDerivedNostrKey deletes the override and is idempotent", async () => {
    const store = new Map<string, string>();
    await run(activateCustomNostrKey(VECTOR.nsec), store);
    expect(store.has(CUSTOM_NOSTR_KEY_STORAGE_KEY)).toBe(true);

    await run(revertToDerivedNostrKey, store);
    expect(store.has(CUSTOM_NOSTR_KEY_STORAGE_KEY)).toBe(false);
    await run(revertToDerivedNostrKey, store); // reverting again still succeeds

    expect(Option.isNone(await run(loadCustomNostrKey, store))).toBe(true);
  });

  it("re-activating overwrites the previous override and its switch time", async () => {
    const store = new Map<string, string>();
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000_000_000);
      const first = yield* activateCustomNostrKey(VECTOR.nsec);
      yield* TestClock.setTime(2_000_000_000_000);
      const second = yield* activateCustomNostrKey(VECTOR.nsec);
      return { first, second };
    });
    const { first, second } = await Effect.runPromise(
      program.pipe(
        Effect.provide(SecureStorageMemory(store)),
        Effect.provide(TestContext.TestContext),
      ),
    );
    expect(first.activatedAtSec).toBe(1_000_000_000);
    expect(second.activatedAtSec).toBe(2_000_000_000);
    expect(JSON.parse(store.get(CUSTOM_NOSTR_KEY_STORAGE_KEY)!).activatedAtSec).toBe(
      2_000_000_000,
    );
  });

  it("an invalid paste fails before touching storage", async () => {
    const store = new Map<string, string>();
    const error = await flip(activateCustomNostrKey("nope"), store);
    expect(error._tag).toBe("InvalidNsecError");
    expect(store.size).toBe(0);
  });
});

describe("active-identity resolution", () => {
  // Any 16-byte master secret works for the derived branch.
  const derived = Effect.runSync(
    deriveNostrIdentity(MasterSecret.make(Uint8Array.from({ length: 16 }, (_, i) => i + 1))),
  );

  it("resolves to the derived default when no override is stored", async () => {
    const active = await run(resolveActiveNostrIdentity(derived), new Map());
    expect(active.source).toBe("derived");
    expect(active.identity.npub).toBe(derived.npub);
    expect("activatedAtSec" in active).toBe(false);
  });

  it("resolves to the custom override when one is stored", async () => {
    const store = new Map<string, string>();
    await run(activateCustomNostrKey(VECTOR.nsec), store);
    const active = await run(resolveActiveNostrIdentity(derived), store);
    expect(active.source).toBe("custom");
    expect(active.identity.npub).toBe(VECTOR.npub);
    if (active.source === "custom") expect(active.activatedAtSec).toBeGreaterThan(0);
  });
});

describe("session integration", () => {
  it("loadSession surfaces the active identity in both branches", async () => {
    const store = new Map<string, string>();
    const created = await run(createIdentitySession, store);
    expect(created.activeNostr.source).toBe("derived");

    const before = await run(loadSession, store);
    if (before._tag !== "IdentityLoaded") throw new Error("expected IdentityLoaded");
    expect(before.session.activeNostr.source).toBe("derived");
    expect(before.session.activeNostr.identity.npub).toBe(before.session.nostr.npub);

    await run(activateCustomNostrKey(VECTOR.nsec), store);
    const after = await run(loadSession, store);
    if (after._tag !== "IdentityLoaded") throw new Error("expected IdentityLoaded");
    expect(after.session.activeNostr.source).toBe("custom");
    expect(after.session.activeNostr.identity.npub).toBe(VECTOR.npub);
    // The derived default is still exposed unchanged next to the override.
    expect(after.session.nostr.npub).toBe(before.session.nostr.npub);

    await run(revertToDerivedNostrKey, store);
    const reverted = await run(loadSession, store);
    if (reverted._tag !== "IdentityLoaded") throw new Error("expected IdentityLoaded");
    expect(reverted.session.activeNostr.source).toBe("derived");
    expect(reverted.session.activeNostr.identity.npub).toBe(before.session.nostr.npub);
  });

  it("createIdentitySession clears a stale override from a previous identity", async () => {
    const store = new Map<string, string>();
    await run(createIdentitySession, store);
    await run(activateCustomNostrKey(VECTOR.nsec), store);

    const fresh = await run(createIdentitySession, store);
    expect(fresh.activeNostr.source).toBe("derived");
    expect(store.has(CUSTOM_NOSTR_KEY_STORAGE_KEY)).toBe(false);
  });

  it("logout clears the override together with the backup phrase", async () => {
    const store = new Map<string, string>();
    await run(createIdentitySession, store);
    await run(activateCustomNostrKey(VECTOR.nsec), store);
    expect(store.size).toBe(2);

    await run(clearIdentitySession, store);
    expect(store.size).toBe(0);
  });
});

describe("error paths", () => {
  it("a corrupted stored override fails loadCustomNostrKey (and loadSession) without leaking it", async () => {
    for (const corrupted of ["not json", `{"nsec":42,"activatedAtSec":1}`, `{"nsec":"x"}`]) {
      const store = new Map<string, string>([[CUSTOM_NOSTR_KEY_STORAGE_KEY, corrupted]]);
      const error = await flip(loadCustomNostrKey, store);
      expect(error._tag).toBe("CustomNostrKeyCorruptedError");
      if (error._tag !== "CustomNostrKeyCorruptedError") return;
      expect(error.reason).toBe("unparseable");
    }

    // Parseable JSON whose nsec is not a usable key → reason-only error.
    const store = new Map<string, string>();
    await run(createIdentitySession, store);
    store.set(
      CUSTOM_NOSTR_KEY_STORAGE_KEY,
      JSON.stringify({ nsec: ZERO_SCALAR_NSEC, activatedAtSec: 1 }),
    );
    const error = await flip(loadSession, store);
    expect(error._tag).toBe("CustomNostrKeyCorruptedError");
    if (error._tag !== "CustomNostrKeyCorruptedError") return;
    expect(error.reason).toBe("invalid-nsec");
    const serialized = [JSON.stringify(error), String(error)].join("\n");
    expect(serialized).not.toContain(ZERO_SCALAR_NSEC);
  });

  it("propagates SecureStorageError from every workflow", async () => {
    const flipFailing = <A, E>(effect: Effect.Effect<A, E, SecureStorage>) =>
      Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(SecureStorageFailing)));

    for (const error of await Promise.all([
      flipFailing(activateCustomNostrKey(VECTOR.nsec)),
      flipFailing(loadCustomNostrKey),
      flipFailing(revertToDerivedNostrKey),
    ])) {
      expect(error._tag).toBe("SecureStorageError");
    }
  });
});

describe("clock semantics", () => {
  it("activatedAtSec is derived from the Effect Clock, not Date.now()", async () => {
    const store = new Map<string, string>();
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(123_456_000);
      const millis = yield* Clock.currentTimeMillis;
      expect(millis).toBe(123_456_000);
      return yield* activateCustomNostrKey(VECTOR.nsec);
    });
    const active = await Effect.runPromise(
      program.pipe(
        Effect.provide(SecureStorageMemory(store)),
        Effect.provide(TestContext.TestContext),
      ),
    );
    expect(active.activatedAtSec).toBe(123_456);
  });
});
