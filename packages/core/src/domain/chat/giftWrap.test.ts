/**
 * Gift wrap behavior tests (issue #22): outgoing rumor → seal → wrap
 * (deterministic under TestClock + seeded Random + fixed Randomness) and
 * the full incoming validation surface, rejection by rejection.
 *
 * Wire compatibility with the PoC is pinned separately in
 * `nip17.golden.test.ts`; these tests cover OUR wrap direction (round trip,
 * structure, jitter bounds) and spoofed/malformed input handling.
 */
import { Effect, Either, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import type { Randomness } from "../../ports/Randomness.js";
import { hexToBytes } from "../nostr/nostrTestKit.js";
import type { NostrEvent } from "../nostr/NostrEvent.js";
import { signNostrEvent, verifyNostrEvent } from "../nostr/NostrEvent.js";
import { makeChatMessageTemplate } from "./chatEvents.js";
import { alice, bob, RandomnessCounter } from "./chatTestKit.js";
import type { ChatRumor, GiftWrapRejectionReason } from "./giftWrap.js";
import {
  CHAT_MESSAGE_KIND,
  createChatGiftWraps,
  createGiftWrap,
  createRumor,
  DEFAULT_FUTURE_TOLERANCE_SEC,
  GIFT_WRAP_KIND,
  GIFT_WRAP_TIMESTAMP_JITTER_SEC,
  LINKY_PUSH_MARKER_TAG,
  SEAL_KIND,
  unwrapGiftWrap,
} from "./giftWrap.js";
import { encryptNip44, getConversationKey } from "./nip44.js";

const NOW_SEC = 1_750_000_000;
const NOW_MS = NOW_SEC * 1000;

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));

/** Provides Randomness + TestClock at NOW and runs the effect. */
const runAtNow = <A, E>(effect: Effect.Effect<A, E, Randomness>): Promise<A> =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      return yield* effect.pipe(Effect.provide(RandomnessCounter));
    }),
  );

const template = (content: string, createdAtSec = NOW_SEC - 30) =>
  makeChatMessageTemplate({
    senderPublicKeyHex: alice.publicKeyHex,
    recipientPublicKeyHex: bob.publicKeyHex,
    content,
    createdAtSec,
    clientTag: "client-1",
  });

const expectRejection = (
  result: Either.Either<unknown, { readonly reason: GiftWrapRejectionReason }>,
  reason: GiftWrapRejectionReason,
): void => {
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) expect(result.left.reason).toBe(reason);
};

describe("createChatGiftWraps", () => {
  it("produces two distinct wraps that both unwrap to the same rumor", async () => {
    const { rumor, wrapForRecipient, wrapForSender } = await runAtNow(
      createChatGiftWraps(template("hi bob"), alice, bob.publicKeyHex, {
        pushMarkerForRecipient: true,
      }),
    );

    expect(rumor.pubkey).toBe(alice.publicKeyHex);
    expect(rumor.kind).toBe(CHAT_MESSAGE_KIND);
    expect(wrapForRecipient.id).not.toBe(wrapForSender.id);

    const forBob = unwrapGiftWrap(wrapForRecipient, bob.secretKey, { nowSec: NOW_SEC });
    const forAlice = unwrapGiftWrap(wrapForSender, alice.secretKey, { nowSec: NOW_SEC });
    expect(Either.isRight(forBob)).toBe(true);
    expect(Either.isRight(forAlice)).toBe(true);
    if (Either.isRight(forBob) && Either.isRight(forAlice)) {
      expect(forBob.right.rumor).toStrictEqual(rumor);
      expect(forAlice.right.rumor).toStrictEqual(rumor);
      expect(forBob.right.senderPubkey).toBe(alice.publicKeyHex);
    }
  });

  it("wraps are valid kind-1059 events signed by fresh ephemeral keys", async () => {
    const { wrapForRecipient, wrapForSender } = await runAtNow(
      createChatGiftWraps(template("hi"), alice, bob.publicKeyHex),
    );
    for (const wrap of [wrapForRecipient, wrapForSender]) {
      expect(wrap.kind).toBe(GIFT_WRAP_KIND);
      expect(verifyNostrEvent(wrap)).toBe(true);
      expect(wrap.pubkey).not.toBe(alice.publicKeyHex);
      expect(wrap.pubkey).not.toBe(bob.publicKeyHex);
    }
    expect(wrapForRecipient.tags[0]).toStrictEqual(["p", bob.publicKeyHex]);
    expect(wrapForSender.tags[0]).toStrictEqual(["p", alice.publicKeyHex]);
  });

  it("adds the push marker to the recipient wrap only, and only on request", async () => {
    const marked = await runAtNow(
      createChatGiftWraps(template("hi"), alice, bob.publicKeyHex, {
        pushMarkerForRecipient: true,
      }),
    );
    const plain = await runAtNow(createChatGiftWraps(template("hi"), alice, bob.publicKeyHex));

    const hasMarker = (wrap: NostrEvent) =>
      wrap.tags.some(
        (tag) => tag[0] === LINKY_PUSH_MARKER_TAG[0] && tag[1] === LINKY_PUSH_MARKER_TAG[1],
      );
    expect(hasMarker(marked.wrapForRecipient)).toBe(true);
    expect(hasMarker(marked.wrapForSender)).toBe(false);
    expect(hasMarker(plain.wrapForRecipient)).toBe(false);
    expect(hasMarker(plain.wrapForSender)).toBe(false);
  });

  it("jitters seal and wrap timestamps into the past, never the future", async () => {
    const samples = await runAtNow(
      Effect.all(
        Array.from({ length: 8 }, () =>
          createChatGiftWraps(template("jitter"), alice, bob.publicKeyHex),
        ),
      ),
    );
    for (const { wrapForRecipient, wrapForSender } of samples) {
      for (const wrap of [wrapForRecipient, wrapForSender]) {
        expect(wrap.created_at).toBeLessThanOrEqual(NOW_SEC);
        expect(wrap.created_at).toBeGreaterThanOrEqual(NOW_SEC - GIFT_WRAP_TIMESTAMP_JITTER_SEC);
      }
      // The (jittered) seal inside also passes the future check at NOW.
      expect(
        Either.isRight(unwrapGiftWrap(wrapForRecipient, bob.secretKey, { nowSec: NOW_SEC })),
      ).toBe(true);
    }
  });

  it("fails with a typed error for a recipient key that is not on the curve", async () => {
    const result = await runAtNow(
      createChatGiftWraps(template("hi"), alice, "00".repeat(32)).pipe(Effect.flip),
    );
    expect(result._tag).toBe("InvalidNostrPublicKeyError");
  });
});

describe("unwrapGiftWrap rejections", () => {
  const makeWrap = (rumorTemplate = template("hello")) =>
    runAtNow(createChatGiftWraps(rumorTemplate, alice, bob.publicKeyHex));

  it("rejects a non-1059 kind", async () => {
    const { wrapForRecipient } = await makeWrap();
    const wrongKind = { ...wrapForRecipient, kind: 1058 };
    expectRejection(unwrapGiftWrap(wrongKind, bob.secretKey, { nowSec: NOW_SEC }), "wrap-wrong-kind");
  });

  it("rejects a tampered wrap signature (when not skipped)", async () => {
    const { wrapForRecipient } = await makeWrap();
    const tampered = { ...wrapForRecipient, sig: "0".repeat(128) };
    expectRejection(
      unwrapGiftWrap(tampered, bob.secretKey, { nowSec: NOW_SEC }),
      "wrap-signature-invalid",
    );
  });

  it("rejects a wrap not addressed to this key", async () => {
    const { wrapForRecipient } = await makeWrap();
    // Alice's key cannot decrypt Bob's wrap.
    expectRejection(
      unwrapGiftWrap(wrapForRecipient, alice.secretKey, { nowSec: NOW_SEC }),
      "wrap-decrypt-failed",
    );
  });

  /** Builds a wrap whose seal is produced by `makeSeal` — for spoof cases. */
  const wrapWithSeal = (sealPayload: object | string, wrapSecretKeyHex?: string) =>
    runAtNow(
      Effect.gen(function* () {
        const wrapKey =
          wrapSecretKeyHex === undefined
            ? hexToBytes("9".repeat(64).slice(0, 63) + "1") // arbitrary valid scalar
            : hexToBytes(wrapSecretKeyHex);
        const conversationKey = getConversationKey(wrapKey, bob.publicKeyHex);
        const payload =
          typeof sealPayload === "string" ? sealPayload : JSON.stringify(sealPayload);
        const content = encryptNip44(payload, conversationKey, new Uint8Array(32).fill(7));
        return yield* signNostrEvent(
          {
            kind: GIFT_WRAP_KIND,
            created_at: NOW_SEC - 60,
            tags: [["p", bob.publicKeyHex]],
            content,
          },
          wrapKey,
        );
      }),
    );

  const makeSeal = (rumor: ChatRumor, sealKind = SEAL_KIND, sealCreatedAt = NOW_SEC - 60) =>
    runAtNow(
      Effect.gen(function* () {
        const conversationKey = getConversationKey(alice.secretKey, bob.publicKeyHex);
        const content = encryptNip44(
          JSON.stringify(rumor),
          conversationKey,
          new Uint8Array(32).fill(9),
        );
        return yield* signNostrEvent(
          { kind: sealKind, created_at: sealCreatedAt, tags: [], content },
          alice.secretKey,
        );
      }),
    );

  const aliceRumor = createRumor(template("crafted"), alice.publicKeyHex);

  it("rejects garbage where the seal should be", async () => {
    const wrap = await wrapWithSeal("not json at all");
    expectRejection(unwrapGiftWrap(wrap, bob.secretKey, { nowSec: NOW_SEC }), "seal-unparseable");
  });

  it("rejects a seal with the wrong kind", async () => {
    const seal = await makeSeal(aliceRumor, 13_000);
    const wrap = await wrapWithSeal(seal);
    expectRejection(unwrapGiftWrap(wrap, bob.secretKey, { nowSec: NOW_SEC }), "seal-wrong-kind");
  });

  it("rejects a seal whose signature does not verify", async () => {
    const seal = await makeSeal(aliceRumor);
    const wrap = await wrapWithSeal({ ...seal, sig: "0".repeat(128) });
    expectRejection(
      unwrapGiftWrap(wrap, bob.secretKey, { nowSec: NOW_SEC }),
      "seal-signature-invalid",
    );
  });

  it("rejects a rumor whose id is not the canonical hash", async () => {
    const seal = await makeSeal({ ...aliceRumor, id: "f".repeat(64) });
    const wrap = await wrapWithSeal(seal);
    expectRejection(unwrapGiftWrap(wrap, bob.secretKey, { nowSec: NOW_SEC }), "rumor-id-mismatch");
  });

  it("rejects when the seal author is not the rumor author (spoofed sender)", async () => {
    // Alice seals a rumor claiming to be authored by Bob.
    const bobRumor = createRumor(
      makeChatMessageTemplate({
        senderPublicKeyHex: bob.publicKeyHex,
        recipientPublicKeyHex: alice.publicKeyHex,
        content: "i am totally bob",
        createdAtSec: NOW_SEC - 10,
      }),
      bob.publicKeyHex,
    );
    const seal = await makeSeal(bobRumor);
    const wrap = await wrapWithSeal(seal);
    expectRejection(unwrapGiftWrap(wrap, bob.secretKey, { nowSec: NOW_SEC }), "sender-mismatch");
  });

  it("rejects when the wrap is signed with the rumor author's own key", async () => {
    const seal = await makeSeal(aliceRumor);
    const wrap = await wrapWithSeal(seal, "7f3b02c9d3a8e15b64f2a90c81d6e4775ab9c0d2e3f415263748596a7b8c9d0e");
    expectRejection(unwrapGiftWrap(wrap, bob.secretKey, { nowSec: NOW_SEC }), "wrap-key-reused");
  });

  it("rejects rumors timestamped beyond the future tolerance", async () => {
    const futureRumor = createRumor(
      template("from the future", NOW_SEC + DEFAULT_FUTURE_TOLERANCE_SEC + 1),
      alice.publicKeyHex,
    );
    const seal = await makeSeal(futureRumor);
    const wrap = await wrapWithSeal(seal);
    expectRejection(unwrapGiftWrap(wrap, bob.secretKey, { nowSec: NOW_SEC }), "future-timestamp");

    // ... but tolerates clock skew inside the window.
    const skewedRumor = createRumor(
      template("slightly ahead", NOW_SEC + DEFAULT_FUTURE_TOLERANCE_SEC - 1),
      alice.publicKeyHex,
    );
    const okSeal = await makeSeal(skewedRumor);
    const okWrap = await wrapWithSeal(okSeal);
    expect(Either.isRight(unwrapGiftWrap(okWrap, bob.secretKey, { nowSec: NOW_SEC }))).toBe(true);
  });

  it("rejects seals timestamped beyond the future tolerance", async () => {
    const seal = await makeSeal(aliceRumor, SEAL_KIND, NOW_SEC + DEFAULT_FUTURE_TOLERANCE_SEC + 1);
    const wrap = await wrapWithSeal(seal);
    expectRejection(unwrapGiftWrap(wrap, bob.secretKey, { nowSec: NOW_SEC }), "future-timestamp");
  });

  it("rejects a rumor that fails schema validation", async () => {
    const malformed = { ...aliceRumor, created_at: -5 } as ChatRumor;
    const seal = await makeSeal(malformed);
    const wrap = await wrapWithSeal(seal);
    expectRejection(unwrapGiftWrap(wrap, bob.secretKey, { nowSec: NOW_SEC }), "rumor-unparseable");
  });

  it("ignores an extra sig property on the rumor (lenient like the PoC)", async () => {
    const withSig = { ...aliceRumor, sig: "ab".repeat(64) };
    const seal = await makeSeal(withSig as ChatRumor);
    const wrap = await wrapWithSeal(seal);
    const result = unwrapGiftWrap(wrap, bob.secretKey, { nowSec: NOW_SEC });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.rumor).toStrictEqual(aliceRumor);
    }
  });
});

describe("createGiftWrap (single target)", () => {
  it("a wrap to oneself unwraps with the same key", async () => {
    const rumor = createRumor(template("note to self"), alice.publicKeyHex);
    const wrap = await runAtNow(createGiftWrap(rumor, alice.secretKey, alice.publicKeyHex));
    const result = unwrapGiftWrap(wrap, alice.secretKey, { nowSec: NOW_SEC });
    expect(Either.isRight(result)).toBe(true);
  });
});
