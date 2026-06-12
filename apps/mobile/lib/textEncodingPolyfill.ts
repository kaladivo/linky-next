/**
 * TextDecoder / TextEncoder polyfill for Hermes.
 *
 * Hermes does not ship `TextDecoder` (and older versions lack `TextEncoder`
 * too). cashu-ts 2.9.0's CBOR token decoder (`getDecodedToken`, used by
 * `@linky/core`'s `parseCashuToken`) calls `new TextDecoder()` — without
 * this polyfill every token PARSE on device fails while encodes succeed,
 * which is exactly the failure mode that broke chat-payment token detection
 * (#44 verification). Pure-JS UTF-8 implementation, no new dependencies;
 * installed with `??=` so environments that have the natives keep them.
 *
 * Import this module from the app entry (_layout.tsx) BEFORE anything that
 * may parse a Cashu token.
 */

type BufferLike = ArrayBufferView | ArrayBuffer | null | undefined;

const toBytes = (input: BufferLike): Uint8Array => {
  if (input === null || input === undefined) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(input);
};

/** Minimal spec-shaped UTF-8 TextDecoder (fatal=false replacement mode). */
export class TextDecoderPolyfill {
  readonly encoding = "utf-8";
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;

  constructor(label = "utf-8", options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    const normalized = String(label).trim().toLowerCase();
    if (normalized !== "utf-8" && normalized !== "utf8" && normalized !== "unicode-1-1-utf-8") {
      throw new RangeError(`TextDecoder polyfill supports utf-8 only, got: ${label}`);
    }
    this.fatal = options.fatal === true;
    this.ignoreBOM = options.ignoreBOM === true;
  }

  decode(input?: BufferLike): string {
    const bytes = toBytes(input);
    let start = 0;
    if (!this.ignoreBOM && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      start = 3;
    }

    let out = "";
    let i = start;
    while (i < bytes.length) {
      const byte1 = bytes[i]!;
      let codePoint: number;
      let extra: number;

      if (byte1 < 0x80) {
        codePoint = byte1;
        extra = 0;
      } else if ((byte1 & 0xe0) === 0xc0) {
        codePoint = byte1 & 0x1f;
        extra = 1;
      } else if ((byte1 & 0xf0) === 0xe0) {
        codePoint = byte1 & 0x0f;
        extra = 2;
      } else if ((byte1 & 0xf8) === 0xf0) {
        codePoint = byte1 & 0x07;
        extra = 3;
      } else {
        if (this.fatal) throw new TypeError("invalid UTF-8");
        out += "�";
        i += 1;
        continue;
      }

      if (i + extra > bytes.length - 1) {
        if (this.fatal) throw new TypeError("invalid UTF-8 (truncated)");
        out += "�";
        break;
      }

      let valid = true;
      for (let k = 1; k <= extra; k += 1) {
        const next = bytes[i + k];
        if (next === undefined || (next & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        codePoint = (codePoint << 6) | (next & 0x3f);
      }

      if (
        !valid ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        // overlong encodings
        (extra === 1 && codePoint < 0x80) ||
        (extra === 2 && codePoint < 0x800) ||
        (extra === 3 && codePoint < 0x10000)
      ) {
        if (this.fatal) throw new TypeError("invalid UTF-8");
        out += "�";
        i += 1;
        continue;
      }

      out += String.fromCodePoint(codePoint);
      i += extra + 1;
    }
    return out;
  }
}

/** Minimal spec-shaped UTF-8 TextEncoder. */
export class TextEncoderPolyfill {
  readonly encoding = "utf-8";

  encode(input = ""): Uint8Array {
    const text = String(input);
    const bytes: number[] = [];
    for (const char of text) {
      const codePoint = char.codePointAt(0)!;
      if (codePoint < 0x80) {
        bytes.push(codePoint);
      } else if (codePoint < 0x800) {
        bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
      } else if (codePoint < 0x10000) {
        bytes.push(
          0xe0 | (codePoint >> 12),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
      } else {
        bytes.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
      }
    }
    return Uint8Array.from(bytes);
  }
}

const globalWithCodecs = globalThis as {
  TextDecoder?: unknown;
  TextEncoder?: unknown;
};

globalWithCodecs.TextDecoder ??= TextDecoderPolyfill;
globalWithCodecs.TextEncoder ??= TextEncoderPolyfill;
