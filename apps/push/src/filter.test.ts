import { Effect } from "effect";
import { CHAT_REACTION_KIND, signNostrEvent } from "@linky/core";
import { describe, expect, it } from "vitest";

import { classifyWrap } from "./filter.js";
import { alice, bob, makeWrap, RandomnessCounter } from "./testKit.js";

describe("classifyWrap (notifications.service-filter)", () => {
  it("delivers a recipient wrap carrying the push marker (chat message)", () => {
    const wrap = makeWrap({
      sender: alice,
      recipientPublicKeyHex: bob.publicKeyHex,
      pushMarker: true,
    });
    expect(classifyWrap(wrap)).toEqual({ _tag: "deliver", recipientPubkey: bob.publicKeyHex });
  });

  it("delivers a payment notice (marked wrap) — alert path for chat-pay.notice", () => {
    const wrap = makeWrap({
      sender: alice,
      recipientPublicKeyHex: bob.publicKeyHex,
      pushMarker: true,
      content: JSON.stringify({ type: "payment-notice" }),
    });
    expect(classifyWrap(wrap)._tag).toBe("deliver");
  });

  it("never alerts on the sender's self/sync copy (no marker)", () => {
    const wrap = makeWrap({
      sender: alice,
      recipientPublicKeyHex: bob.publicKeyHex,
      pushMarker: true,
      self: true,
    });
    // The self wrap is addressed to the sender and never carries the marker.
    expect(classifyWrap(wrap)).toEqual({ _tag: "ignore", reason: "no-push-marker" });
  });

  it("never alerts on reactions (sent without marker)", () => {
    const wrap = makeWrap({
      sender: alice,
      recipientPublicKeyHex: bob.publicKeyHex,
      pushMarker: false,
      kind: CHAT_REACTION_KIND,
      content: "❤️",
    });
    expect(classifyWrap(wrap)).toEqual({ _tag: "ignore", reason: "no-push-marker" });
  });

  it("keeps Cashu token messages quiet (sent without marker)", () => {
    const wrap = makeWrap({
      sender: alice,
      recipientPublicKeyHex: bob.publicKeyHex,
      pushMarker: false,
      content: "cashuAeyJ0b2tlbiI6W119",
    });
    expect(classifyWrap(wrap)).toEqual({ _tag: "ignore", reason: "no-push-marker" });
  });

  it("ignores normal sync traffic: edits and deletions go without marker", () => {
    const wrap = makeWrap({
      sender: alice,
      recipientPublicKeyHex: bob.publicKeyHex,
      pushMarker: false,
      kind: 5,
    });
    expect(classifyWrap(wrap)._tag).toBe("ignore");
  });

  it("ignores non-gift-wrap kinds", async () => {
    const event = await Effect.runPromise(
      signNostrEvent(
        {
          kind: 14,
          created_at: 1000,
          tags: [
            ["p", bob.publicKeyHex],
            ["linky", "push"],
          ],
          content: "x",
        },
        alice.secretKey,
      ).pipe(Effect.provide(RandomnessCounter)),
    );
    expect(classifyWrap(event)).toEqual({ _tag: "ignore", reason: "wrong-kind" });
  });

  it("rejects tampered wraps (signature no longer valid)", () => {
    const wrap = makeWrap({
      sender: alice,
      recipientPublicKeyHex: bob.publicKeyHex,
      pushMarker: true,
    });
    const tampered = { ...wrap, content: `${wrap.content}AA` };
    expect(classifyWrap(tampered)).toEqual({ _tag: "ignore", reason: "invalid-signature" });
  });

  it("rejects wraps with zero or multiple recipients", async () => {
    const make = (tags: Array<Array<string>>) =>
      Effect.runPromise(
        signNostrEvent({ kind: 1059, created_at: 1000, tags, content: "x" }, alice.secretKey).pipe(
          Effect.provide(RandomnessCounter),
        ),
      );
    const none = await make([["linky", "push"]]);
    expect(classifyWrap(none)).toEqual({ _tag: "ignore", reason: "recipient-count" });
    const two = await make([
      ["p", bob.publicKeyHex],
      ["p", alice.publicKeyHex],
      ["linky", "push"],
    ]);
    expect(classifyWrap(two)).toEqual({ _tag: "ignore", reason: "recipient-count" });
    const malformed = await make([
      ["p", "not-a-pubkey"],
      ["linky", "push"],
    ]);
    expect(classifyWrap(malformed)).toEqual({ _tag: "ignore", reason: "recipient-count" });
  });

  it("rejects empty-content wraps", async () => {
    const event = await Effect.runPromise(
      signNostrEvent(
        {
          kind: 1059,
          created_at: 1000,
          tags: [
            ["p", bob.publicKeyHex],
            ["linky", "push"],
          ],
          content: "  ",
        },
        alice.secretKey,
      ).pipe(Effect.provide(RandomnessCounter)),
    );
    expect(classifyWrap(event)).toEqual({ _tag: "ignore", reason: "empty-content" });
  });
});
