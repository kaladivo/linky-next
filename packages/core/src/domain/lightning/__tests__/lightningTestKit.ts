/**
 * Test kit for the lightning domain (test-only, excluded from the build):
 *
 * - synthetic BOLT11 builder (bech32 words: timestamp + tagged fields + fake
 *   signature), matching the structure the parser — and the PoC — decode;
 * - bech32 `lnurl1…` encoder;
 * - an HttpClient Layer routing LNURL endpoints to scripted JSON handlers,
 *   with optional fall-through to a FakeMint (full melt/top-up flows without
 *   any network).
 */
import { bech32 } from "@scure/base";
import { Effect, Layer } from "effect";

import { HttpClient, HttpClientResponse } from "../../../ports/index.js";
import type { CounterStore } from "../../../ports/CounterStore.js";
import { CounterStoreMemory } from "../../../ports/CounterStore.js";
import type { FakeMint } from "../../cashu/__tests__/fakeMint.js";
import { FAKE_MINT_URL } from "../../cashu/__tests__/fakeMint.js";

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

const numToWords = (value: number, length: number): number[] => {
  const words: number[] = [];
  let rest = value;
  for (let i = 0; i < length; i += 1) {
    words.unshift(rest % 32);
    rest = Math.floor(rest / 32);
  }
  return words;
};

const taggedField = (tagChar: string, data: number[]): number[] => [
  CHARSET.indexOf(tagChar),
  ...numToWords(data.length, 2),
  ...data,
];

export const utf8Words = (text: string): number[] => [
  ...bech32.toWords(new TextEncoder().encode(text)),
];

export const hexWords = (hex: string): number[] => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return [...bech32.toWords(bytes)];
};

/** Expiry words must carry the exact value (minimal big-endian base32). */
export const expiryWords = (seconds: number): number[] => {
  const words: number[] = [];
  let rest = seconds;
  while (rest > 0) {
    words.unshift(rest % 32);
    rest = Math.floor(rest / 32);
  }
  return words.length === 0 ? [0] : words;
};

export interface SyntheticInvoiceArgs {
  /** Full HRP including amount, e.g. "lnbc320n". */
  readonly hrp: string;
  readonly timestampSec: number;
  /** Tagged fields in order: [tagChar, dataWords]. */
  readonly tags?: ReadonlyArray<readonly [string, number[]]>;
}

/** Structurally valid bolt11 (signature is 104 zero words — not verified). */
export const buildInvoice = (args: SyntheticInvoiceArgs): string => {
  const words = [
    ...numToWords(args.timestampSec, 7),
    ...(args.tags ?? []).flatMap(([tag, data]) => taggedField(tag, data)),
    ...Array.from({ length: 104 }, () => 0),
  ];
  return bech32.encode(args.hrp, words, 5000);
};

export const encodeLnurl = (url: string): string =>
  bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 2000);

// ---------------------------------------------------------------------------
// HttpClient stub
// ---------------------------------------------------------------------------

export interface StubResponse {
  readonly status: number;
  readonly body: unknown;
}

export type LnurlRoute = readonly [
  urlPrefix: string,
  handler: (url: URL) => StubResponse,
];

export interface LightningHttpStub {
  readonly layer: Layer.Layer<HttpClient.HttpClient | CounterStore>;
  /** Every URL the workflows requested, in order (LNURL + mint). */
  readonly seenUrls: string[];
}

/**
 * HttpClient + fresh in-memory CounterStore. LNURL routes are matched by URL
 * prefix (first match wins); anything at `FAKE_MINT_URL` goes to `mint`.
 */
export const lightningHttpStub = (
  routes: ReadonlyArray<LnurlRoute>,
  mint?: FakeMint,
): LightningHttpStub => {
  const seenUrls: string[] = [];

  const bodyJsonOf = (request: { readonly body: unknown }): unknown => {
    const body = request.body as { _tag?: string; body?: unknown };
    if (body?._tag === "Uint8Array" && body.body instanceof Uint8Array) {
      try {
        return JSON.parse(new TextDecoder().decode(body.body));
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        seenUrls.push(request.url);
        const respond = (stub: StubResponse) =>
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(stub.body), {
              status: stub.status,
              headers: { "content-type": "application/json" },
            }),
          );

        for (const [prefix, handler] of routes) {
          if (request.url.startsWith(prefix)) {
            return respond(handler(new URL(request.url)));
          }
        }

        if (mint !== undefined) {
          const base = FAKE_MINT_URL.replace(/\/+$/, "");
          if (request.url === base || request.url.startsWith(`${base}/`)) {
            const path = request.url.slice(base.length) || "/";
            return respond(mint.handle(request.method, path, bodyJsonOf(request)));
          }
        }

        return respond({ status: 404, body: { error: `no stub for ${request.url}` } });
      }),
    ),
  );

  return { layer: Layer.merge(httpLayer, CounterStoreMemory), seenUrls };
};

export const ok = (body: unknown): StubResponse => ({ status: 200, body });
