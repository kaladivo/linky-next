/**
 * Master identity workflow tests: the create -> phrase -> restore round-trip
 * contract ("account creation must never produce an identity that can't be
 * recovered"), restore input normalization, typed error paths, and the
 * branded schemas. Compatibility with the PoC is covered separately by
 * `slip39.golden.test.ts`.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { Randomness, RandomnessError } from "../../ports/Randomness.js";
import {
  BACKUP_PHRASE_WORD_COUNT,
  BackupPhrase,
  MASTER_SECRET_BYTE_COUNT,
  MasterSecret,
  backupPhraseWords,
} from "./MasterIdentity.js";
import { createMasterIdentity } from "./createMasterIdentity.js";
import { isValidBackupPhrase, restoreMasterIdentity } from "./restoreMasterIdentity.js";
import { SLIP39_WORDLIST } from "./slip39Wordlist.js";

/**
 * Deterministic test CSPRNG: an SHA-256 counter stream over the seed. Not
 * secure — exists so the round-trip property runs over reproducible "random"
 * seeds without platform crypto.
 */
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

const RandomnessFailing = Layer.succeed(Randomness, {
  nextBytes: (byteCount) =>
    Effect.fail(new RandomnessError({ requestedBytes: byteCount, cause: "no entropy" })),
});

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const create = (seed: string) =>
  Effect.runPromise(createMasterIdentity.pipe(Effect.provide(RandomnessDeterministic(seed))));

describe("create -> phrase -> restore round-trip (recoverability contract)", () => {
  // 32 PBKDF2 round-trips exceed vitest's 5s default on slow CI runners.
  it("restores the exact master secret for many random seeds", { timeout: 120_000 }, async () => {
    for (let i = 0; i < 32; i++) {
      const identity = await create(`round-trip-${i}`);
      expect(identity.masterSecret).toHaveLength(MASTER_SECRET_BYTE_COUNT);
      expect(backupPhraseWords(identity.backupPhrase)).toHaveLength(BACKUP_PHRASE_WORD_COUNT);

      const restored = await Effect.runPromise(restoreMasterIdentity(identity.backupPhrase));
      expect(toHex(restored.masterSecret)).toBe(toHex(identity.masterSecret));
      expect(restored.backupPhrase).toBe(identity.backupPhrase);
      expect(isValidBackupPhrase(identity.backupPhrase)).toBe(true);
    }
  });

  it("creation is a pure function of the consumed entropy", async () => {
    const first = await create("determinism");
    const second = await create("determinism");
    expect(second.backupPhrase).toBe(first.backupPhrase);
    expect(toHex(second.masterSecret)).toBe(toHex(first.masterSecret));

    const other = await create("determinism-other");
    expect(other.backupPhrase).not.toBe(first.backupPhrase);
  });

  it("produces canonical phrases: 20 lowercase wordlist words, single spaces", async () => {
    const identity = await create("canonical");
    const words = backupPhraseWords(identity.backupPhrase);
    expect(identity.backupPhrase).toBe(words.join(" "));
    for (const word of words) expect(SLIP39_WORDLIST).toContain(word);
  });

  it("propagates RandomnessError from the port", async () => {
    const error = await Effect.runPromise(
      Effect.flip(createMasterIdentity.pipe(Effect.provide(RandomnessFailing))),
    );
    expect(error._tag).toBe("RandomnessError");
  });
});

describe("restore input handling", () => {
  it("accepts pasted input with mixed case, separators, and odd whitespace", async () => {
    const identity = await create("messy-input");
    const words = backupPhraseWords(identity.backupPhrase);
    const messy = `  ${words.slice(0, 5).join(", ")};\n${words.slice(5, 12).join("\t")}\r\n  ${words
      .slice(12)
      .map((word) => word.toUpperCase())
      .join("   ")} `;

    const restored = await Effect.runPromise(restoreMasterIdentity(messy));
    expect(restored.backupPhrase).toBe(identity.backupPhrase);
    expect(toHex(restored.masterSecret)).toBe(toHex(identity.masterSecret));
  });

  it("fails empty input with word-count and wordCount 0", async () => {
    const error = await Effect.runPromise(Effect.flip(restoreMasterIdentity("   ")));
    expect(error.reason).toBe("word-count");
    expect(error.wordCount).toBe(0);
  });

  it("fails partial input with word-count and the actual count", async () => {
    const identity = await create("partial-input");
    const partial = backupPhraseWords(identity.backupPhrase).slice(0, 13).join(" ");
    const error = await Effect.runPromise(Effect.flip(restoreMasterIdentity(partial)));
    expect(error.reason).toBe("word-count");
    expect(error.wordCount).toBe(13);
  });

  it("lists words that are not in the wordlist", async () => {
    const identity = await create("unknown-words");
    const words = [...backupPhraseWords(identity.backupPhrase)];
    words[3] = "qwerty";
    words[17] = "linky";
    const error = await Effect.runPromise(Effect.flip(restoreMasterIdentity(words.join(" "))));
    expect(error.reason).toBe("unknown-words");
    expect(error.unknownWords).toEqual(["qwerty", "linky"]);
    expect(error.wordCount).toBe(20);
  });

  it("fails with checksum when valid words are reordered", async () => {
    const identity = await create("checksum");
    const words = [...backupPhraseWords(identity.backupPhrase)];
    [words[5], words[6]] = [words[6]!, words[5]!];
    const error = await Effect.runPromise(Effect.flip(restoreMasterIdentity(words.join(" "))));
    expect(error.reason).toBe("checksum");
  });

  it("never carries secret material in errors", async () => {
    const identity = await create("no-secrets-in-errors");
    const words = [...backupPhraseWords(identity.backupPhrase)];
    [words[5], words[6]] = [words[6]!, words[5]!];
    const error = await Effect.runPromise(Effect.flip(restoreMasterIdentity(words.join(" "))));
    const serialized = JSON.stringify(error);
    for (const word of words) expect(serialized).not.toContain(`"${word}"`);
  });
});

describe("branded schemas", () => {
  it("BackupPhrase rejects non-canonical and non-restorable strings", async () => {
    const identity = await create("schemas");
    const phrase: string = identity.backupPhrase;
    expect(Schema.is(BackupPhrase)(phrase)).toBe(true);
    expect(Schema.is(BackupPhrase)(phrase.toUpperCase())).toBe(false);
    expect(Schema.is(BackupPhrase)(` ${phrase}`)).toBe(false);
    expect(Schema.is(BackupPhrase)(phrase.replace(" ", "  "))).toBe(false);
    expect(Schema.is(BackupPhrase)("academic acid")).toBe(false);
  });

  it("MasterSecret requires exactly 16 bytes", () => {
    expect(Schema.is(MasterSecret)(new Uint8Array(16))).toBe(true);
    expect(Schema.is(MasterSecret)(new Uint8Array(15))).toBe(false);
    expect(Schema.is(MasterSecret)(new Uint8Array(32))).toBe(false);
  });
});
