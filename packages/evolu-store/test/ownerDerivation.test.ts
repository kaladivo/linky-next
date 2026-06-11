/**
 * Pure owner-derivation tests (no SQLite, no network): the derived-identity
 * scheme from issue #13, carried over from the storage spike (issue #9).
 * Owner-id golden values are pinned here AND end-to-end against PoC fixtures
 * in `ownerLanes.golden.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  appOwnerFromEntropy,
  appOwnerFromMnemonic,
  deriveShardOwner,
  domainOwnersFromLaneMnemonics,
  shardOwnerFromEntropy,
  SYNC_DOMAINS,
} from "../src/index";

/**
 * Standard BIP-39 test vector. Dev/test only — never associated with real
 * funds or identities.
 */
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("owner derivation from external entropy (derived-identity scheme)", () => {
  it("derives the same AppOwner from the same mnemonic (deterministic)", () => {
    const a = appOwnerFromMnemonic(TEST_MNEMONIC);
    const b = appOwnerFromMnemonic(TEST_MNEMONIC);
    expect(a).not.toBeNull();
    expect(a?.id).toBe(b?.id);
    expect(a?.encryptionKey).toEqual(b?.encryptionKey);
    expect(a?.writeKey).toEqual(b?.writeKey);
  });

  it("rejects an invalid mnemonic", () => {
    expect(appOwnerFromMnemonic("definitely not a mnemonic")).toBeNull();
  });

  it("derives an AppOwner from raw 32-byte entropy", () => {
    const entropy = new Uint8Array(32).fill(7);
    const a = appOwnerFromEntropy(entropy);
    const b = appOwnerFromEntropy(new Uint8Array(32).fill(7));
    expect(a).not.toBeNull();
    expect(a?.id).toBe(b?.id);
    expect(appOwnerFromEntropy(new Uint8Array(16))).toBeNull();
  });

  it("derives distinct ShardOwner lanes from distinct entropy", () => {
    const laneA = shardOwnerFromEntropy(new Uint8Array(32).fill(1));
    const laneB = shardOwnerFromEntropy(new Uint8Array(32).fill(2));
    expect(laneA?.id).not.toBe(laneB?.id);
  });

  it("derives deterministic ShardOwner lanes from an AppOwner path", () => {
    const appOwner = appOwnerFromMnemonic(TEST_MNEMONIC);
    expect(appOwner).not.toBeNull();
    if (!appOwner) return;
    const contacts0 = deriveShardOwner(appOwner, ["contacts", 0]);
    const contacts0Again = deriveShardOwner(appOwner, ["contacts", 0]);
    const contacts1 = deriveShardOwner(appOwner, ["contacts", 1]);
    expect(contacts0.id).toBe(contacts0Again.id);
    expect(contacts0.id).not.toBe(contacts1.id);
    expect(contacts0.id).not.toBe(appOwner.id);
  });

  it("matches golden owner ids (compatibility invariant)", () => {
    // Golden values produced by @evolu/common 7.4.1 (same version as the
    // PoC). If these change, restore of existing identities breaks.
    const appOwner = appOwnerFromMnemonic(TEST_MNEMONIC);
    expect(appOwner?.id).toMatchInlineSnapshot(`"F0xh0HpiAx5shgCgtGENww"`);
    const entropyOwner = appOwnerFromEntropy(new Uint8Array(32).fill(7));
    expect(entropyOwner?.id).toMatchInlineSnapshot(`"LQwtOZjsb8gqxPd38MJrqQ"`);
  });
});

describe("domainOwnersFromLaneMnemonics", () => {
  it("derives one deterministic owner per domain", () => {
    const laneMnemonics = Object.fromEntries(
      SYNC_DOMAINS.map((domain) => [domain, TEST_MNEMONIC]),
    ) as Record<(typeof SYNC_DOMAINS)[number], string>;
    const a = domainOwnersFromLaneMnemonics(laneMnemonics);
    const b = domainOwnersFromLaneMnemonics(laneMnemonics);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    for (const domain of SYNC_DOMAINS) {
      expect(a.value[domain].id).toBe(b.value[domain].id);
    }
  });

  it("reports which domain's mnemonic is invalid", () => {
    const laneMnemonics = Object.fromEntries(
      SYNC_DOMAINS.map((domain) => [domain, TEST_MNEMONIC]),
    ) as Record<(typeof SYNC_DOMAINS)[number], string>;
    const result = domainOwnersFromLaneMnemonics({
      ...laneMnemonics,
      wallet: "not a mnemonic",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ _tag: "InvalidLaneMnemonicError", domain: "wallet" });
  });
});
