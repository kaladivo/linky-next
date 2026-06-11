/**
 * Behavior tests for the derived-identity workflows (issue #13).
 * Byte-level PoC compatibility is covered by `derivedIdentities.golden.test.ts`.
 */
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";

import { OwnerLaneIndex, SyncDomain } from "./DerivedIdentities.js";
import { deriveCashuWallet } from "./deriveCashuWallet.js";
import { deriveNostrIdentity } from "./deriveNostrIdentity.js";
import { deriveOwnerLane } from "./deriveOwnerLane.js";
import { MasterSecret } from "./MasterIdentity.js";

const secretA = MasterSecret.make(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
const secretB = MasterSecret.make(Uint8Array.from({ length: 16 }, () => 0xab));

const ALL_DOMAINS = SyncDomain.literals;
const ROTATING = ["contacts", "wallet", "messages", "transactions"] as const;

describe("deriveNostrIdentity", () => {
  it("is deterministic", async () => {
    const a = await Effect.runPromise(deriveNostrIdentity(secretA));
    const b = await Effect.runPromise(deriveNostrIdentity(secretA));
    expect(a.secretKey).toEqual(b.secretKey);
    expect(a.npub).toBe(b.npub);
  });

  it("produces a well-formed keypair and encodings", async () => {
    const identity = await Effect.runPromise(deriveNostrIdentity(secretA));
    expect(identity.secretKey).toHaveLength(32);
    expect(identity.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.nsec).toMatch(/^nsec1/);
    expect(identity.npub).toMatch(/^npub1/);
  });

  it("differs across master secrets", async () => {
    const a = await Effect.runPromise(deriveNostrIdentity(secretA));
    const b = await Effect.runPromise(deriveNostrIdentity(secretB));
    expect(a.npub).not.toBe(b.npub);
    expect(a.secretKey).not.toEqual(b.secretKey);
  });
});

describe("deriveCashuWallet", () => {
  it("is deterministic and well-formed", async () => {
    const a = await Effect.runPromise(deriveCashuWallet(secretA));
    const b = await Effect.runPromise(deriveCashuWallet(secretA));
    expect(a.mnemonic).toBe(b.mnemonic);
    expect(a.seed).toEqual(b.seed);
    expect(a.mnemonic.split(" ")).toHaveLength(24);
    expect(a.seed).toHaveLength(64);
  });

  it("differs across master secrets", async () => {
    const a = await Effect.runPromise(deriveCashuWallet(secretA));
    const b = await Effect.runPromise(deriveCashuWallet(secretB));
    expect(a.mnemonic).not.toBe(b.mnemonic);
    expect(a.seed).not.toEqual(b.seed);
  });
});

describe("deriveOwnerLane", () => {
  const lane = (domain: SyncDomain, index = 0) =>
    Effect.runPromise(deriveOwnerLane(secretA, domain, OwnerLaneIndex.make(index)));

  it("derives a 12-word mnemonic for every sync domain, defaulting to index 0", async () => {
    for (const domain of ALL_DOMAINS) {
      const derived = await Effect.runPromise(deriveOwnerLane(secretA, domain));
      expect(derived.domain).toBe(domain);
      expect(derived.index).toBe(0);
      expect(derived.mnemonic.split(" ")).toHaveLength(12);
    }
  });

  it("is deterministic per (domain, index)", async () => {
    for (const domain of ROTATING) {
      expect((await lane(domain, 3)).mnemonic).toBe((await lane(domain, 3)).mnemonic);
    }
  });

  it("derives distinct lanes across rotating domains and meta", async () => {
    const mnemonics = await Promise.all(
      (["meta", ...ROTATING] as const).map(async (domain) => (await lane(domain)).mnemonic),
    );
    expect(new Set(mnemonics).size).toBe(mnemonics.length);
  });

  it("derives distinct lanes across indices of the same domain", async () => {
    for (const domain of ROTATING) {
      expect((await lane(domain, 0)).mnemonic).not.toBe((await lane(domain, 1)).mnemonic);
    }
  });

  it("replicates the PoC quirk: identity lane equals messages lane 0", async () => {
    expect((await lane("identity")).mnemonic).toBe((await lane("messages", 0)).mnemonic);
    expect((await lane("identity")).mnemonic).not.toBe((await lane("messages", 1)).mnemonic);
  });

  it("differs across master secrets", async () => {
    const a = await Effect.runPromise(deriveOwnerLane(secretA, "contacts"));
    const b = await Effect.runPromise(deriveOwnerLane(secretB, "contacts"));
    expect(a.mnemonic).not.toBe(b.mnemonic);
  });

  it("dies (defect, not typed error) on a non-zero index for fixed lanes", async () => {
    for (const domain of ["meta", "identity"] as const) {
      const exit = await Effect.runPromiseExit(
        deriveOwnerLane(secretA, domain, OwnerLaneIndex.make(1)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.isSome(Cause.dieOption(exit.cause))).toBe(true);
      }
    }
  });
});
