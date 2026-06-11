/**
 * copyBackupPhrase tests (#19): the explicit backup-copy action against an
 * in-memory Clipboard Layer — the copied value is the canonical phrase
 * verbatim (round-trippable through restore), and port failures surface as
 * the typed ClipboardError.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { Clipboard, ClipboardError } from "../../ports/Clipboard.js";
import { Randomness } from "../../ports/Randomness.js";
import { backupPhraseWords, BACKUP_PHRASE_WORD_COUNT } from "./MasterIdentity.js";
import { copyBackupPhrase } from "./copyBackupPhrase.js";
import { createMasterIdentity } from "./createMasterIdentity.js";
import { restoreMasterIdentity } from "./restoreMasterIdentity.js";

/** Deterministic test CSPRNG (same scheme as identitySession.test.ts). */
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

/** In-memory Clipboard; `slot` is shared so tests can inspect what landed. */
const ClipboardMemory = (slot: { value: string | null }) =>
  Layer.sync(Clipboard, () => ({
    copy: (text: string) => Effect.sync(() => void (slot.value = text)),
    read: Effect.sync(() => Option.fromNullable(slot.value)),
  }));

const ClipboardFailing = Layer.succeed(Clipboard, {
  copy: () => Effect.fail(new ClipboardError({ operation: "copy", cause: "pasteboard down" })),
  read: Effect.fail(new ClipboardError({ operation: "read", cause: "pasteboard down" })),
});

const makeIdentity = (seed: string) =>
  Effect.runPromise(
    createMasterIdentity.pipe(Effect.provide(RandomnessDeterministic(seed))),
  );

describe("copyBackupPhrase", () => {
  it("puts the canonical phrase on the clipboard verbatim", async () => {
    const identity = await makeIdentity("copy-verbatim");
    const slot: { value: string | null } = { value: null };

    await Effect.runPromise(
      copyBackupPhrase(identity.backupPhrase).pipe(Effect.provide(ClipboardMemory(slot))),
    );

    expect(slot.value).toBe(identity.backupPhrase);
    expect(slot.value?.split(" ")).toHaveLength(BACKUP_PHRASE_WORD_COUNT);
    expect(slot.value?.split(" ")).toEqual([...backupPhraseWords(identity.backupPhrase)]);
  });

  it("the copied value restores to the same identity (paste round-trip)", async () => {
    const identity = await makeIdentity("copy-roundtrip");
    const slot: { value: string | null } = { value: null };

    await Effect.runPromise(
      copyBackupPhrase(identity.backupPhrase).pipe(Effect.provide(ClipboardMemory(slot))),
    );

    const restored = await Effect.runPromise(restoreMasterIdentity(slot.value ?? ""));
    expect(restored.masterSecret).toEqual(identity.masterSecret);
  });

  it("surfaces clipboard failures as the typed ClipboardError", async () => {
    const identity = await makeIdentity("copy-failing");

    const error = await Effect.runPromise(
      Effect.flip(copyBackupPhrase(identity.backupPhrase)).pipe(
        Effect.provide(ClipboardFailing),
      ),
    );

    expect(error._tag).toBe("ClipboardError");
    expect(error.operation).toBe("copy");
  });
});
