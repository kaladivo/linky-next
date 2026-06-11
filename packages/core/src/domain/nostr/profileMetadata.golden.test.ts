/**
 * Golden tests pinning the kind-0 profile metadata and kind-30315 status
 * event shapes against the PoC (issue #24). Fixtures in
 * `__fixtures__/profileMetadata.golden.json` were generated from the PoC's
 * own nostr-tools, building exactly the templates the PoC publishes
 * (`publishKind0ProfileMetadata` with the onboarding content record,
 * `publishNostrGeneralStatus`) — see the fixtures README. They prove:
 *
 *   - kind 0 carries no tags and the content JSON uses the PoC's key order
 *     (`name`, `display_name`, `lud16`, `picture`, `image`) with empties
 *     omitted and `picture`/`image` mirrored;
 *   - kind 30315 carries exactly `["d", "general"]` and the raw status
 *     string (empty when cleared), with the Linky currency-preference line
 *     encoded as `"<text>\n<CUR1, CUR2>"`;
 *   - given the same key, inputs, and timestamp, our publish workflows
 *     produce byte-identical events (same ids);
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
import { publishProfileMetadata } from "./profileMetadata.js";
import type { ProfileStatusCurrency } from "./profileStatus.js";
import {
  buildProfileGeneralStatus,
  parseProfileGeneralStatus,
  publishProfileGeneralStatus,
} from "./profileStatus.js";
import { RandomnessFixed, hexToBytes, testEnvironmentLayer } from "./nostrTestKit.js";

interface GoldenFixtures {
  readonly generator: string;
  readonly secretKeyHex: string;
  readonly publicKeyHex: string;
  readonly createdAt: number;
  readonly inputs: {
    readonly fullProfile: {
      readonly name: string;
      readonly lud16: string;
      readonly picture: string;
    };
    readonly minimalProfile: { readonly name: string };
    readonly statusText: string;
    readonly statusCurrencies: ReadonlyArray<ProfileStatusCurrency>;
    readonly generalStatus: string;
  };
  readonly events: ReadonlyArray<{ readonly name: string; readonly event: NostrEvent }>;
}

const fixtures = JSON.parse(
  readFileSync(new URL("./__fixtures__/profileMetadata.golden.json", import.meta.url), "utf8"),
) as GoldenFixtures;

const fixtureNamed = (name: string): NostrEvent => {
  const found = fixtures.events.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing fixture: ${name}`);
  return found.event;
};

describe("profileMetadata.golden (PoC compatibility)", () => {
  for (const { name, event } of fixtures.events) {
    it(`${name}: fixture decodes, verifies, and id matches our serialization`, () => {
      expect(Option.isSome(decodeNostrEventOption(event))).toBe(true);
      expect(nostrEventId(event)).toBe(event.id);
      expect(verifyNostrEvent(event)).toBe(true);
    });
  }

  it("the status codec reproduces the PoC's status string exactly", () => {
    expect(
      buildProfileGeneralStatus({
        currencies: fixtures.inputs.statusCurrencies,
        text: fixtures.inputs.statusText,
      }),
    ).toBe(fixtures.inputs.generalStatus);
    expect(parseProfileGeneralStatus(fixtures.inputs.generalStatus)).toStrictEqual({
      currencies: fixtures.inputs.statusCurrencies,
      text: fixtures.inputs.statusText,
    });
  });

  it("publishProfileMetadata / publishProfileGeneralStatus reproduce the PoC's events byte-for-byte (same ids)", async () => {
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
        const active = { source: "derived", identity } as const;

        yield* Effect.gen(function* () {
          const fullProfile = yield* publishProfileMetadata(active, {
            name: fixtures.inputs.fullProfile.name,
            displayName: fixtures.inputs.fullProfile.name,
            pictureUrl: fixtures.inputs.fullProfile.picture,
            lightningAddress: fixtures.inputs.fullProfile.lud16,
          });
          const goldenFull = fixtureNamed("kind 0 profile metadata (name + lud16 + picture)");
          expect(fullProfile.event.content).toBe(goldenFull.content);
          expect(fullProfile.event.id).toBe(goldenFull.id);
          expect(verifyNostrEvent(fullProfile.event)).toBe(true);

          const minimalProfile = yield* publishProfileMetadata(active, {
            name: fixtures.inputs.minimalProfile.name,
            displayName: fixtures.inputs.minimalProfile.name,
            pictureUrl: null,
            lightningAddress: null,
          });
          const goldenMinimal = fixtureNamed("kind 0 profile metadata (name only)");
          expect(minimalProfile.event.content).toBe(goldenMinimal.content);
          expect(minimalProfile.event.id).toBe(goldenMinimal.id);

          const status = yield* publishProfileGeneralStatus(
            active,
            buildProfileGeneralStatus({
              currencies: fixtures.inputs.statusCurrencies,
              text: fixtures.inputs.statusText,
            }),
          );
          const goldenStatus = fixtureNamed("kind 30315 general status (text + currencies)");
          expect(status.event.content).toBe(goldenStatus.content);
          expect(status.event.tags).toStrictEqual(goldenStatus.tags);
          expect(status.event.id).toBe(goldenStatus.id);
          expect(verifyNostrEvent(status.event)).toBe(true);

          const clearedStatus = yield* publishProfileGeneralStatus(active, null);
          const goldenCleared = fixtureNamed("kind 30315 general status (cleared)");
          expect(clearedStatus.event.content).toBe("");
          expect(clearedStatus.event.id).toBe(goldenCleared.id);
        }).pipe(Effect.provide([queueLayer, RandomnessFixed]));
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  });
});
