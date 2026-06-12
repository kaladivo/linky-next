/**
 * Profile metadata tests (issue #24) — kind-0 parsing tolerance, publish
 * shapes (PoC content key order, trimming, omission), newest-wins fetch,
 * cache hit/expiry/negative TTL, the offline → queued → flushed path. Fake
 * relay network + TestClock; fully deterministic.
 */
import { Effect, Fiber, Layer, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import type { Randomness } from "../../ports/Randomness.js";
import type { ActiveNostrIdentity } from "../identity/customNostrKey.js";
import { nostrIdentityFromNsec } from "../identity/customNostrKey.js";
import { encodeNip19Key } from "../identity/nip19.js";
import type { FakeRelayNetwork } from "./fakeRelay.js";
import { makeFakeRelayNetwork } from "./fakeRelay.js";
import { verifyNostrEvent } from "./NostrEvent.js";
import {
  NostrPendingQueue,
  layerNostrPendingQueue,
  runPendingFlushLoop,
} from "./NostrPendingQueue.js";
import type { RelayPool, RelayPoolConfig } from "./RelayPool.js";
import { layerRelayPool } from "./RelayPool.js";
import {
  PROFILE_METADATA_CACHE_KEY_PREFIX,
  PROFILE_METADATA_KIND,
  bestProfileName,
  fetchProfileMetadata,
  fetchProfilePictureUrl,
  isDisplayableProfilePictureUrl,
  ownProfileMetadataContent,
  parseProfileMetadataContent,
  profileLightningAddress,
  profilePictureUrl,
  publishProfileMetadata,
} from "./profileMetadata.js";
import {
  RandomnessFixed,
  TEST_SECRET_KEY_HEX,
  awaitCondition,
  hexToBytes,
  makeSignedEvent,
  testEnvironmentLayer,
} from "./nostrTestKit.js";

const RELAY = "wss://profile-metadata.test";

const FIXED_MS = 1_720_000_000_000;
const FIXED_SEC = 1_720_000_000;

const testConfig: Partial<RelayPoolConfig> = {
  ackTimeout: "5 seconds",
  publishMaxAttempts: 2,
  publishRetryBaseDelay: "1 second",
  reconnectBaseDelay: "1 second",
  reconnectMaxDelay: "4 seconds",
};

const derivedIdentity = (secretKeyHex: string): Effect.Effect<ActiveNostrIdentity> =>
  nostrIdentityFromNsec(encodeNip19Key("nsec", hexToBytes(secretKeyHex))).pipe(
    Effect.map((identity) => ({ source: "derived", identity }) as const),
    Effect.orDie,
  );

type HarnessServices = RelayPool | NostrPendingQueue | KeyValueStorage.KeyValueStore | Randomness;

const withHarness = (
  options: { readonly prepare?: (network: FakeRelayNetwork) => Effect.Effect<void> },
  body: (harness: {
    readonly network: FakeRelayNetwork;
  }) => Effect.Effect<void, unknown, HarnessServices>,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const network = yield* makeFakeRelayNetwork;
      if (options.prepare) yield* options.prepare(network);
      const poolLayer = layerRelayPool(testConfig).pipe(
        Layer.provide(network.transport),
        Layer.provide(testEnvironmentLayer([RELAY])),
      );
      const queueLayer = layerNostrPendingQueue.pipe(
        Layer.provideMerge(poolLayer),
        Layer.provideMerge(KeyValueStorage.layerMemory),
      );
      yield* TestClock.setTime(FIXED_MS);
      yield* body({ network }).pipe(Effect.provide([queueLayer, RandomnessFixed]));
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

/** Runs a fetch and drives the TestClock through the full query window. */
const fetchInWindow = <A, E, R>(fetch: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(fetch);
    // First step lets the pool connect + replay stored events; the second
    // ends the 8s collection window.
    yield* TestClock.adjust("1 second");
    yield* TestClock.adjust("8 seconds");
    return yield* Fiber.join(fiber);
  });

// ---------------------------------------------------------------------------
// Pure parsing (PoC parity)
// ---------------------------------------------------------------------------

describe("parseProfileMetadataContent", () => {
  it("reads the PoC fields, trims values, and falls back display_name -> displayName", () => {
    expect(
      parseProfileMetadataContent(
        JSON.stringify({
          name: "  Alice  ",
          display_name: "Alice Tester",
          lud16: " alice@linky.fit ",
          lud06: "lnurl1abc",
          picture: "https://example.com/a.png",
          image: "https://example.com/b.png",
          unrelated: 42,
        }),
      ),
    ).toStrictEqual({
      name: "Alice",
      displayName: "Alice Tester",
      lud16: "alice@linky.fit",
      lud06: "lnurl1abc",
      picture: "https://example.com/a.png",
      image: "https://example.com/b.png",
    });

    expect(parseProfileMetadataContent(JSON.stringify({ displayName: "Camel" }))).toStrictEqual({
      displayName: "Camel",
    });
  });

  it("tolerates malformed content: bad JSON, non-records, and useless fields all parse to null", () => {
    expect(parseProfileMetadataContent("{not json")).toBeNull();
    expect(parseProfileMetadataContent("42")).toBeNull();
    expect(parseProfileMetadataContent("[1,2]")).toBeNull();
    expect(parseProfileMetadataContent("null")).toBeNull();
    expect(parseProfileMetadataContent("{}")).toBeNull();
    // Non-string / empty values are dropped; nothing useful remains.
    expect(
      parseProfileMetadataContent(JSON.stringify({ name: 7, picture: "   ", lud16: null })),
    ).toBeNull();
  });
});

describe("profilePictureUrl", () => {
  it("prefers picture over image and requires a displayable URL (PoC rules)", () => {
    expect(
      profilePictureUrl({
        picture: "https://example.com/a.png",
        image: "https://example.com/b.png",
      }),
    ).toBe("https://example.com/a.png");
    expect(profilePictureUrl({ image: "https://example.com/b.png" })).toBe(
      "https://example.com/b.png",
    );
    expect(profilePictureUrl({ picture: "not a url", image: "https://example.com/b.png" })).toBe(
      "https://example.com/b.png",
    );
    expect(profilePictureUrl({ picture: "javascript:alert(1)" })).toBeNull();
    expect(profilePictureUrl(null)).toBeNull();
  });

  it("accepts base64 image data URLs and rejects other data URLs", () => {
    expect(isDisplayableProfilePictureUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isDisplayableProfilePictureUrl("data:text/html;base64,PGI+")).toBe(false);
    expect(isDisplayableProfilePictureUrl("data:image/svg+xml,<svg/>")).toBe(false);
  });

  it("bestProfileName prefers display_name over name (PoC getBestNostrName)", () => {
    expect(bestProfileName({ displayName: "Display", name: "Plain" })).toBe("Display");
    expect(bestProfileName({ name: "Plain" })).toBe("Plain");
    expect(bestProfileName({ picture: "https://example.com/a.png" })).toBeNull();
    expect(bestProfileName(null)).toBeNull();
  });

  it("profileLightningAddress prefers lud16 over lud06 (PoC refresh rule)", () => {
    expect(profileLightningAddress({ lud16: "a@b.c", lud06: "lnurl1..." })).toBe("a@b.c");
    expect(profileLightningAddress({ lud06: "lnurl1..." })).toBe("lnurl1...");
    expect(profileLightningAddress({ name: "x" })).toBeNull();
    expect(profileLightningAddress(null)).toBeNull();
  });
});

describe("ownProfileMetadataContent", () => {
  it("uses the PoC key order, trims, and omits empty fields", () => {
    expect(
      ownProfileMetadataContent({
        name: " Alice ",
        displayName: " Alice ",
        pictureUrl: " https://example.com/a.png ",
        lightningAddress: " alice@linky.fit ",
      }),
    ).toBe(
      '{"name":"Alice","display_name":"Alice","lud16":"alice@linky.fit","picture":"https://example.com/a.png","image":"https://example.com/a.png"}',
    );
    expect(
      ownProfileMetadataContent({
        name: "Bob",
        displayName: "Bob",
        pictureUrl: null,
        lightningAddress: null,
      }),
    ).toBe('{"name":"Bob","display_name":"Bob"}');
  });
});

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

describe("publishProfileMetadata", () => {
  it("publishes a signed kind 0 with the PoC shape; same-second rerun is identical", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const identity = yield* derivedIdentity(TEST_SECRET_KEY_HEX);
        const metadata = {
          name: "Alice",
          displayName: "Alice",
          pictureUrl: "https://example.com/a.png",
          lightningAddress: "alice@linky.fit",
        };
        const result = yield* publishProfileMetadata(identity, metadata);
        expect(result.outcome).toBe("accepted");

        const relay = yield* network.relay(RELAY);
        const stored = yield* relay.storedEvents;
        expect(stored).toHaveLength(1);
        const event = stored[0]!;
        expect(event.kind).toBe(PROFILE_METADATA_KIND);
        expect(event.tags).toStrictEqual([]);
        expect(event.content).toBe(
          '{"name":"Alice","display_name":"Alice","lud16":"alice@linky.fit","picture":"https://example.com/a.png","image":"https://example.com/a.png"}',
        );
        expect(event.created_at).toBe(FIXED_SEC);
        expect(event.pubkey).toBe(identity.identity.publicKeyHex);
        expect(verifyNostrEvent(event)).toBe(true);

        // Replaceable: a same-second re-publish is the very same event id.
        const rerun = yield* publishProfileMetadata(identity, metadata);
        expect(rerun.event.id).toBe(result.event.id);

        // A later save produces a strictly newer created_at (relays replace).
        yield* TestClock.adjust("90 seconds");
        const later = yield* publishProfileMetadata(identity, { ...metadata, name: "Alice2" });
        expect(later.event.created_at).toBeGreaterThan(result.event.created_at);
      }),
    );
  });

  it("offline: the event is queued, then flushed exactly once on reconnect", async () => {
    await withHarness(
      {
        prepare: (network) =>
          Effect.flatMap(network.relay(RELAY), (relay) => relay.setOnline(false)),
      },
      ({ network }) =>
        Effect.gen(function* () {
          const identity = yield* derivedIdentity(TEST_SECRET_KEY_HEX);
          const queue = yield* NostrPendingQueue;

          const publishFiber = yield* Effect.fork(
            publishProfileMetadata(identity, {
              name: "Alice",
              displayName: "Alice",
              pictureUrl: null,
              lightningAddress: null,
            }),
          );
          yield* TestClock.adjust("10 seconds");
          const result = yield* Fiber.join(publishFiber);
          expect(result.outcome).toBe("queued");
          expect((yield* queue.pending).map((event) => event.id)).toStrictEqual([result.event.id]);

          const relay = yield* network.relay(RELAY);
          expect(yield* relay.publishedEvents).toStrictEqual([]);

          const loop = yield* Effect.fork(runPendingFlushLoop);
          yield* relay.setOnline(true);
          yield* TestClock.adjust("4 seconds");
          yield* awaitCondition(
            Effect.map(relay.storedEvents, (events) => events.length === 1),
            "queued profile metadata flushed on reconnect",
          );
          expect(yield* queue.pending).toStrictEqual([]);
          expect((yield* relay.publishedEvents).length).toBe(1);
          yield* Fiber.interrupt(loop);
        }),
    );
  });
});

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

describe("fetchProfileMetadata", () => {
  it("newest kind-0 wins regardless of arrival order; fields are parsed and trimmed", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const relay = yield* network.relay(RELAY);
        const newest = yield* makeSignedEvent({
          kind: PROFILE_METADATA_KIND,
          created_at: FIXED_SEC - 50,
          content: JSON.stringify({
            name: "New",
            display_name: "New Name",
            lud16: " new@linky.fit ",
            picture: "https://example.com/new.png",
          }),
        });
        const older = yield* makeSignedEvent({
          kind: PROFILE_METADATA_KIND,
          created_at: FIXED_SEC - 100,
          content: JSON.stringify({ name: "Old" }),
        });
        // Stored newest-first so the REQ replays them out of created_at order.
        yield* relay.emitEvent(newest);
        yield* relay.emitEvent(older);

        const result = yield* fetchInWindow(fetchProfileMetadata(newest.pubkey));
        expect(Option.isSome(result)).toBe(true);
        expect(Option.getOrThrow(result)).toStrictEqual({
          name: "New",
          displayName: "New Name",
          lud16: "new@linky.fit",
          picture: "https://example.com/new.png",
        });

        const picture = yield* fetchProfilePictureUrl(newest.pubkey);
        expect(picture).toStrictEqual(Option.some("https://example.com/new.png"));
      }),
    );
  });

  it("a malformed newest event resolves to none (PoC: the newest event wins even if unparseable)", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const relay = yield* network.relay(RELAY);
        const valid = yield* makeSignedEvent({
          kind: PROFILE_METADATA_KIND,
          created_at: FIXED_SEC - 100,
          content: JSON.stringify({ name: "Valid but older" }),
        });
        const malformed = yield* makeSignedEvent({
          kind: PROFILE_METADATA_KIND,
          created_at: FIXED_SEC - 50,
          content: "{definitely not json",
        });
        yield* relay.emitEvent(valid);
        yield* relay.emitEvent(malformed);

        const result = yield* fetchInWindow(fetchProfileMetadata(valid.pubkey));
        expect(result).toStrictEqual(Option.none());
      }),
    );
  });

  it("serves the cache within the TTL and refetches after expiry", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const relay = yield* network.relay(RELAY);
        const first = yield* makeSignedEvent({
          kind: PROFILE_METADATA_KIND,
          created_at: FIXED_SEC - 100,
          content: JSON.stringify({ name: "First" }),
        });
        yield* relay.emitEvent(first);

        const initial = yield* fetchInWindow(fetchProfileMetadata(first.pubkey));
        expect(Option.getOrThrow(initial).name).toBe("First");

        // A newer event appears, but the cache is fresh — no relay round
        // trip happens (the fetch resolves without the clock advancing).
        const second = yield* makeSignedEvent({
          kind: PROFILE_METADATA_KIND,
          created_at: FIXED_SEC + 100,
          content: JSON.stringify({ name: "Second" }),
        });
        yield* relay.emitEvent(second);
        const cachedResult = yield* fetchProfileMetadata(first.pubkey);
        expect(Option.getOrThrow(cachedResult).name).toBe("First");

        // Past the positive TTL the cache expires and the newer event wins.
        yield* TestClock.adjust("13 hours");
        const refreshed = yield* fetchInWindow(fetchProfileMetadata(first.pubkey));
        expect(Option.getOrThrow(refreshed).name).toBe("Second");
      }),
    );
  });

  it("ignoreCache skips the cache read but still refreshes the cache (#27 refresh button)", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const relay = yield* network.relay(RELAY);
        const first = yield* makeSignedEvent({
          kind: PROFILE_METADATA_KIND,
          created_at: FIXED_SEC - 100,
          content: JSON.stringify({ name: "First" }),
        });
        yield* relay.emitEvent(first);

        const initial = yield* fetchInWindow(fetchProfileMetadata(first.pubkey));
        expect(Option.getOrThrow(initial).name).toBe("First");

        // A newer event appears within the positive TTL; the explicit
        // refresh bypasses the fresh cache and picks it up...
        const second = yield* makeSignedEvent({
          kind: PROFILE_METADATA_KIND,
          created_at: FIXED_SEC + 100,
          content: JSON.stringify({ name: "Second" }),
        });
        yield* relay.emitEvent(second);
        const refreshed = yield* fetchInWindow(
          fetchProfileMetadata(first.pubkey, { ignoreCache: true }),
        );
        expect(Option.getOrThrow(refreshed).name).toBe("Second");

        // ...and rewrites the cache: a normal fetch now serves "Second"
        // without a relay round trip (no clock advance needed).
        const cached = yield* fetchProfileMetadata(first.pubkey);
        expect(Option.getOrThrow(cached).name).toBe("Second");
      }),
    );
  });

  it("caches a negative result on the short TTL", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const relay = yield* network.relay(RELAY);
        const event = yield* makeSignedEvent({
          kind: PROFILE_METADATA_KIND,
          created_at: FIXED_SEC - 10,
          content: JSON.stringify({ name: "Late arrival" }),
        });

        // Nothing on the relay yet: negative result, cached.
        const miss = yield* fetchInWindow(fetchProfileMetadata(event.pubkey));
        expect(miss).toStrictEqual(Option.none());

        // The profile appears, but the negative cache is still fresh.
        yield* relay.emitEvent(event);
        const stillCached = yield* fetchProfileMetadata(event.pubkey);
        expect(stillCached).toStrictEqual(Option.none());

        // The short negative TTL expires -> the profile is found.
        yield* TestClock.adjust("3 minutes");
        const found = yield* fetchInWindow(fetchProfileMetadata(event.pubkey));
        expect(Option.getOrThrow(found).name).toBe("Late arrival");
      }),
    );
  });

  it("treats a corrupted cache entry as a miss", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const relay = yield* network.relay(RELAY);
        const event = yield* makeSignedEvent({
          kind: PROFILE_METADATA_KIND,
          created_at: FIXED_SEC - 10,
          content: JSON.stringify({ name: "Recovered" }),
        });
        yield* relay.emitEvent(event);

        const kv = yield* KeyValueStorage.KeyValueStore;
        yield* kv.set(PROFILE_METADATA_CACHE_KEY_PREFIX + event.pubkey, "not json at all");

        const result = yield* fetchInWindow(fetchProfileMetadata(event.pubkey));
        expect(Option.getOrThrow(result).name).toBe("Recovered");
      }),
    );
  });

  it("applies the since filter (custom-key pre-switch events are excluded)", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const relay = yield* network.relay(RELAY);
        const preSwitch = yield* makeSignedEvent({
          kind: PROFILE_METADATA_KIND,
          created_at: FIXED_SEC - 100,
          content: JSON.stringify({ name: "Pre switch" }),
        });
        yield* relay.emitEvent(preSwitch);

        const result = yield* fetchInWindow(
          fetchProfileMetadata(preSwitch.pubkey, { sinceSec: FIXED_SEC - 50 }),
        );
        expect(result).toStrictEqual(Option.none());
      }),
    );
  });
});
