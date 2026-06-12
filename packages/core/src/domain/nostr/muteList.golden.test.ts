/**
 * Golden tests pinning the mute-list (kind 10000) event structure against
 * the PoC (issue #28). Fixture in `__fixtures__/muteList.golden.json` was
 * generated from the PoC's own nostr-tools, building the exact template the
 * PoC's `blockPubkeyAndPublishMuteList` publishes — see the fixtures
 * README. Proves:
 *
 *   - kind 10000 carries `["p", pubkeyHex]` tags with empty content;
 *   - given the same key, blocklist, and timestamp, our `publishMuteList`
 *     produces a byte-identical event (same id);
 *   - the PoC-signed fixture verifies under our verifier.
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
import { MUTE_LIST_KIND, mutedPubkeysOfEvent, publishMuteList } from "./muteList.js";
import { RandomnessFixed, hexToBytes, testEnvironmentLayer } from "./nostrTestKit.js";

interface GoldenFixture {
  readonly generator: string;
  readonly secretKeyHex: string;
  readonly publicKeyHex: string;
  readonly createdAt: number;
  readonly mutedPubkeys: ReadonlyArray<string>;
  readonly event: NostrEvent;
}

const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/muteList.golden.json", import.meta.url), "utf8"),
) as GoldenFixture;

describe("muteList.golden (PoC compatibility)", () => {
  it("fixture decodes, verifies, and id matches our serialization", () => {
    expect(Option.isSome(decodeNostrEventOption(fixture.event))).toBe(true);
    expect(nostrEventId(fixture.event)).toBe(fixture.event.id);
    expect(verifyNostrEvent(fixture.event)).toBe(true);
    expect(fixture.event.kind).toBe(MUTE_LIST_KIND);
    expect(fixture.event.content).toBe("");
    expect(mutedPubkeysOfEvent(fixture.event)).toStrictEqual(fixture.mutedPubkeys);
  });

  it("publishMuteList reproduces the PoC's event byte-for-byte (same id)", async () => {
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

        // The publish signs AFTER the 8s merge-fetch window elapses, so
        // start 8s early — created_at then lands exactly on the fixture's.
        yield* TestClock.setTime((fixture.createdAt - 8) * 1000);

        const identity = yield* nostrIdentityFromNsec(
          encodeNip19Key("nsec", hexToBytes(fixture.secretKeyHex)),
        ).pipe(Effect.orDie);
        expect(identity.publicKeyHex).toBe(fixture.publicKeyHex);

        // Empty relay: the merge fetch contributes nothing, so the
        // published list is exactly the PoC's local blocklist. The fetch
        // window must elapse on the TestClock for publish to proceed.
        const fiber = yield* Effect.fork(
          publishMuteList({ source: "derived", identity }, fixture.mutedPubkeys).pipe(
            Effect.provide([queueLayer, RandomnessFixed]),
          ),
        );
        yield* TestClock.adjust("8 seconds");
        const result = yield* fiber.await.pipe(Effect.flatMap((exit) => exit));

        // Identical NIP-01 ids == identical pubkey/created_at/kind/tags/content.
        expect(result.delivery.event.id).toBe(fixture.event.id);
        expect(result.delivery.event.tags).toStrictEqual(fixture.event.tags);
        expect(result.mutedPubkeys).toStrictEqual(fixture.mutedPubkeys);

        // Our signature differs (different aux randomness) but must verify.
        expect(verifyNostrEvent(result.delivery.event)).toBe(true);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  });
});
