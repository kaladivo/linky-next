/**
 * Chat inbox workflow tests (issue #22): RelayPool + fake relay network +
 * TestClock, fully deterministic. Covers unwrap/validate/dedupe/emit, the
 * cross-restart seeding contract for #25, spoof rejection diagnostics, and
 * the custom-key switch filter (#20).
 */
import { Effect, Fiber, Layer, Ref, Stream, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import type { ActiveNostrIdentity } from "../identity/customNostrKey.js";
import type { FakeRelayNetwork } from "../nostr/fakeRelay.js";
import { makeFakeRelayNetwork } from "../nostr/fakeRelay.js";
import type { NostrEvent } from "../nostr/NostrEvent.js";
import { signNostrEvent } from "../nostr/NostrEvent.js";
import { layerRelayPool } from "../nostr/RelayPool.js";
import { awaitCondition, testEnvironmentLayer } from "../nostr/nostrTestKit.js";
import { makeChatMessageTemplate, makeChatReactionTemplate } from "./chatEvents.js";
import { alice, bob, RandomnessCounter } from "./chatTestKit.js";
import type { ChatInboxOptions, ChatInboxSignal } from "./chatInbox.js";
import { chatInboxFilters, passesIdentitySwitchFilter, runChatInbox } from "./chatInbox.js";
import type { GiftWrapPair } from "./giftWrap.js";
import { createChatGiftWraps, createGiftWrap } from "./giftWrap.js";

const RELAY_A = "wss://relay-a.test";
const RELAY_B = "wss://relay-b.test";

const NOW_SEC = 1_750_000_000;
const NOW_MS = NOW_SEC * 1000;

/** Bob's inbox: identity derived from his key (custom variant per test). */
const bobDerived: ActiveNostrIdentity = { source: "derived", identity: bob };

/** Alice → Bob wraps for a simple text message. */
const aliceMessageWraps = (content: string, createdAtSec = NOW_SEC - 30): Effect.Effect<
  GiftWrapPair,
  unknown,
  never
> =>
  createChatGiftWraps(
    makeChatMessageTemplate({
      senderPublicKeyHex: alice.publicKeyHex,
      recipientPublicKeyHex: bob.publicKeyHex,
      content,
      createdAtSec,
      clientTag: `client-${content}`,
    }),
    alice,
    bob.publicKeyHex,
    { pushMarkerForRecipient: true },
  ).pipe(Effect.provide(RandomnessCounter));

interface InboxHarness {
  readonly network: FakeRelayNetwork;
  readonly signals: Effect.Effect<ReadonlyArray<ChatInboxSignal>>;
  readonly emitToBob: (event: NostrEvent, relayUrl?: string) => Effect.Effect<void>;
  readonly expectSignalCount: (count: number) => Effect.Effect<void>;
}

/** Boots a RelayPool over the fake network and runs Bob's inbox in a fiber. */
const withInbox = (
  identity: ActiveNostrIdentity,
  options: ChatInboxOptions,
  body: (harness: InboxHarness) => Effect.Effect<void, unknown>,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const network = yield* makeFakeRelayNetwork;
      const poolLayer = layerRelayPool().pipe(
        Layer.provide(network.transport),
        Layer.provide(testEnvironmentLayer([RELAY_A, RELAY_B])),
      );

      yield* Effect.gen(function* () {
        const collected = yield* Ref.make<ReadonlyArray<ChatInboxSignal>>([]);
        const inboxFiber = yield* Effect.fork(
          Stream.runForEach(runChatInbox(identity, options), (signal) =>
            Ref.update(collected, (signals) => [...signals, signal]),
          ),
        );
        // Let the pool connect and issue the inbox REQ on both relays.
        yield* awaitCondition(
          Effect.gen(function* () {
            const relayA = yield* network.relay(RELAY_A);
            const relayB = yield* network.relay(RELAY_B);
            return (yield* relayA.connectionCount) === 1 && (yield* relayB.connectionCount) === 1;
          }),
          "relays connected",
        );

        const harness: InboxHarness = {
          network,
          signals: Ref.get(collected),
          emitToBob: (event, relayUrl = RELAY_A) =>
            Effect.flatMap(network.relay(relayUrl), (relay) => relay.emitEvent(event)),
          expectSignalCount: (count) =>
            awaitCondition(
              Effect.map(Ref.get(collected), (signals) => signals.length === count),
              `signal count ${count}`,
            ),
        };
        yield* body(harness);
        yield* Fiber.interrupt(inboxFiber);
      }).pipe(Effect.provide(poolLayer));
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

describe("runChatInbox", () => {
  it("subscribes with the kind-1059 #p filter for the active identity", () => {
    expect(chatInboxFilters(bob.publicKeyHex)).toStrictEqual([
      { kinds: [1059], "#p": [bob.publicKeyHex] },
    ]);
  });

  it("unwraps an incoming wrap into a ChatEventReceived signal", async () => {
    const { rumor, wrapForRecipient } = await Effect.runPromise(
      aliceMessageWraps("hi bob").pipe(Effect.orDie, Effect.provide(TestContext.TestContext)),
    );
    await withInbox(bobDerived, {}, (harness) =>
      Effect.gen(function* () {
        yield* harness.emitToBob(wrapForRecipient);
        yield* harness.expectSignalCount(1);
        const signals = yield* harness.signals;
        expect(signals[0]).toMatchObject({
          _tag: "ChatEventReceived",
          wrapId: wrapForRecipient.id,
          event: {
            _tag: "ChatMessage",
            rumorId: rumor.id,
            senderPubkey: alice.publicKeyHex,
            content: "hi bob",
            clientTag: "client-hi bob",
          },
        });
      }),
    );
  });

  it("dedupes transport copies and reports same-rumor re-wraps once", async () => {
    const { rumor, wrapForRecipient } = await Effect.runPromise(
      aliceMessageWraps("dedupe me").pipe(Effect.orDie, Effect.provide(TestContext.TestContext)),
    );
    // A second, different wrap of the SAME rumor (another sync path).
    const secondWrap = await Effect.runPromise(
      createGiftWrap(rumor, alice.secretKey, bob.publicKeyHex)
        .pipe(Effect.provide(RandomnessCounter), Effect.orDie, Effect.provide(TestContext.TestContext)),
    );
    expect(secondWrap.id).not.toBe(wrapForRecipient.id);

    await withInbox(bobDerived, {}, (harness) =>
      Effect.gen(function* () {
        // Same wrap via both relays: one signal (pool + engine dedupe).
        yield* harness.emitToBob(wrapForRecipient, RELAY_A);
        yield* harness.emitToBob(wrapForRecipient, RELAY_B);
        yield* harness.expectSignalCount(1);

        // A different wrap of the same rumor: duplicate marker for storage.
        yield* harness.emitToBob(secondWrap, RELAY_B);
        yield* harness.expectSignalCount(2);

        const signals = yield* harness.signals;
        expect(signals[0]?._tag).toBe("ChatEventReceived");
        expect(signals[1]).toStrictEqual({
          _tag: "ChatRumorDuplicate",
          rumorId: rumor.id,
          wrapId: secondWrap.id,
        });
      }),
    );
  });

  it("skips known wraps and marks known rumors as duplicates (restart seeding)", async () => {
    const first = await Effect.runPromise(
      aliceMessageWraps("already stored").pipe(Effect.orDie, Effect.provide(TestContext.TestContext)),
    );
    const rewrap = await Effect.runPromise(
      createGiftWrap(first.rumor, alice.secretKey, bob.publicKeyHex)
        .pipe(Effect.provide(RandomnessCounter), Effect.orDie, Effect.provide(TestContext.TestContext)),
    );
    const fresh = await Effect.runPromise(
      aliceMessageWraps("brand new").pipe(Effect.orDie, Effect.provide(TestContext.TestContext)),
    );

    await withInbox(
      bobDerived,
      {
        knownWrapIds: [first.wrapForRecipient.id],
        knownRumorIds: [first.rumor.id],
      },
      (harness) =>
        Effect.gen(function* () {
          // Known wrap: nothing at all.
          yield* harness.emitToBob(first.wrapForRecipient);
          // Known rumor in a new wrap: duplicate marker.
          yield* harness.emitToBob(rewrap);
          // Unknown: full event.
          yield* harness.emitToBob(fresh.wrapForRecipient);
          yield* harness.expectSignalCount(2);

          const signals = yield* harness.signals;
          expect(signals.map((signal) => signal._tag)).toStrictEqual([
            "ChatRumorDuplicate",
            "ChatEventReceived",
          ]);
        }),
    );
  });

  it("emits typed rejections for spoofed wraps instead of events", async () => {
    // Mallory seals a rumor that claims to be authored by Alice.
    const mallorySecret = new Uint8Array(32).fill(0x2f);
    const forgedRumorTemplate = makeChatMessageTemplate({
      senderPublicKeyHex: alice.publicKeyHex,
      recipientPublicKeyHex: bob.publicKeyHex,
      content: "trust me, i am alice",
      createdAtSec: NOW_SEC - 5,
    });
    const forged = await Effect.runPromise(
      createChatGiftWraps(
        forgedRumorTemplate,
        // Wrong sender secret: the seal will be Mallory's, the rumor Alice's.
        { secretKey: mallorySecret, publicKeyHex: alice.publicKeyHex },
        bob.publicKeyHex,
      ).pipe(Effect.provide(RandomnessCounter), Effect.orDie, Effect.provide(TestContext.TestContext)),
    );

    await withInbox(bobDerived, {}, (harness) =>
      Effect.gen(function* () {
        yield* harness.emitToBob(forged.wrapForRecipient);
        yield* harness.expectSignalCount(1);
        const signals = yield* harness.signals;
        expect(signals[0]).toMatchObject({
          _tag: "ChatWrapRejected",
          wrapId: forged.wrapForRecipient.id,
          reason: "sender-mismatch",
        });
      }),
    );
  });

  it("rejects unsupported rumor kinds with diagnostics", async () => {
    const wrapped = await Effect.runPromise(
      createChatGiftWraps(
        { kind: 1, created_at: NOW_SEC - 5, tags: [], content: "public note" },
        alice,
        bob.publicKeyHex,
      ).pipe(Effect.provide(RandomnessCounter), Effect.orDie, Effect.provide(TestContext.TestContext)),
    );
    await withInbox(bobDerived, {}, (harness) =>
      Effect.gen(function* () {
        yield* harness.emitToBob(wrapped.wrapForRecipient);
        yield* harness.expectSignalCount(1);
        const signals = yield* harness.signals;
        expect(signals[0]).toMatchObject({
          _tag: "ChatWrapRejected",
          rumorId: wrapped.rumor.id,
          reason: "unsupported-kind",
        });
      }),
    );
  });

  it("delivers reactions as ChatReaction events", async () => {
    const targetId = "12".repeat(32);
    const wrapped = await Effect.runPromise(
      createChatGiftWraps(
        makeChatReactionTemplate({
          senderPublicKeyHex: alice.publicKeyHex,
          recipientPublicKeyHex: bob.publicKeyHex,
          messageAuthorPublicKeyHex: bob.publicKeyHex,
          messageRumorId: targetId,
          emoji: "🔥",
          createdAtSec: NOW_SEC - 5,
        }),
        alice,
        bob.publicKeyHex,
      ).pipe(Effect.provide(RandomnessCounter), Effect.orDie, Effect.provide(TestContext.TestContext)),
    );
    await withInbox(bobDerived, {}, (harness) =>
      Effect.gen(function* () {
        yield* harness.emitToBob(wrapped.wrapForRecipient);
        yield* harness.expectSignalCount(1);
        const signals = yield* harness.signals;
        expect(signals[0]).toMatchObject({
          _tag: "ChatEventReceived",
          event: { _tag: "ChatReaction", emoji: "🔥", messageRumorId: targetId },
        });
      }),
    );
  });

  it("drops rumors older than a custom key's activation (and keeps newer)", async () => {
    const switchedAtSec = NOW_SEC - 1000;
    const bobCustom: ActiveNostrIdentity = {
      source: "custom",
      identity: bob,
      activatedAtSec: switchedAtSec,
    };
    const before = await Effect.runPromise(
      aliceMessageWraps("from the old identity", switchedAtSec - 1)
        .pipe(Effect.orDie, Effect.provide(TestContext.TestContext)),
    );
    const atSwitch = await Effect.runPromise(
      aliceMessageWraps("exactly at the switch", switchedAtSec)
        .pipe(Effect.orDie, Effect.provide(TestContext.TestContext)),
    );

    await withInbox(bobCustom, {}, (harness) =>
      Effect.gen(function* () {
        yield* harness.emitToBob(before.wrapForRecipient);
        yield* harness.emitToBob(atSwitch.wrapForRecipient);
        yield* harness.expectSignalCount(2);
        const signals = yield* harness.signals;
        expect(signals[0]).toMatchObject({
          _tag: "ChatWrapRejected",
          rumorId: before.rumor.id,
          reason: "before-identity-switch",
        });
        expect(signals[1]).toMatchObject({
          _tag: "ChatEventReceived",
          event: { content: "exactly at the switch" },
        });
      }),
    );
  });

  it("survives non-wrap garbage delivered on the inbox subscription", async () => {
    const ok = await Effect.runPromise(
      aliceMessageWraps("still works").pipe(Effect.orDie, Effect.provide(TestContext.TestContext)),
    );
    // A validly signed kind-1059 whose content is not NIP-44 at all.
    const garbage = await Effect.runPromise(
      signNostrEvent(
        {
          kind: 1059,
          created_at: NOW_SEC - 10,
          tags: [["p", bob.publicKeyHex]],
          content: "complete garbage",
        },
        alice.secretKey,
      ).pipe(Effect.provide(RandomnessCounter), Effect.provide(TestContext.TestContext)),
    );

    await withInbox(bobDerived, {}, (harness) =>
      Effect.gen(function* () {
        yield* harness.emitToBob(garbage);
        yield* harness.emitToBob(ok.wrapForRecipient);
        yield* harness.expectSignalCount(2);
        const signals = yield* harness.signals;
        expect(signals[0]).toMatchObject({
          _tag: "ChatWrapRejected",
          reason: "wrap-decrypt-failed",
        });
        expect(signals[1]?._tag).toBe("ChatEventReceived");
      }),
    );
  });

  it("the pool verifies wrap signatures before the engine sees them", async () => {
    const ok = await Effect.runPromise(
      aliceMessageWraps("signed").pipe(Effect.orDie, Effect.provide(TestContext.TestContext)),
    );
    const tampered = { ...ok.wrapForRecipient, content: `${ok.wrapForRecipient.content}x` };

    await withInbox(bobDerived, {}, (harness) =>
      Effect.gen(function* () {
        yield* harness.emitToBob(tampered);
        // Dropped by RelayPool signature verification: no signal at all.
        yield* harness.emitToBob(ok.wrapForRecipient);
        yield* harness.expectSignalCount(1);
        const signals = yield* harness.signals;
        expect(signals[0]).toMatchObject({
          _tag: "ChatEventReceived",
          wrapId: ok.wrapForRecipient.id,
        });
      }),
    );
  });
});

describe("passesIdentitySwitchFilter", () => {
  const custom: ActiveNostrIdentity = {
    source: "custom",
    identity: bob,
    activatedAtSec: 1_700_000_000,
  };

  it("derived identities accept everything", () => {
    expect(passesIdentitySwitchFilter(bobDerived, 0)).toBe(true);
    expect(passesIdentitySwitchFilter(bobDerived, 99)).toBe(true);
  });

  it("custom identities cut off strictly before the switch (PoC parity)", () => {
    expect(passesIdentitySwitchFilter(custom, 1_699_999_999)).toBe(false);
    expect(passesIdentitySwitchFilter(custom, 1_700_000_000)).toBe(true);
    expect(passesIdentitySwitchFilter(custom, 1_700_000_001)).toBe(true);
  });
});
