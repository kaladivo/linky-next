/**
 * Golden tests for SLIP-39 master identity compatibility (issue #12).
 *
 * The fixtures in `__fixtures__/slip39.golden.json` were generated FROM THE
 * POC's actual library (slip39-ts@0.1.13) before this implementation was
 * written — see `__fixtures__/README.md`. These tests prove the rewrite
 * reproduces the PoC byte-for-byte:
 *
 *   - restore: same phrase -> same master secret bytes
 *   - create: same entropy + identifier -> same 20-word phrase
 *   - Feistel layer: same master secret -> same encrypted share value
 */
import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { Randomness } from "../../ports/Randomness.js";
import { backupPhraseWords, BackupPhrase } from "./MasterIdentity.js";
import { createMasterIdentity } from "./createMasterIdentity.js";
import { isValidBackupPhrase, restoreMasterIdentity } from "./restoreMasterIdentity.js";
import { decodeShareWords, encryptMasterSecretBytes } from "./slip39.js";

interface ShareFixture {
  readonly name: string;
  readonly mnemonic: string;
  readonly masterSecretHex: string;
  readonly identifier: number;
  readonly extendable: boolean;
  readonly iterationExponent: number;
  readonly encryptedMasterSecretHex: string;
}

interface MnemonicFixture {
  readonly name: string;
  readonly mnemonic: string;
}

interface GoldenFixtures {
  readonly shares: ReadonlyArray<ShareFixture>;
  readonly invalidMnemonics: ReadonlyArray<MnemonicFixture>;
  readonly unsupportedMnemonics: ReadonlyArray<MnemonicFixture>;
}

const fixtures = JSON.parse(
  readFileSync(new URL("./__fixtures__/slip39.golden.json", import.meta.url), "utf8"),
) as GoldenFixtures;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));

/** Feeds exact byte sequences to `createMasterIdentity`, in request order. */
const RandomnessQueue = (...buffers: ReadonlyArray<Uint8Array>) =>
  Layer.sync(Randomness, () => {
    const queue = [...buffers];
    return {
      nextBytes: (byteCount: number) =>
        Effect.sync(() => {
          const next = queue.shift();
          if (next === undefined || next.length !== byteCount) {
            throw new Error(`unexpected nextBytes(${byteCount}) request`);
          }
          return next;
        }),
    };
  });

describe("golden: restore (same phrase -> same master secret as the PoC)", () => {
  it.each(fixtures.shares)("$name", async ({ mnemonic, masterSecretHex }) => {
    const identity = await Effect.runPromise(restoreMasterIdentity(mnemonic));
    expect(toHex(identity.masterSecret)).toBe(masterSecretHex);
    expect(identity.backupPhrase).toBe(mnemonic);
    expect(isValidBackupPhrase(mnemonic)).toBe(true);
  });

  it("fixture file pins all PoC share variants", () => {
    expect(fixtures.shares.length).toBe(7);
    expect(fixtures.shares.some((share) => !share.extendable)).toBe(true);
    expect(fixtures.shares.some((share) => share.iterationExponent > 0)).toBe(true);
  });
});

describe("golden: create (same entropy + identifier -> same phrase as the PoC)", () => {
  // Creation always emits the PoC default share format: extendable, exponent 0.
  const creatable = fixtures.shares.filter(
    (share) => share.extendable && share.iterationExponent === 0,
  );

  it("covers every extendable/exponent-0 fixture", () => {
    expect(creatable.length).toBe(5);
  });

  it.each(creatable)("$name", async ({ mnemonic, masterSecretHex, identifier }) => {
    const identityBytes = Uint8Array.of((identifier >> 8) & 0x7f, identifier & 0xff);
    const identity = await Effect.runPromise(
      createMasterIdentity.pipe(
        Effect.provide(RandomnessQueue(fromHex(masterSecretHex), identityBytes)),
      ),
    );
    expect(identity.backupPhrase).toBe(mnemonic);
    expect(toHex(identity.masterSecret)).toBe(masterSecretHex);
    expect(backupPhraseWords(identity.backupPhrase)).toHaveLength(20);
  });
});

describe("golden: Feistel layer (same master secret -> same encrypted share value)", () => {
  it.each(fixtures.shares)(
    "$name",
    ({ masterSecretHex, identifier, extendable, iterationExponent, encryptedMasterSecretHex }) => {
      const encrypted = encryptMasterSecretBytes(
        fromHex(masterSecretHex),
        identifier,
        extendable,
        iterationExponent,
      );
      expect(toHex(encrypted)).toBe(encryptedMasterSecretHex);
    },
  );

  it.each(fixtures.shares)(
    "decodes share metadata exactly ($name)",
    ({ mnemonic, identifier, extendable, iterationExponent, encryptedMasterSecretHex }) => {
      const decoded = decodeShareWords(mnemonic.split(" "));
      expect(decoded._tag).toBe("Decoded");
      if (decoded._tag !== "Decoded") return;
      expect(decoded.share.identifier).toBe(identifier);
      expect(decoded.share.extendable).toBe(extendable);
      expect(decoded.share.iterationExponent).toBe(iterationExponent);
      expect(decoded.share.groupThreshold).toBe(1);
      expect(decoded.share.memberThreshold).toBe(1);
      expect(toHex(decoded.share.encryptedSecret)).toBe(encryptedMasterSecretHex);
    },
  );
});

describe("golden: rejected inputs (confirmed invalid/unsupported by slip39-ts)", () => {
  it.each(fixtures.invalidMnemonics)("$name", async ({ mnemonic }) => {
    const error = await Effect.runPromise(Effect.flip(restoreMasterIdentity(mnemonic)));
    expect(error._tag).toBe("InvalidBackupPhraseError");
    expect(error.reason).toBe("checksum");
    expect(isValidBackupPhrase(mnemonic)).toBe(false);
    expect(() => BackupPhrase.make(mnemonic)).toThrow();
  });

  it.each(fixtures.unsupportedMnemonics)("$name", async ({ mnemonic }) => {
    const error = await Effect.runPromise(Effect.flip(restoreMasterIdentity(mnemonic)));
    expect(error.reason).toBe("unsupported-share");
    expect(isValidBackupPhrase(mnemonic)).toBe(false);
    expect(() => BackupPhrase.make(mnemonic)).toThrow();
  });
});
