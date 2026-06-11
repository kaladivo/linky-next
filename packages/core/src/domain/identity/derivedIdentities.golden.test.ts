/**
 * Golden tests for derived-identity compatibility (issue #13).
 *
 * The fixtures in `__fixtures__/derivedIdentities.golden.json` were generated
 * FROM THE POC's own identity code and pinned dependency versions before this
 * implementation was written — see `__fixtures__/README.md`. They prove:
 *
 *   - same master secret -> same Nostr key / nsec / npub (NIP-06 path)
 *   - same master secret -> same Cashu mnemonic + 64-byte seed (BIP-85)
 *   - same master secret -> same owner-lane mnemonics for every sync domain,
 *     including the PoC's identity-lane fallthrough (identity == messages 0)
 *
 * Includes the committed dev test identities (dev/test-identities/) whose
 * npubs are recorded in their JSON files.
 */
import { readFileSync } from "node:fs";
import { Effect, Encoding } from "effect";
import { describe, expect, it } from "vitest";

import { ownerLaneDerivationPath } from "./derivationPaths.js";
import type { SyncDomain } from "./DerivedIdentities.js";
import { OwnerLaneIndex } from "./DerivedIdentities.js";
import { deriveCashuWallet } from "./deriveCashuWallet.js";
import { deriveNostrIdentity } from "./deriveNostrIdentity.js";
import { deriveOwnerLane } from "./deriveOwnerLane.js";
import { MasterSecret } from "./MasterIdentity.js";

interface LaneFixture {
  readonly domain: SyncDomain;
  readonly pocRole: string;
  readonly index: number;
  readonly entropyHex: string;
  readonly mnemonic: string;
}

interface IdentityFixture {
  readonly name: string;
  readonly masterSecretHex: string;
  readonly nostr: {
    readonly secretKeyHex: string;
    readonly publicKeyHex: string;
    readonly nsec: string;
    readonly npub: string;
  };
  readonly cashu: {
    readonly entropyHex: string;
    readonly mnemonic: string;
    readonly seedHex: string;
  };
  readonly ownerLanes: ReadonlyArray<LaneFixture>;
}

interface GoldenFixtures {
  readonly identities: ReadonlyArray<IdentityFixture>;
}

const fixtures = JSON.parse(
  readFileSync(new URL("./__fixtures__/derivedIdentities.golden.json", import.meta.url), "utf8"),
) as GoldenFixtures;

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));

const masterSecretOf = (fixture: IdentityFixture): MasterSecret =>
  MasterSecret.make(fromHex(fixture.masterSecretHex));

// Recorded in dev/test-identities/alice.json and bob.json — the derivation
// must reproduce these exact npubs.
const ALICE_NPUB = "npub1rteqaztwefwwlwyupkrx6wsmhkxa63qnkc2k38yuv9gnqsukdd7qw8qw9d";
const BOB_NPUB = "npub1swl0lmqxtuz75j6chdq9p3lntq5ruf792458fhdty7wlm4kw7ecq47mgja";

describe("derived identities golden fixtures (PoC compatibility)", () => {
  it("covers the dev test identities and at least 7 fixture secrets", () => {
    expect(fixtures.identities.length).toBeGreaterThanOrEqual(7);
    expect(fixtures.identities.some((f) => f.nostr.npub === ALICE_NPUB)).toBe(true);
    expect(fixtures.identities.some((f) => f.nostr.npub === BOB_NPUB)).toBe(true);
  });

  for (const fixture of fixtures.identities) {
    describe(fixture.name, () => {
      it("derives the PoC's Nostr identity", async () => {
        const nostr = await Effect.runPromise(deriveNostrIdentity(masterSecretOf(fixture)));
        expect(Encoding.encodeHex(nostr.secretKey)).toBe(fixture.nostr.secretKeyHex);
        expect(nostr.publicKeyHex).toBe(fixture.nostr.publicKeyHex);
        expect(nostr.nsec).toBe(fixture.nostr.nsec);
        expect(nostr.npub).toBe(fixture.nostr.npub);
      });

      it("derives the PoC's Cashu wallet mnemonic and seed", async () => {
        const wallet = await Effect.runPromise(deriveCashuWallet(masterSecretOf(fixture)));
        expect(wallet.mnemonic).toBe(fixture.cashu.mnemonic);
        expect(Encoding.encodeHex(wallet.seed)).toBe(fixture.cashu.seedHex);
      });

      it("derives the PoC's owner-lane mnemonics for all sync domains", async () => {
        for (const lane of fixture.ownerLanes) {
          const derived = await Effect.runPromise(
            deriveOwnerLane(masterSecretOf(fixture), lane.domain, OwnerLaneIndex.make(lane.index)),
          );
          expect(derived.mnemonic).toBe(lane.mnemonic);
          expect(derived.domain).toBe(lane.domain);
          expect(derived.index).toBe(lane.index);
        }
      });
    });
  }

  it("reproduces alice's recorded npub from her master secret", async () => {
    const alice = fixtures.identities.find((f) => f.nostr.npub === ALICE_NPUB)!;
    const nostr = await Effect.runPromise(deriveNostrIdentity(masterSecretOf(alice)));
    expect(nostr.npub).toBe(ALICE_NPUB);
  });

  it("reproduces bob's recorded npub from his master secret", async () => {
    const bob = fixtures.identities.find((f) => f.nostr.npub === BOB_NPUB)!;
    const nostr = await Effect.runPromise(deriveNostrIdentity(masterSecretOf(bob)));
    expect(nostr.npub).toBe(BOB_NPUB);
  });

  it("pins the lane derivation paths (incl. the identity fallthrough)", () => {
    const zero = OwnerLaneIndex.make(0);
    const one = OwnerLaneIndex.make(1);
    expect(ownerLaneDerivationPath("meta", zero)).toBe("m/83696968'/39'/0'/24'/1'/0'");
    expect(ownerLaneDerivationPath("contacts", one)).toBe("m/83696968'/39'/0'/24'/2'/1'");
    expect(ownerLaneDerivationPath("wallet", one)).toBe("m/83696968'/39'/0'/24'/3'/1'");
    expect(ownerLaneDerivationPath("messages", one)).toBe("m/83696968'/39'/0'/24'/4'/1'");
    expect(ownerLaneDerivationPath("transactions", one)).toBe("m/83696968'/39'/0'/24'/5'/1'");
    // PoC production quirk, replicated on purpose: identity == messages 0.
    expect(ownerLaneDerivationPath("identity", zero)).toBe("m/83696968'/39'/0'/24'/4'/0'");
  });
});
