/**
 * UTF-8 codec polyfill (#44): the on-device replacement for the missing
 * Hermes TextDecoder/TextEncoder, verified against Node's natives.
 */
import { describe, expect, it } from "vitest";

import { TextDecoderPolyfill, TextEncoderPolyfill } from "../lib/textEncodingPolyfill";

const SAMPLES = [
  "",
  "plain ascii",
  "https://testnut.cashu.space",
  'čeština 中文 𝄞 🎉 "quotes" \\backslash\\',
  "a".repeat(5000),
];

describe("TextEncoderPolyfill / TextDecoderPolyfill", () => {
  for (const sample of SAMPLES) {
    it(`round-trips and matches the native codecs (${sample.slice(0, 12) || "empty"}…)`, () => {
      const encoded = new TextEncoderPolyfill().encode(sample);
      expect(encoded).toEqual(new TextEncoder().encode(sample));
      expect(new TextDecoderPolyfill().decode(encoded)).toBe(sample);
      expect(new TextDecoderPolyfill().decode(new TextEncoder().encode(sample))).toBe(sample);
    });
  }

  it("decodes subarray views with byte offsets correctly", () => {
    const full = new TextEncoder().encode("xx中文yy");
    const view = full.subarray(2, full.length - 2);
    expect(new TextDecoderPolyfill().decode(view)).toBe("中文");
  });

  it("replaces invalid sequences instead of throwing (fatal=false)", () => {
    expect(new TextDecoderPolyfill().decode(Uint8Array.from([0x61, 0xff, 0x62]))).toBe("a�b");
    expect(new TextDecoderPolyfill().decode(Uint8Array.from([0xe4, 0xb8]))).toBe("�");
  });

  it("rejects non-utf8 labels", () => {
    expect(() => new TextDecoderPolyfill("utf-16")).toThrow(RangeError);
  });
});
