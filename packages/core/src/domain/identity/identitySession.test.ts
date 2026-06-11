/**
 * Identity session tests (#14): save/load/clear round-trip against an
 * in-memory SecureStorage Layer, both boot-decision branches, error paths,
 * and the no-secret-in-error contract (serialized errors never contain the
 * backup phrase, its words, or the master secret hex).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { Randomness } from "../../ports/Randomness.js";
import { SecureStorage, SecureStorageError } from "../../ports/SecureStorage.js";
import { backupPhraseWords } from "./MasterIdentity.js";
import type { MasterIdentity } from "./MasterIdentity.js";
import { deriveCashuWallet } from "./deriveCashuWallet.js";
import { deriveNostrIdentity } from "./deriveNostrIdentity.js";
import {
  BACKUP_PHRASE_STORAGE_KEY,
  clearIdentitySession,
  createIdentitySession,
  loadSession,
  persistIdentity,
  restoreIdentitySession,
} from "./identitySession.js";

/** Deterministic test CSPRNG (same scheme as masterIdentity.test.ts). */
const RandomnessDeterministic = (seed: string) =>
  Layer.sync(Randomness, () => {
    let counter = 0;
    let pool = new Uint8Array(0);
    return {
      nextBytes: (byteCount: number) =>
        Effect.sync(() => {
          while (pool.length < byteCount) {
            const block = sha256(new TextEncoder().encode(`${seed}:${counter++}`));
            const grown = new Uint8Array(pool.length + block.length);
            grown.set(pool, 0);
            grown.set(block, pool.length);
            pool = grown;
          }
          const out = pool.slice(0, byteCount);
          pool = pool.slice(byteCount);
          return out;
        }),
    };
  });

/** In-memory SecureStorage; `store` is shared so tests can inspect/corrupt it. */
const SecureStorageMemory = (store: Map<string, string>) =>
  Layer.sync(SecureStorage, () => ({
    get: (key: string) => Effect.sync(() => Option.fromNullable(store.get(key))),
    set: (key: string, value: string) => Effect.sync(() => void store.set(key, value)),
    delete: (key: string) => Effect.sync(() => void store.delete(key)),
  }));

/** SecureStorage that fails every operation like a locked keychain would. */
const SecureStorageFailing = Layer.succeed(SecureStorage, {
  get: (key) =>
    Effect.fail(new SecureStorageError({ operation: "get", key, cause: "keychain locked" })),
  set: (key) =>
    Effect.fail(new SecureStorageError({ operation: "set", key, cause: "keychain locked" })),
  delete: (key) =>
    Effect.fail(new SecureStorageError({ operation: "delete", key, cause: "keychain locked" })),
});

const layers = (store: Map<string, string>, seed = "session") =>
  Layer.merge(SecureStorageMemory(store), RandomnessDeterministic(seed));

const run = <A, E>(
  effect: Effect.Effect<A, E, SecureStorage | Randomness>,
  store: Map<string, string>,
  seed?: string,
) => Effect.runPromise(effect.pipe(Effect.provide(layers(store, seed))));

const flip = <A, E>(
  effect: Effect.Effect<A, E, SecureStorage | Randomness>,
  store: Map<string, string>,
  seed?: string,
) => Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(layers(store, seed))));

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Every string an error could leak from this identity. */
const secretFragments = (identity: MasterIdentity): string[] => [
  identity.backupPhrase,
  ...backupPhraseWords(identity.backupPhrase),
  toHex(identity.masterSecret),
];

const expectNoSecrets = (error: unknown, identity: MasterIdentity) => {
  const serialized = [
    JSON.stringify(error),
    String(error),
    error instanceof Error ? (error.stack ?? "") : "",
  ].join("\n");
  for (const fragment of secretFragments(identity)) {
    expect(serialized).not.toContain(`"${fragment}"`);
    expect(serialized).not.toContain(` ${fragment} `);
  }
  // The full phrase and master secret hex must not appear anywhere at all.
  expect(serialized).not.toContain(identity.backupPhrase);
  expect(serialized).not.toContain(toHex(identity.masterSecret));
};

describe("save / load / clear round-trip", () => {
  it("createIdentitySession persists the phrase and loadSession restores the same session", async () => {
    const store = new Map<string, string>();
    const created = await run(createIdentitySession, store);

    expect(store.get(BACKUP_PHRASE_STORAGE_KEY)).toBe(created.masterIdentity.backupPhrase);
    expect(store.size).toBe(1);

    const state = await run(loadSession, store);
    expect(state._tag).toBe("IdentityLoaded");
    if (state._tag !== "IdentityLoaded") return;
    expect(state.session.masterIdentity.backupPhrase).toBe(created.masterIdentity.backupPhrase);
    expect(toHex(state.session.masterIdentity.masterSecret)).toBe(
      toHex(created.masterIdentity.masterSecret),
    );
    expect(state.session.nostr.npub).toBe(created.nostr.npub);
    expect(toHex(state.session.cashuWallet.seed)).toBe(toHex(created.cashuWallet.seed));
  });

  it("the session's derived identities match direct derivation from the master secret", async () => {
    const store = new Map<string, string>();
    const created = await run(createIdentitySession, store);
    const nostr = await Effect.runPromise(deriveNostrIdentity(created.masterIdentity.masterSecret));
    const cashu = await Effect.runPromise(deriveCashuWallet(created.masterIdentity.masterSecret));
    expect(created.nostr.npub).toBe(nostr.npub);
    expect(created.nostr.nsec).toBe(nostr.nsec);
    expect(created.cashuWallet.mnemonic).toBe(cashu.mnemonic);
  });

  it("restoreIdentitySession normalizes, persists and activates", async () => {
    const seedStore = new Map<string, string>();
    const original = await run(createIdentitySession, seedStore, "restore-source");

    const store = new Map<string, string>();
    const messyInput = ` ${original.masterIdentity.backupPhrase.toUpperCase().replace(/ /g, ",\n")} `;
    const restored = await run(restoreIdentitySession(messyInput), store);

    expect(restored.masterIdentity.backupPhrase).toBe(original.masterIdentity.backupPhrase);
    expect(store.get(BACKUP_PHRASE_STORAGE_KEY)).toBe(original.masterIdentity.backupPhrase);
    expect(restored.nostr.npub).toBe(original.nostr.npub);
  });

  it("persistIdentity alone makes loadSession find the identity", async () => {
    const scratch = new Map<string, string>();
    const created = await run(createIdentitySession, scratch, "persist-only");

    const store = new Map<string, string>();
    await run(persistIdentity(created.masterIdentity), store);
    const state = await run(loadSession, store);
    expect(state._tag).toBe("IdentityLoaded");
  });

  it("clearIdentitySession removes the secret and is idempotent", async () => {
    const store = new Map<string, string>();
    await run(createIdentitySession, store);
    expect(store.size).toBe(1);

    await run(clearIdentitySession, store);
    expect(store.size).toBe(0);
    await run(clearIdentitySession, store); // second logout still succeeds

    const state = await run(loadSession, store);
    expect(state._tag).toBe("NoIdentity");
  });
});

describe("boot decision", () => {
  it("returns NoIdentity on a fresh install (empty storage)", async () => {
    const state = await run(loadSession, new Map());
    expect(state).toEqual({ _tag: "NoIdentity" });
  });

  it("returns IdentityLoaded when an identity was persisted", async () => {
    const store = new Map<string, string>();
    await run(createIdentitySession, store);
    const state = await run(loadSession, store);
    expect(state._tag).toBe("IdentityLoaded");
  });
});

describe("error paths", () => {
  it("loadSession fails with IdentitySessionCorruptedError on an unrestorable stored value", async () => {
    const store = new Map<string, string>([[BACKUP_PHRASE_STORAGE_KEY, "not a backup phrase"]]);
    const error = await flip(loadSession, store);
    expect(error._tag).toBe("IdentitySessionCorruptedError");
    if (error._tag !== "IdentitySessionCorruptedError") return;
    expect(error.reason).toBe("word-count");
  });

  it("propagates SecureStorageError from every workflow", async () => {
    const failing = Layer.merge(SecureStorageFailing, RandomnessDeterministic("failing"));
    const flipFailing = <A, E>(effect: Effect.Effect<A, E, SecureStorage | Randomness>) =>
      Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(failing)));

    for (const error of await Promise.all([
      flipFailing(createIdentitySession),
      flipFailing(loadSession),
      flipFailing(clearIdentitySession),
    ])) {
      expect(error._tag).toBe("SecureStorageError");
    }
  });

  it("restoreIdentitySession fails with InvalidBackupPhraseError before touching storage", async () => {
    const store = new Map<string, string>();
    const error = await flip(restoreIdentitySession("definitely not words"), store);
    expect(error._tag).toBe("InvalidBackupPhraseError");
    expect(store.size).toBe(0);
  });
});

describe("no secret material in errors", () => {
  it("a corrupted-but-mostly-valid stored phrase never leaks its words", async () => {
    const scratch = new Map<string, string>();
    const created = await run(createIdentitySession, scratch, "corrupt-leak");
    const words = [...backupPhraseWords(created.masterIdentity.backupPhrase)];
    // Replace one word with garbage: restore fails with reason
    // "unknown-words", whose InvalidBackupPhraseError would list real input
    // words — the session error must not.
    words[7] = "zzzzgarbage";
    const store = new Map<string, string>([[BACKUP_PHRASE_STORAGE_KEY, words.join(" ")]]);

    const error = await flip(loadSession, store);
    expect(error._tag).toBe("IdentitySessionCorruptedError");
    if (error._tag !== "IdentitySessionCorruptedError") return;
    expect(error.reason).toBe("unknown-words");
    expectNoSecrets(error, created.masterIdentity);
    expect(JSON.stringify(error)).not.toContain("zzzzgarbage");
    expect(Object.keys(error)).not.toContain("unknownWords");
  });

  it("a checksum-corrupted stored phrase never leaks the phrase", async () => {
    const scratch = new Map<string, string>();
    const created = await run(createIdentitySession, scratch, "checksum-leak");
    const words = [...backupPhraseWords(created.masterIdentity.backupPhrase)];
    [words[0], words[1]] = [words[1]!, words[0]!];
    const store = new Map<string, string>([[BACKUP_PHRASE_STORAGE_KEY, words.join(" ")]]);

    const error = await flip(loadSession, store);
    expect(error._tag).toBe("IdentitySessionCorruptedError");
    expectNoSecrets(error, created.masterIdentity);
  });

  it("SecureStorageError surfaced by session workflows carries key names, never values", async () => {
    const scratch = new Map<string, string>();
    const created = await run(createIdentitySession, scratch, "storage-error-leak");

    const failing = Layer.merge(
      SecureStorageFailing,
      RandomnessDeterministic("storage-error-leak"),
    );
    const error = await Effect.runPromise(
      Effect.flip(persistIdentity(created.masterIdentity)).pipe(Effect.provide(failing)),
    );
    expect(error._tag).toBe("SecureStorageError");
    expect(error.key).toBe(BACKUP_PHRASE_STORAGE_KEY);
    expectNoSecrets(error, created.masterIdentity);
  });
});
