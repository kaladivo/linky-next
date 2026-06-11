/**
 * NIP-44 v2 codec edge cases (issue #22). Interop byte-equality with the
 * PoC's nostr-tools lives in `nip17.golden.test.ts`; this file covers the
 * codec's own contract: padding scheme, payload validation, MAC integrity.
 */
import { describe, expect, it } from "vitest";

import { alice, bob } from "./chatTestKit.js";
import {
  calcPaddedLen,
  decryptNip44,
  encryptNip44,
  getConversationKey,
  isDecryptableNip44Payload,
} from "./nip44.js";

const key = getConversationKey(alice.secretKey, bob.publicKeyHex);
const nonce = new Uint8Array(32).fill(1);

describe("conversation key", () => {
  it("is symmetric between the two parties", () => {
    expect(getConversationKey(bob.secretKey, alice.publicKeyHex)).toStrictEqual(key);
  });

  it("throws for an x coordinate that is not on the curve", () => {
    expect(() => getConversationKey(alice.secretKey, "00".repeat(32))).toThrow();
  });
});

describe("padding", () => {
  it("follows the NIP-44 chunk scheme", () => {
    // Reference values from the NIP-44 spec.
    expect(calcPaddedLen(1)).toBe(32);
    expect(calcPaddedLen(32)).toBe(32);
    expect(calcPaddedLen(33)).toBe(64);
    expect(calcPaddedLen(37)).toBe(64);
    expect(calcPaddedLen(45)).toBe(64);
    expect(calcPaddedLen(49)).toBe(64);
    expect(calcPaddedLen(64)).toBe(64);
    expect(calcPaddedLen(65)).toBe(96);
    expect(calcPaddedLen(100)).toBe(128);
    expect(calcPaddedLen(111)).toBe(128);
    expect(calcPaddedLen(200)).toBe(224);
    expect(calcPaddedLen(250)).toBe(256);
    expect(calcPaddedLen(320)).toBe(320);
    expect(calcPaddedLen(383)).toBe(384);
    expect(calcPaddedLen(384)).toBe(384);
    expect(calcPaddedLen(400)).toBe(448);
    expect(calcPaddedLen(500)).toBe(512);
    expect(calcPaddedLen(512)).toBe(512);
    expect(calcPaddedLen(515)).toBe(640);
    expect(calcPaddedLen(700)).toBe(768);
    expect(calcPaddedLen(800)).toBe(896);
    expect(calcPaddedLen(65536)).toBe(65536);
  });
});

describe("round trips", () => {
  const cases = ["a", "32 bytes exactly: ".padEnd(32, "!"), "padding boundary".padEnd(33, "."), "🎉".repeat(50), "x".repeat(65535 - 4) + "🎉"];
  for (const plaintext of cases) {
    it(`round-trips ${plaintext.length} chars`, () => {
      expect(decryptNip44(encryptNip44(plaintext, key, nonce), key)).toBe(plaintext);
    });
  }

  it("rejects empty and oversized plaintexts", () => {
    expect(() => encryptNip44("", key, nonce)).toThrow();
    expect(() => encryptNip44("x".repeat(65536), key, nonce)).toThrow();
  });
});

describe("decrypt validation", () => {
  const payload = encryptNip44("attack at dawn", key, nonce);

  it("rejects a flipped ciphertext byte (MAC)", () => {
    const bytes = Uint8Array.from(Buffer.from(payload, "base64"));
    bytes[40] = (bytes[40]! + 1) % 256;
    const tampered = Buffer.from(bytes).toString("base64");
    expect(() => decryptNip44(tampered, key)).toThrow(/invalid MAC/);
  });

  it("rejects the wrong conversation key", () => {
    const otherKey = getConversationKey(alice.secretKey, alice.publicKeyHex);
    expect(() => decryptNip44(payload, otherKey)).toThrow();
  });

  it("rejects unknown versions and malformed payloads", () => {
    expect(() => decryptNip44(`#${payload.slice(1)}`, key)).toThrow(/unknown encryption version/);
    expect(() => decryptNip44("not base64 at all!!".repeat(10), key)).toThrow();
    expect(() => decryptNip44("AA", key)).toThrow(/invalid payload length/);
  });

  it("isDecryptableNip44Payload answers without throwing", () => {
    expect(isDecryptableNip44Payload(payload, key)).toBe(true);
    expect(isDecryptableNip44Payload("hello, just text", key)).toBe(false);
    expect(isDecryptableNip44Payload(payload.slice(0, 50), key)).toBe(false);
  });
});
