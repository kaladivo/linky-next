/**
 * testKit — shared utilities for @linky/push tests ONLY. Excluded from the
 * build (`tsconfig.build.json`); tests import it directly.
 */
import type { NostrEvent } from "@linky/core";
import { buildNip98Token, createChatGiftWraps, Randomness, signNostrEvent } from "@linky/core";
import { Effect, Layer } from "effect";

import type { PushConfigData } from "./config.js";
import { layerConfig, testConfig } from "./config.js";
import type { PushMessage, PushSenderService, PushSendResult } from "./pushSender.js";
import { PushSender } from "./pushSender.js";
import { layerRateLimiter } from "./rateLimit.js";
import { layerSqliteStorage } from "./storage.js";

/** Same throwaway keys as core's chat fixtures. */
export const ALICE_SECRET_KEY_HEX =
  "7f3b02c9d3a8e15b64f2a90c81d6e4775ab9c0d2e3f415263748596a7b8c9d0e";
export const BOB_SECRET_KEY_HEX =
  "1e0d9c8b7a695847362514f3e2d1c0b95a7d86e4c2b0a1928374655647382910";

export const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));

/**
 * Deterministic but NON-repeating "CSPRNG" (counter-tagged blocks) so
 * consecutive ephemeral wrap keys / NIP-44 nonces / BIP-340 aux differ.
 */
export const RandomnessCounter: Layer.Layer<Randomness> = Layer.sync(Randomness, () => {
  let counter = 0;
  return {
    nextBytes: (byteCount) =>
      Effect.sync(() => {
        counter += 1;
        const bytes = new Uint8Array(byteCount);
        for (let i = 0; i < byteCount; i += 1) {
          bytes[i] = (counter * 31 + i * 7 + 13) % 251;
        }
        return bytes;
      }),
  };
});

export interface TestIdentity {
  readonly secretKey: Uint8Array;
  readonly publicKeyHex: string;
}

export const identity = (secretKeyHex: string): TestIdentity => {
  const secretKey = hexToBytes(secretKeyHex);
  const publicKeyHex = Effect.runSync(
    signNostrEvent({ kind: 1, created_at: 1, tags: [], content: "" }, secretKey).pipe(
      Effect.provide(RandomnessCounter),
    ),
  ).pubkey;
  return { secretKey, publicKeyHex };
};

export const alice = identity(ALICE_SECRET_KEY_HEX);
export const bob = identity(BOB_SECRET_KEY_HEX);

/** NIP-98 Authorization header exactly as the mobile client builds it. */
export const proofHeader = (args: {
  readonly identity: TestIdentity;
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, string>;
  readonly nowSec?: number;
}): string =>
  Effect.runSync(
    buildNip98Token({
      url: args.url,
      method: args.method,
      payload: args.body,
      secretKey: args.identity.secretKey,
      nowSec: args.nowSec ?? Math.floor(Date.now() / 1000),
    }).pipe(Effect.provide(RandomnessCounter)),
  );

/** A recipient-directed wrap as the send path produces it. */
export const makeWrap = (args: {
  readonly sender: TestIdentity;
  readonly recipientPublicKeyHex: string;
  readonly pushMarker: boolean;
  readonly kind?: number;
  readonly content?: string;
  readonly self?: boolean;
}): NostrEvent => {
  const pair = Effect.runSync(
    createChatGiftWraps(
      {
        kind: args.kind ?? 14,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: args.content ?? "hello",
      },
      { secretKey: args.sender.secretKey, publicKeyHex: args.sender.publicKeyHex },
      args.recipientPublicKeyHex,
      { pushMarkerForRecipient: args.pushMarker },
    ).pipe(Effect.provide(RandomnessCounter)),
  );
  return args.self === true ? pair.wrapForSender : pair.wrapForRecipient;
};

/** Recording PushSender fake. */
export interface FakeSender {
  readonly layer: Layer.Layer<PushSender>;
  readonly sent: Array<PushMessage>;
  /** Override per-token outcomes (default everything "ok"). */
  setOutcome: (token: string, outcome: PushSendResult["outcome"]) => void;
}

export const makeFakeSender = (): FakeSender => {
  const sent: Array<PushMessage> = [];
  const outcomes = new Map<string, PushSendResult["outcome"]>();
  const service: PushSenderService = {
    send: (messages) =>
      Effect.sync(() => {
        sent.push(...messages);
        return messages.map((message) => ({
          token: message.to,
          outcome: outcomes.get(message.to) ?? ("ok" as const),
        }));
      }),
  };
  return {
    layer: Layer.succeed(PushSender, service),
    sent,
    setOutcome: (token, outcome) => {
      outcomes.set(token, outcome);
    },
  };
};

/** Config + in-memory sqlite + rate limiter layers for unit tests. */
export const baseLayers = (config: PushConfigData = testConfig()) =>
  Layer.mergeAll(layerConfig(config), layerSqliteStorage(":memory:"), layerRateLimiter);

/** Polls until `check` passes (background fibers settling on real I/O). */
export const until = async (check: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("until(): condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
