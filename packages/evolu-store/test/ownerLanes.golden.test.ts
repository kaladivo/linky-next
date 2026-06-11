/**
 * Golden tests for Evolu owner-lane derivation (issue #13).
 *
 * The fixtures in `__fixtures__/ownerLanes.golden.json` were generated FROM
 * THE POC (its identity code + @evolu/common@7.4.1, the exact version this
 * package pins) before the new implementation was written — see
 * `__fixtures__/README.md`. They prove the full chain end to end:
 *
 *   master secret --(@linky/core deriveOwnerLane)--> 12-word lane mnemonic
 *   --(appOwnerFromMnemonic: mnemonicToOwnerSecret -> createAppOwner)-->
 *   the same AppOwner id / encryption key / write key that app.linky.fit
 *   produces today, for all six sync domains (incl. the PoC's identity-lane
 *   fallthrough, identity == messages 0).
 *
 * Owner derivation lives HERE, not in core: it needs @evolu/common, which
 * core must never import (the lane mnemonic is the contract between the two
 * packages).
 */
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { SyncDomain } from "@linky/core";
import { deriveOwnerLane, MasterSecret, OwnerLaneIndex } from "@linky/core";

import { appOwnerFromMnemonic } from "../src/index";

interface LaneFixture {
  readonly name: string;
  readonly masterSecretHex: string;
  readonly domain: SyncDomain;
  readonly index: number;
  readonly mnemonic: string;
  readonly ownerId: string;
  readonly encryptionKeyHex: string;
  readonly writeKeyHex: string;
}

interface GoldenFixtures {
  readonly lanes: ReadonlyArray<LaneFixture>;
}

const fixtures = JSON.parse(
  readFileSync(new URL("./__fixtures__/ownerLanes.golden.json", import.meta.url), "utf8"),
) as GoldenFixtures;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));

describe("owner-lane golden fixtures (PoC compatibility)", () => {
  it("covers all six sync domains across multiple master secrets", () => {
    expect(fixtures.lanes.length).toBeGreaterThanOrEqual(60);
    const domains = new Set(fixtures.lanes.map((lane) => lane.domain));
    for (const domain of ["meta", "identity", "contacts", "wallet", "messages", "transactions"]) {
      expect(domains).toContain(domain);
    }
  });

  it("turns every PoC lane mnemonic into the PoC's AppOwner (id, keys)", () => {
    for (const lane of fixtures.lanes) {
      const owner = appOwnerFromMnemonic(lane.mnemonic);
      expect(owner, `${lane.name} ${lane.domain}/${lane.index}`).not.toBeNull();
      expect(owner!.id).toBe(lane.ownerId);
      expect(toHex(owner!.encryptionKey)).toBe(lane.encryptionKeyHex);
      expect(toHex(owner!.writeKey)).toBe(lane.writeKeyHex);
    }
  });

  it("derives the PoC's owner id end to end from the master secret via @linky/core", async () => {
    for (const lane of fixtures.lanes) {
      const masterSecret = MasterSecret.make(fromHex(lane.masterSecretHex));
      const derived = await Effect.runPromise(
        deriveOwnerLane(masterSecret, lane.domain, OwnerLaneIndex.make(lane.index)),
      );
      expect(derived.mnemonic).toBe(lane.mnemonic);
      const owner = appOwnerFromMnemonic(derived.mnemonic);
      expect(owner?.id, `${lane.name} ${lane.domain}/${lane.index}`).toBe(lane.ownerId);
    }
  });

  it("gives the identity lane the same owner as messages lane 0 (PoC fallthrough)", () => {
    const byKey = new Map(
      fixtures.lanes.map((lane) => [`${lane.masterSecretHex}:${lane.domain}:${lane.index}`, lane]),
    );
    const secrets = new Set(fixtures.lanes.map((lane) => lane.masterSecretHex));
    for (const secret of secrets) {
      const identity = byKey.get(`${secret}:identity:0`);
      const messages0 = byKey.get(`${secret}:messages:0`);
      expect(identity).toBeDefined();
      expect(messages0).toBeDefined();
      expect(identity!.ownerId).toBe(messages0!.ownerId);
    }
  });
});
