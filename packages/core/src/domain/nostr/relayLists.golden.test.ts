/**
 * Golden tests pinning relay-list event structure against the PoC (issue
 * #23). Fixtures in `__fixtures__/relayLists.golden.json` were generated
 * from the PoC's own nostr-tools, building the exact templates the PoC's
 * `useRelayDomain.publishNostrRelayLists` publishes — see the fixtures
 * README. They prove:
 *
 *   - kind 10002 carries `["r", url]` tags, kind 10050 `["relay", url]`
 *     tags, both with empty content (PoC shape);
 *   - given the same key, relay set, and timestamp, our
 *     `publishRelayLists` produces byte-identical events (same ids);
 *   - PoC-signed fixtures verify under our verifier.
 */
import { readFileSync } from "node:fs";
import { Effect, Layer, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import { nostrIdentityFromNsec } from "../identity/customNostrKey.js";
import { encodeNip19Key } from "../identity/nip19.js";
import { makeFakeRelayNetwork } from "./fakeRelay.js";
import type { NostrEvent } from "./NostrEvent.js";
import { decodeNostrEventOption, nostrEventId, verifyNostrEvent } from "./NostrEvent.js";
import { layerNostrPendingQueue } from "./NostrPendingQueue.js";
import { layerRelayPool } from "./RelayPool.js";
import { INBOX_RELAY_LIST_KIND, RELAY_LIST_KIND, publishRelayLists } from "./relayLists.js";
import { RandomnessFixed, hexToBytes, testEnvironmentLayer } from "./nostrTestKit.js";

interface GoldenFixtures {
  readonly generator: string;
  readonly secretKeyHex: string;
  readonly publicKeyHex: string;
  readonly createdAt: number;
  readonly relayUrls: ReadonlyArray<string>;
  readonly events: ReadonlyArray<{ readonly name: string; readonly event: NostrEvent }>;
}

const fixtures = JSON.parse(
  readFileSync(new URL("./__fixtures__/relayLists.golden.json", import.meta.url), "utf8"),
) as GoldenFixtures;

const fixtureOfKind = (kind: number): NostrEvent => {
  const found = fixtures.events.find(({ event }) => event.kind === kind);
  if (found === undefined) throw new Error(`missing fixture for kind ${kind}`);
  return found.event;
};

describe("relayLists.golden (PoC compatibility)", () => {
  for (const { name, event } of fixtures.events) {
    it(`${name}: fixture decodes, verifies, and id matches our serialization`, () => {
      expect(Option.isSome(decodeNostrEventOption(event))).toBe(true);
      expect(nostrEventId(event)).toBe(event.id);
      expect(verifyNostrEvent(event)).toBe(true);
      expect(event.content).toBe("");
    });
  }

  it("publishRelayLists reproduces the PoC's events byte-for-byte (same ids)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const network = yield* makeFakeRelayNetwork;
        const relayUrl = "wss://golden.test";
        const poolLayer = layerRelayPool().pipe(
          Layer.provide(network.transport),
          Layer.provide(testEnvironmentLayer([relayUrl])),
        );
        const queueLayer = layerNostrPendingQueue.pipe(
          Layer.provideMerge(poolLayer),
          Layer.provideMerge(KeyValueStorage.layerMemory),
        );

        yield* TestClock.setTime(fixtures.createdAt * 1000);

        const identity = yield* nostrIdentityFromNsec(
          encodeNip19Key("nsec", hexToBytes(fixtures.secretKeyHex)),
        ).pipe(Effect.orDie);
        expect(identity.publicKeyHex).toBe(fixtures.publicKeyHex);

        const result = yield* publishRelayLists(
          { source: "derived", identity },
          { relayUrls: fixtures.relayUrls },
        ).pipe(Effect.provide([queueLayer, RandomnessFixed]));

        const golden10002 = fixtureOfKind(RELAY_LIST_KIND);
        const golden10050 = fixtureOfKind(INBOX_RELAY_LIST_KIND);

        // Identical NIP-01 ids == identical pubkey/created_at/kind/tags/content.
        expect(result.relayList.event.id).toBe(golden10002.id);
        expect(result.relayList.event.tags).toStrictEqual(golden10002.tags);
        expect(result.inboxRelayList.event.id).toBe(golden10050.id);
        expect(result.inboxRelayList.event.tags).toStrictEqual(golden10050.tags);

        // Our signatures differ (different aux randomness) but must verify.
        expect(verifyNostrEvent(result.relayList.event)).toBe(true);
        expect(verifyNostrEvent(result.inboxRelayList.event)).toBe(true);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  });
});
