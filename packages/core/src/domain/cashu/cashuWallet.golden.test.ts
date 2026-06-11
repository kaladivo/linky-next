/**
 * Golden tests for the Cashu wallet engine (issue #32).
 *
 * The fixtures in `__fixtures__/cashuWallet.golden.json` were generated FROM
 * THE POC's own @cashu/cashu-ts@2.9.0 (the exact version linky-poc resolves)
 * and the PoC's verbatim token-handling code BEFORE this engine was written
 * — see `__fixtures__/README.md`. They prove, for the pinned test seeds:
 *
 *   - same (seed, keysetId, counter) -> byte-identical NUT-13 proof secret,
 *     blinding factor, and blinded message B_ as the PoC produces;
 *   - same amount split -> same ordered outputs at sequential counters;
 *   - restore blank outputs (amount 0) derive identically;
 *   - identical NUT-08 blank-output counts per fee reserve;
 *   - identical token encodings (V3 + V4), share-URL and deep-link formats,
 *     and token-extraction behavior for scanner/paste inputs;
 *   - the engine's end-to-end receive produces EXACTLY the fixture secrets
 *     when run with the fixture counters (counter plumbing == PoC).
 */
import { readFileSync } from "node:fs";
import { OutputData } from "@cashu/cashu-ts";
import { deriveBlindingFactor, deriveSecret } from "@cashu/cashu-ts/crypto/client/NUT09";
import { hashToCurve } from "@cashu/cashu-ts/crypto/common";
import { bytesToNumber } from "@cashu/cashu-ts/crypto/util";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { CounterStoreMemory } from "../../ports/CounterStore.js";
import { MasterSecret } from "../identity/MasterIdentity.js";
import { deriveCashuWallet } from "../identity/deriveCashuWallet.js";
import { CashuSeed } from "../identity/DerivedIdentities.js";
import { FakeMint, FAKE_MINT_URL, fakeMintHttpLayer } from "./__tests__/fakeMint.js";
import { computeNumberOfBlankOutputs } from "./internal/deterministic.js";
import { receiveToken } from "./receiveToken.js";
import {
  buildCashuDeepLink,
  buildCashuShareUrl,
  encodeCashuToken,
  extractCashuTokenFromText,
  parseCashuToken,
} from "./tokenCodec.js";

interface DerivationFixture {
  readonly identity: string;
  readonly keysetId: string;
  readonly counter: number;
  readonly secret: string;
  readonly derivedSecretHex: string;
  readonly blindingFactorHex: string;
  readonly blindingFactorBigint: string;
  readonly B_: string;
}

interface SplitOutputFixture {
  readonly amount: number;
  readonly secret: string;
  readonly B_: string;
}

interface GoldenFixtures {
  readonly identities: ReadonlyArray<{
    readonly name: string;
    readonly masterSecretHex: string;
    readonly cashuSeedHex: string;
  }>;
  readonly keysets: {
    readonly staticKeysetId: string;
    readonly fakeMint: {
      readonly unit: string;
      readonly amounts: ReadonlyArray<number>;
      readonly keys: Readonly<Record<string, string>>;
      readonly keysetId: string;
    };
  };
  readonly derivations: ReadonlyArray<DerivationFixture>;
  readonly deterministicSplits: ReadonlyArray<{
    readonly identity: string;
    readonly keysetId: string;
    readonly amount: number;
    readonly counterStart: number;
    readonly outputs: ReadonlyArray<SplitOutputFixture>;
  }>;
  readonly restoreBlanks: {
    readonly identity: string;
    readonly keysetId: string;
    readonly counterStart: number;
    readonly count: number;
    readonly outputs: ReadonlyArray<SplitOutputFixture>;
  };
  readonly blankOutputCounts: ReadonlyArray<{
    readonly feeReserve: number;
    readonly count: number;
  }>;
  readonly token: {
    readonly decoded: {
      readonly mint: string;
      readonly unit: string;
      readonly memo: string;
      readonly proofs: ReadonlyArray<{
        readonly id: string;
        readonly amount: number;
        readonly secret: string;
        readonly C: string;
      }>;
    };
    readonly encodedV4: string;
    readonly encodedV3: string;
    readonly metadata: {
      readonly mint: string;
      readonly unit: string;
      readonly memo: string | null;
      readonly amount: number;
    };
  };
  readonly links: {
    readonly token: string;
    readonly shareUrl: string;
    readonly deepLink: string;
  };
  readonly tokenExtraction: ReadonlyArray<{
    readonly input: string;
    readonly expected: string | null;
  }>;
}

const fixtures = JSON.parse(
  readFileSync(new URL("./__fixtures__/cashuWallet.golden.json", import.meta.url), "utf8"),
) as GoldenFixtures;

const seedOf = (identityName: string): Uint8Array => {
  const identity = fixtures.identities.find((entry) => entry.name === identityName);
  if (identity === undefined) throw new Error(`fixture identity missing: ${identityName}`);
  return hexToBytes(identity.cashuSeedHex);
};

describe("cashu golden: wallet seed (ties #13 to this engine)", () => {
  for (const identity of fixtures.identities) {
    it(`derives the pinned seed for ${identity.name}`, async () => {
      const masterSecret = MasterSecret.make(hexToBytes(identity.masterSecretHex));
      const wallet = await Effect.runPromise(deriveCashuWallet(masterSecret));
      expect(bytesToHex(wallet.seed)).toBe(identity.cashuSeedHex);
    });
  }
});

describe("cashu golden: NUT-13 derivations match the PoC's cashu-ts", () => {
  it("derives byte-identical secrets, blinding factors and blinded messages", () => {
    expect(fixtures.derivations.length).toBeGreaterThan(50);
    for (const derivation of fixtures.derivations) {
      const seed = seedOf(derivation.identity);

      const secret = deriveSecret(seed, derivation.keysetId, derivation.counter);
      expect(bytesToHex(secret)).toBe(derivation.derivedSecretHex);

      const blindingFactor = deriveBlindingFactor(seed, derivation.keysetId, derivation.counter);
      expect(bytesToHex(blindingFactor)).toBe(derivation.blindingFactorHex);

      const single = OutputData.createSingleDeterministicData(
        1,
        seed,
        derivation.counter,
        derivation.keysetId,
      );
      expect(new TextDecoder().decode(single.secret)).toBe(derivation.secret);
      expect(single.blindingFactor.toString()).toBe(derivation.blindingFactorBigint);
      expect(single.blindedMessage.B_).toBe(derivation.B_);
    }
  });

  it("splits amounts into the same ordered outputs at sequential counters", () => {
    const keys = { ...fixtures.keysets.fakeMint.keys };
    for (const split of fixtures.deterministicSplits) {
      const outputs = OutputData.createDeterministicData(
        split.amount,
        seedOf(split.identity),
        split.counterStart,
        { id: split.keysetId, unit: "sat", keys },
      );
      expect(
        outputs.map((output) => ({
          amount: output.blindedMessage.amount,
          secret: new TextDecoder().decode(output.secret),
          B_: output.blindedMessage.B_,
        })),
      ).toEqual(split.outputs);
    }
  });

  it("derives restore blank outputs (amount 0) identically", () => {
    const blanks = fixtures.restoreBlanks;
    const outputs = OutputData.createDeterministicData(
      0,
      seedOf(blanks.identity),
      blanks.counterStart,
      { id: blanks.keysetId, unit: "sat", keys: { ...fixtures.keysets.fakeMint.keys } },
      Array<number>(blanks.count).fill(0),
    );
    expect(
      outputs.map((output) => ({
        amount: output.blindedMessage.amount,
        secret: new TextDecoder().decode(output.secret),
        B_: output.blindedMessage.B_,
      })),
    ).toEqual(blanks.outputs);
  });

  it("computes the same NUT-08 blank-output counts", () => {
    for (const { feeReserve, count } of fixtures.blankOutputCounts) {
      expect(computeNumberOfBlankOutputs(feeReserve)).toBe(count);
    }
  });
});

describe("cashu golden: fake mint key material", () => {
  it("the test fake mint reproduces the fixture keyset", () => {
    const mint = new FakeMint();
    expect(mint.keysetId).toBe(fixtures.keysets.fakeMint.keysetId);
    expect(mint.pubKeys).toEqual(fixtures.keysets.fakeMint.keys);
  });
});

describe("cashu golden: token codec", () => {
  it("encodes the fixture token byte-identically (V4 and V3)", async () => {
    const args = {
      mintUrl: fixtures.token.decoded.mint,
      unit: fixtures.token.decoded.unit,
      memo: fixtures.token.decoded.memo,
      proofs: fixtures.token.decoded.proofs,
    };
    expect(await Effect.runPromise(encodeCashuToken(args))).toBe(fixtures.token.encodedV4);
    expect(await Effect.runPromise(encodeCashuToken(args, { version: 3 }))).toBe(
      fixtures.token.encodedV3,
    );
  });

  it("parses both encodings back to the pinned metadata", async () => {
    for (const encoded of [fixtures.token.encodedV4, fixtures.token.encodedV3]) {
      const parsed = await Effect.runPromise(parseCashuToken(encoded));
      expect(parsed.mintUrl).toBe(fixtures.token.metadata.mint);
      expect(parsed.unit).toBe(fixtures.token.metadata.unit);
      expect(parsed.amount).toBe(fixtures.token.metadata.amount);
      expect(Option.getOrNull(parsed.memo)).toBe(fixtures.token.metadata.memo);
      expect(parsed.proofs).toEqual(fixtures.token.decoded.proofs);
    }
  });

  it("builds the pinned share URL and deep link", async () => {
    expect(await Effect.runPromise(buildCashuShareUrl(fixtures.links.token))).toBe(
      fixtures.links.shareUrl,
    );
    expect(await Effect.runPromise(buildCashuDeepLink(fixtures.links.token))).toBe(
      fixtures.links.deepLink,
    );
  });

  it("extracts tokens from scanner/paste inputs exactly like the PoC", () => {
    expect(fixtures.tokenExtraction.length).toBeGreaterThan(10);
    for (const { input, expected } of fixtures.tokenExtraction) {
      expect(Option.getOrNull(extractCashuTokenFromText(input))).toBe(expected);
    }
  });
});

describe("cashu golden: engine end-to-end determinism", () => {
  it("receiveToken derives exactly the fixture secrets at counters 0..n-1", async () => {
    const aliceName = "alice (dev/test-identities)";
    const seed = CashuSeed.make(seedOf(aliceName));
    const mint = new FakeMint();

    // A valid incoming token: 7 sat signed by the fake mint over random-ish
    // (non-deterministic-wallet) secrets.
    const incoming = [1, 2, 4].map((amount, index) => {
      const secret = `incoming-secret-${String(index)}`;
      const priv = mint.privKeys.get(amount);
      if (priv === undefined) throw new Error("missing key");
      const C = hashToCurve(utf8ToBytes(secret)).multiply(bytesToNumber(priv)).toHex(true);
      return { id: mint.keysetId, amount, secret, C };
    });
    const incomingToken = await Effect.runPromise(
      encodeCashuToken({ mintUrl: FAKE_MINT_URL, unit: "sat", proofs: incoming }),
    );

    const result = await Effect.runPromise(
      receiveToken({ seed, token: incomingToken }).pipe(
        Effect.provide(fakeMintHttpLayer([[FAKE_MINT_URL, mint]])),
        Effect.provide(CounterStoreMemory),
      ),
    );

    expect(result.amount).toBe(7);
    // Fee 0 → outputs are the [1,2,4] split at counters 1,2,3: the engine
    // never consumes slot 0 (cashu-ts 2.9.0 treats counter 0 as "no counter"
    // in swap payloads and would emit RANDOM, restore-invisible outputs —
    // see MIN_COUNTER in internal/deterministic.ts). Secrets must equal the
    // pinned PoC derivations for the fake keyset.
    const expectedSecrets = [1, 2, 3].map((counter) => {
      const derivation = fixtures.derivations.find(
        (entry) =>
          entry.identity === aliceName &&
          entry.keysetId === fixtures.keysets.fakeMint.keysetId &&
          entry.counter === counter,
      );
      if (derivation === undefined) throw new Error("missing derivation fixture");
      return derivation.secret;
    });
    expect(result.proofs.map((proof) => proof.secret).sort()).toEqual(
      [...expectedSecrets].sort(),
    );
  });
});
