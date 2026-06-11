import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { Randomness } from "../../ports/Randomness.js";
import {
  decodeNostrEventOption,
  nostrEventId,
  signNostrEvent,
  verifyNostrEvent,
} from "./NostrEvent.js";
import {
  RandomnessFixed,
  TEST_SECRET_KEY_HEX,
  hexToBytes,
  makeSignedEvent,
} from "./nostrTestKit.js";

describe("signNostrEvent / verifyNostrEvent", () => {
  it("produces a valid event whose id matches the NIP-01 serialization", async () => {
    const event = await Effect.runPromise(makeSignedEvent({ content: "hello" }));
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(event.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(nostrEventId(event)).toBe(event.id);
    expect(verifyNostrEvent(event)).toBe(true);
  });

  it("is deterministic for fixed auxiliary randomness", async () => {
    const [first, second] = await Effect.runPromise(
      Effect.all([makeSignedEvent({ content: "same" }), makeSignedEvent({ content: "same" })]),
    );
    expect(first).toStrictEqual(second);
  });

  it("requests exactly 32 aux bytes from the Randomness port", async () => {
    const requests: Array<number> = [];
    const spyLayer = Layer.succeed(Randomness, {
      nextBytes: (byteCount) =>
        Effect.sync(() => {
          requests.push(byteCount);
          return new Uint8Array(byteCount).fill(7);
        }),
    });
    const event = await Effect.runPromise(
      signNostrEvent(
        { kind: 1, created_at: 1, tags: [], content: "x" },
        hexToBytes(TEST_SECRET_KEY_HEX),
      ).pipe(Effect.provide(spyLayer)),
    );
    expect(requests).toStrictEqual([32]);
    expect(verifyNostrEvent(event)).toBe(true);
  });

  it("rejects tampered events", async () => {
    const event = await Effect.runPromise(makeSignedEvent({ content: "original" }));
    expect(verifyNostrEvent({ ...event, content: "tampered" })).toBe(false);
    expect(verifyNostrEvent({ ...event, kind: event.kind + 1 })).toBe(false);
    expect(verifyNostrEvent({ ...event, sig: "0".repeat(128) })).toBe(false);
    expect(
      verifyNostrEvent({
        ...event,
        pubkey: "1".repeat(64),
        id: nostrEventId({ ...event, pubkey: "1".repeat(64) }),
      }),
    ).toBe(false);
    // malformed hex must return false, not throw
    expect(verifyNostrEvent({ ...event, sig: "zz" })).toBe(false);
  });
});

describe("NostrEventSchema", () => {
  it("decodes wire-shaped events and rejects malformed ones", async () => {
    const event = await Effect.runPromise(makeSignedEvent());
    expect(Option.isSome(decodeNostrEventOption({ ...event }))).toBe(true);
    expect(Option.isNone(decodeNostrEventOption({ ...event, id: event.id.toUpperCase() }))).toBe(
      true,
    );
    expect(Option.isNone(decodeNostrEventOption({ ...event, sig: "abc" }))).toBe(true);
    expect(Option.isNone(decodeNostrEventOption({ ...event, created_at: 1.5 }))).toBe(true);
    expect(Option.isNone(decodeNostrEventOption({ ...event, kind: -1 }))).toBe(true);
    expect(Option.isNone(decodeNostrEventOption({ ...event, tags: [["p", 7]] }))).toBe(true);
    expect(Option.isNone(decodeNostrEventOption("not an object"))).toBe(true);
  });
});

describe("RandomnessFixed test layer", () => {
  it("provides constant bytes (sanity)", async () => {
    const bytes = await Effect.runPromise(
      Effect.flatMap(Randomness, (r) => r.nextBytes(4)).pipe(Effect.provide(RandomnessFixed)),
    );
    expect([...bytes]).toStrictEqual([0x42, 0x42, 0x42, 0x42]);
  });
});
