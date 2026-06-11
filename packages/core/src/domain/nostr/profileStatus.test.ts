/**
 * NIP-38 profile status tests (issue #24) — the Linky status string codec
 * (currency-preference line, PoC parity), publish shape (kind 30315,
 * d:"general"), fetch with expiration handling, caching, and the offline
 * queue path. Fake relay network + TestClock; fully deterministic.
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
import { NostrPendingQueue, layerNostrPendingQueue } from "./NostrPendingQueue.js";
import type { RelayPool, RelayPoolConfig } from "./RelayPool.js";
import { layerRelayPool } from "./RelayPool.js";
import {
  GENERAL_STATUS_IDENTIFIER,
  PROFILE_STATUS_KIND,
  buildProfileGeneralStatus,
  fetchProfileGeneralStatus,
  normalizeStatusText,
  parseProfileGeneralStatus,
  publishProfileGeneralStatus,
} from "./profileStatus.js";
import {
  RandomnessFixed,
  TEST_SECRET_KEY_HEX,
  hexToBytes,
  makeSignedEvent,
  testEnvironmentLayer,
} from "./nostrTestKit.js";

const RELAY = "wss://profile-status.test";

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

const fetchInWindow = <A, E, R>(fetch: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(fetch);
    yield* TestClock.adjust("1 second");
    yield* TestClock.adjust("8 seconds");
    return yield* Fiber.join(fiber);
  });

/** A signed kind-30315 event with a `d` tag (default "general"). */
const statusEvent = (input: {
  readonly createdAt: number;
  readonly content: string;
  readonly identifier?: string;
  readonly expirationSec?: number;
}) =>
  makeSignedEvent({
    kind: PROFILE_STATUS_KIND,
    created_at: input.createdAt,
    tags: [
      ["d", input.identifier ?? GENERAL_STATUS_IDENTIFIER],
      ...(input.expirationSec !== undefined ? [["expiration", String(input.expirationSec)]] : []),
    ],
    content: input.content,
  });

// ---------------------------------------------------------------------------
// Status string codec (PoC parity)
// ---------------------------------------------------------------------------

describe("parseProfileGeneralStatus", () => {
  it("decodes text, a currency line, and both combined", () => {
    expect(parseProfileGeneralStatus("Just a status")).toStrictEqual({
      currencies: [],
      text: "Just a status",
    });
    expect(parseProfileGeneralStatus("BTC, CZK")).toStrictEqual({
      currencies: ["BTC", "CZK"],
      text: null,
    });
    expect(parseProfileGeneralStatus("Open for coffee\nBTC, CZK")).toStrictEqual({
      currencies: ["BTC", "CZK"],
      text: "Open for coffee",
    });
    expect(parseProfileGeneralStatus("Line one\nLine two\nUSD")).toStrictEqual({
      currencies: ["USD"],
      text: "Line one\nLine two",
    });
  });

  it("is case-insensitive for currency codes (PoC uppercases before checking)", () => {
    expect(parseProfileGeneralStatus("hello\nbtc, czk")).toStrictEqual({
      currencies: ["BTC", "CZK"],
      text: "hello",
    });
  });

  it("treats unknown codes, duplicates, and malformed lists as plain text", () => {
    expect(parseProfileGeneralStatus("BTC, EUR")).toStrictEqual({
      currencies: [],
      text: "BTC, EUR",
    });
    expect(parseProfileGeneralStatus("BTC, BTC")).toStrictEqual({
      currencies: [],
      text: "BTC, BTC",
    });
    expect(parseProfileGeneralStatus("btc and czk")).toStrictEqual({
      currencies: [],
      text: "btc and czk",
    });
  });

  it("handles empty input", () => {
    expect(parseProfileGeneralStatus(null)).toStrictEqual({ currencies: [], text: null });
    expect(parseProfileGeneralStatus("   ")).toStrictEqual({ currencies: [], text: null });
    expect(parseProfileGeneralStatus(undefined)).toStrictEqual({ currencies: [], text: null });
  });

  it("scans bottom-up: the lowest currency line wins (exact PoC behavior)", () => {
    // Currency line in the middle: lines below it are dropped (PoC quirk,
    // preserved on purpose — the encoder never produces this shape).
    expect(parseProfileGeneralStatus("text above\nBTC\ntext below")).toStrictEqual({
      currencies: ["BTC"],
      text: "text above",
    });
  });
});

describe("buildProfileGeneralStatus", () => {
  it("encodes text + currencies in canonical order and round-trips through parse", () => {
    const built = buildProfileGeneralStatus({
      // Out of canonical order on purpose.
      currencies: ["CZK", "BTC"],
      text: "  Open for coffee  ",
    });
    expect(built).toBe("Open for coffee\nBTC, CZK");
    expect(parseProfileGeneralStatus(built)).toStrictEqual({
      currencies: ["BTC", "CZK"],
      text: "Open for coffee",
    });

    expect(buildProfileGeneralStatus({ currencies: ["USD"], text: null })).toBe("USD");
    expect(buildProfileGeneralStatus({ currencies: [], text: "Hi" })).toBe("Hi");
    expect(buildProfileGeneralStatus({ currencies: [], text: "  " })).toBeNull();
  });
});

describe("normalizeStatusText", () => {
  it("trims and maps empty/non-strings to null", () => {
    expect(normalizeStatusText("  hey  ")).toBe("hey");
    expect(normalizeStatusText("")).toBeNull();
    expect(normalizeStatusText("   ")).toBeNull();
    expect(normalizeStatusText(42)).toBeNull();
    expect(normalizeStatusText(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

describe("publishProfileGeneralStatus", () => {
  it("publishes kind 30315 with the d:general tag; null clears with empty content", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const identity = yield* derivedIdentity(TEST_SECRET_KEY_HEX);
        const status = buildProfileGeneralStatus({
          currencies: ["BTC", "CZK"],
          text: "Open for coffee",
        });
        const result = yield* publishProfileGeneralStatus(identity, status);
        expect(result.outcome).toBe("accepted");
        expect(result.event.kind).toBe(PROFILE_STATUS_KIND);
        expect(result.event.tags).toStrictEqual([["d", GENERAL_STATUS_IDENTIFIER]]);
        expect(result.event.content).toBe("Open for coffee\nBTC, CZK");
        expect(result.event.created_at).toBe(FIXED_SEC);
        expect(verifyNostrEvent(result.event)).toBe(true);

        const cleared = yield* publishProfileGeneralStatus(identity, null);
        expect(cleared.event.content).toBe("");
        expect(cleared.event.tags).toStrictEqual([["d", GENERAL_STATUS_IDENTIFIER]]);

        const relay = yield* network.relay(RELAY);
        expect((yield* relay.storedEvents).map((event) => event.id)).toStrictEqual([
          result.event.id,
          cleared.event.id,
        ]);
      }),
    );
  });

  it("offline: the status is queued for the next flush", async () => {
    await withHarness(
      {
        prepare: (network) =>
          Effect.flatMap(network.relay(RELAY), (relay) => relay.setOnline(false)),
      },
      () =>
        Effect.gen(function* () {
          const identity = yield* derivedIdentity(TEST_SECRET_KEY_HEX);
          const queue = yield* NostrPendingQueue;
          const publishFiber = yield* Effect.fork(publishProfileGeneralStatus(identity, "BTC"));
          yield* TestClock.adjust("10 seconds");
          const result = yield* Fiber.join(publishFiber);
          expect(result.outcome).toBe("queued");
          expect((yield* queue.pending).map((event) => event.id)).toStrictEqual([result.event.id]);
        }),
    );
  });
});

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

describe("fetchProfileGeneralStatus", () => {
  it("returns the newest d:general status and ignores other identifiers", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const relay = yield* network.relay(RELAY);
        const older = yield* statusEvent({
          createdAt: FIXED_SEC - 100,
          content: "Older status",
        });
        const newest = yield* statusEvent({
          createdAt: FIXED_SEC - 50,
          content: "Open for coffee\nBTC, CZK",
        });
        // A newer non-general status must not shadow the general one.
        const music = yield* statusEvent({
          createdAt: FIXED_SEC - 10,
          content: "Now playing: chiptunes",
          identifier: "music",
        });
        yield* relay.emitEvent(newest);
        yield* relay.emitEvent(older);
        yield* relay.emitEvent(music);

        const result = yield* fetchInWindow(fetchProfileGeneralStatus(newest.pubkey));
        expect(result).toStrictEqual(Option.some("Open for coffee\nBTC, CZK"));
        expect(parseProfileGeneralStatus(Option.getOrThrow(result))).toStrictEqual({
          currencies: ["BTC", "CZK"],
          text: "Open for coffee",
        });
      }),
    );
  });

  it("skips expired statuses (NIP-40 expiration tag) and falls back to older ones", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const relay = yield* network.relay(RELAY);
        const evergreen = yield* statusEvent({
          createdAt: FIXED_SEC - 100,
          content: "Still valid",
          expirationSec: FIXED_SEC + 3600,
        });
        const expired = yield* statusEvent({
          createdAt: FIXED_SEC - 50,
          content: "Expired flash status",
          expirationSec: FIXED_SEC - 1,
        });
        yield* relay.emitEvent(evergreen);
        yield* relay.emitEvent(expired);

        const result = yield* fetchInWindow(fetchProfileGeneralStatus(expired.pubkey));
        expect(result).toStrictEqual(Option.some("Still valid"));
      }),
    );
  });

  it("a cleared status (empty content) is absent, and the negative result is cached", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const relay = yield* network.relay(RELAY);
        const cleared = yield* statusEvent({ createdAt: FIXED_SEC - 50, content: "" });
        yield* relay.emitEvent(cleared);

        const result = yield* fetchInWindow(fetchProfileGeneralStatus(cleared.pubkey));
        expect(result).toStrictEqual(Option.none());

        // A new status appears but the negative cache is still fresh.
        const fresh = yield* statusEvent({ createdAt: FIXED_SEC + 10, content: "Back" });
        yield* relay.emitEvent(fresh);
        expect(yield* fetchProfileGeneralStatus(cleared.pubkey)).toStrictEqual(Option.none());

        // After the short negative TTL the new status is picked up.
        yield* TestClock.adjust("3 minutes");
        const refreshed = yield* fetchInWindow(fetchProfileGeneralStatus(cleared.pubkey));
        expect(refreshed).toStrictEqual(Option.some("Back"));
      }),
    );
  });
});
