/**
 * NIP-17/NIP-59 gift wrapping — rumor → seal → wrap (outgoing) and
 * wrap → seal → rumor with full sender validation (incoming). Issue #22.
 *
 * Wire format (interop contract, pinned by `__fixtures__/nip17.golden.json`
 * against the PoC's nostr-tools):
 *
 * - **rumor** — the real event (kind 14 message / 7 reaction / 5 deletion),
 *   UNSIGNED but carrying its NIP-01 `id`; `pubkey` is the real sender.
 * - **seal (kind 13)** — `content` = NIP-44(JSON(rumor)) under the
 *   sender↔recipient conversation key, `tags` = [], signed by the SENDER,
 *   `created_at` jittered up to two days into the past.
 * - **wrap (kind 1059)** — `content` = NIP-44(JSON(seal)) under an
 *   EPHEMERAL key↔recipient conversation key, `tags` = [["p", recipient]]
 *   (plus the Linky push marker on message wraps for the push relay),
 *   signed by the ephemeral key, `created_at` jittered likewise.
 *
 * Every send produces TWO wraps: one addressed to the recipient and one to
 * the sender themself, so the sender's other devices can sync the outgoing
 * message from the same kind-1059 inbox (the PoC does exactly this).
 *
 * Entropy and time:
 * - ephemeral wrap keys and NIP-44 nonces → `Randomness` port (secret
 *   entropy, CSPRNG only);
 * - timestamp jitter → Effect's built-in `Random` (non-secret, seedable in
 *   tests);
 * - "now" → Effect's `Clock` (TestClock in tests).
 *
 * Incoming validation returns `Either` with typed {@link GiftWrapRejection}
 * values — diagnostics, never throws, never an error channel: a hostile
 * relay feeding garbage is normal operation, not a failure of the workflow.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { Clock, Data, Effect, Either, Random, Schema } from "effect";

import type { RandomnessError } from "../../ports/Randomness.js";
import { Randomness } from "../../ports/Randomness.js";
import type { NostrEvent, NostrEventTemplate, UnsignedNostrEvent } from "../nostr/NostrEvent.js";
import {
  decodeNostrEventOption,
  nostrEventId,
  signNostrEvent,
  verifyNostrEvent,
} from "../nostr/NostrEvent.js";
import { decryptNip44, encryptNip44, getConversationKey } from "./nip44.js";

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/** NIP-17 private direct message (the chat text rumor kind). */
export const CHAT_MESSAGE_KIND = 14;
/** NIP-25 reaction, gift-wrapped like the PoC does. */
export const CHAT_REACTION_KIND = 7;
/** NIP-09 deletion, gift-wrapped like the PoC does. */
export const CHAT_DELETION_KIND = 5;
/** NIP-59 seal. */
export const SEAL_KIND = 13;
/** NIP-59 gift wrap. */
export const GIFT_WRAP_KIND = 1059;

/**
 * The PoC's wrap-level marker telling the Linky push relay that this wrap
 * should trigger a push notification (`["linky", "push"]` on the
 * recipient-directed wrap of a chat message — never on the self wrap).
 */
export const LINKY_PUSH_MARKER_TAG: readonly [string, string] = ["linky", "push"];

/** NIP-59 timestamp jitter window: up to two days into the past. */
export const GIFT_WRAP_TIMESTAMP_JITTER_SEC = 2 * 24 * 60 * 60;

/** Default tolerance for rumor/seal timestamps in the future (15 minutes). */
export const DEFAULT_FUTURE_TOLERANCE_SEC = 15 * 60;

// ---------------------------------------------------------------------------
// Rumor model
// ---------------------------------------------------------------------------

/**
 * A rumor: an unsigned NIP-01 event with its `id`. The id doubles as the
 * message identity everywhere downstream — dedupe key, reply target,
 * reaction target, edit reference.
 */
export interface ChatRumor extends UnsignedNostrEvent {
  readonly id: string;
}

const LowercaseHex64 = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{64}$/, {
    identifier: "LowercaseHex64",
    description: "64 lowercase hex characters",
  }),
);

/**
 * Wire schema for decrypted rumors. Unknown extra properties (e.g. a `sig`
 * some clients leave on the rumor) are ignored, matching the PoC's lenient
 * reads — but the canonical fields must be well-formed.
 */
export const ChatRumorSchema: Schema.Schema<ChatRumor> = Schema.Struct({
  id: LowercaseHex64,
  pubkey: LowercaseHex64,
  kind: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  created_at: Schema.Number.pipe(Schema.int(), Schema.positive()),
  tags: Schema.Array(Schema.Array(Schema.String)),
  content: Schema.String,
});

const decodeRumorOption = Schema.decodeUnknownOption(ChatRumorSchema);

/** Binds a template to the sender and computes the canonical rumor id. */
export const createRumor = (template: NostrEventTemplate, senderPublicKeyHex: string): ChatRumor => {
  const unsigned: UnsignedNostrEvent = { ...template, pubkey: senderPublicKeyHex };
  return { ...unsigned, id: nostrEventId(unsigned) };
};

// ---------------------------------------------------------------------------
// Outgoing: rumor -> seal -> wrap
// ---------------------------------------------------------------------------

/**
 * The recipient public key is not a valid secp256k1 x-only point — nothing
 * can be encrypted to it. Expected failure: contact keys come from user
 * input / the network.
 */
export class InvalidNostrPublicKeyError extends Data.TaggedError("InvalidNostrPublicKeyError")<{
  readonly publicKeyHex: string;
}> {}

/** Both wraps of one outgoing rumor (`wrapForSender` is the sync copy). */
export interface GiftWrapPair {
  readonly rumor: ChatRumor;
  readonly wrapForRecipient: NostrEvent;
  readonly wrapForSender: NostrEvent;
}

export interface CreateGiftWrapsOptions {
  /**
   * Adds the Linky push marker tag to the RECIPIENT wrap (the PoC sets it on
   * chat message sends so the push relay notifies the contact; reactions,
   * edits and deletions go without it). Default `false`.
   */
  readonly pushMarkerForRecipient?: boolean;
}

const conversationKeyEffect = (
  secretKey: Uint8Array,
  publicKeyHex: string,
): Effect.Effect<Uint8Array, InvalidNostrPublicKeyError> =>
  Effect.try({
    try: () => getConversationKey(secretKey, publicKeyHex),
    catch: () => new InvalidNostrPublicKeyError({ publicKeyHex }),
  });

/** A fresh ephemeral secp256k1 secret key from the `Randomness` port. */
const ephemeralSecretKey: Effect.Effect<Uint8Array, RandomnessError, Randomness> = Effect.gen(
  function* () {
    const randomness = yield* Randomness;
    // A uniformly random 32-byte string is an invalid scalar with
    // probability ~2^-128; the loop is theoretical but keeps this total.
    for (;;) {
      const candidate = yield* randomness.nextBytes(32);
      try {
        schnorr.getPublicKey(candidate);
        return candidate;
      } catch {
        // not a valid scalar — draw again
      }
    }
  },
);

/** `created_at` jitter per NIP-59: now minus up to two days, never future. */
const jitteredTimestampSec: Effect.Effect<number> = Effect.gen(function* () {
  const millis = yield* Clock.currentTimeMillis;
  const jitter = yield* Random.nextIntBetween(0, GIFT_WRAP_TIMESTAMP_JITTER_SEC + 1);
  return Math.round(millis / 1000) - jitter;
});

/**
 * Seals and wraps a rumor for ONE recipient. Used twice per send (recipient
 * + self); exported for tests and for future single-target uses.
 */
export const createGiftWrap = (
  rumor: ChatRumor,
  senderSecretKey: Uint8Array,
  recipientPublicKeyHex: string,
  extraWrapTags: ReadonlyArray<ReadonlyArray<string>> = [],
): Effect.Effect<NostrEvent, RandomnessError | InvalidNostrPublicKeyError, Randomness> =>
  Effect.gen(function* () {
    const randomness = yield* Randomness;

    const sealConversationKey = yield* conversationKeyEffect(
      senderSecretKey,
      recipientPublicKeyHex,
    );
    const sealNonce = yield* randomness.nextBytes(32);
    const sealCreatedAt = yield* jitteredTimestampSec;
    const seal = yield* signNostrEvent(
      {
        kind: SEAL_KIND,
        created_at: sealCreatedAt,
        tags: [],
        content: encryptNip44(JSON.stringify(rumor), sealConversationKey, sealNonce),
      },
      senderSecretKey,
    );

    const wrapSecretKey = yield* ephemeralSecretKey;
    const wrapConversationKey = yield* conversationKeyEffect(wrapSecretKey, recipientPublicKeyHex);
    const wrapNonce = yield* randomness.nextBytes(32);
    const wrapCreatedAt = yield* jitteredTimestampSec;
    return yield* signNostrEvent(
      {
        kind: GIFT_WRAP_KIND,
        created_at: wrapCreatedAt,
        tags: [["p", recipientPublicKeyHex], ...extraWrapTags.map((tag) => [...tag])],
        content: encryptNip44(JSON.stringify(seal), wrapConversationKey, wrapNonce),
      },
      wrapSecretKey,
    );
  });

/**
 * The full outgoing path: binds the template to the sender, then produces
 * the recipient wrap and the sender's own sync wrap. Publishing the two
 * wraps (RelayPool / NostrPendingQueue) is the caller's composition.
 */
export const createChatGiftWraps = (
  template: NostrEventTemplate,
  sender: { readonly secretKey: Uint8Array; readonly publicKeyHex: string },
  recipientPublicKeyHex: string,
  options: CreateGiftWrapsOptions = {},
): Effect.Effect<GiftWrapPair, RandomnessError | InvalidNostrPublicKeyError, Randomness> =>
  Effect.gen(function* () {
    const rumor = createRumor(template, sender.publicKeyHex);
    const wrapForRecipient = yield* createGiftWrap(
      rumor,
      sender.secretKey,
      recipientPublicKeyHex,
      options.pushMarkerForRecipient === true ? [LINKY_PUSH_MARKER_TAG] : [],
    );
    const wrapForSender = yield* createGiftWrap(rumor, sender.secretKey, sender.publicKeyHex);
    return { rumor, wrapForRecipient, wrapForSender };
  });

// ---------------------------------------------------------------------------
// Incoming: wrap -> seal -> rumor, with sender validation
// ---------------------------------------------------------------------------

/**
 * Why an incoming kind-1059 event was ignored. Diagnostics only — rejection
 * is the normal fate of malformed/spoofed traffic, never a thrown error.
 *
 * - `wrap-wrong-kind` / `wrap-signature-invalid` — not a valid gift wrap.
 * - `wrap-decrypt-failed` — content is not NIP-44 for us (not addressed to
 *   this key, or garbage).
 * - `seal-unparseable` / `seal-wrong-kind` / `seal-signature-invalid` — the
 *   decrypted seal is not a validly signed kind 13.
 * - `seal-decrypt-failed` / `rumor-unparseable` — the seal's payload is not
 *   a NIP-44 rumor for us.
 * - `rumor-id-mismatch` — the rumor's `id` is not the NIP-01 hash of its
 *   fields (the id is the dedupe key; a forged id could fake duplicates).
 * - `sender-mismatch` — seal author ≠ rumor author (NIP-17 spoof check).
 * - `wrap-key-reused` — rumor author == wrap signer; real wraps use a fresh
 *   ephemeral key (the PoC's `isInvalidInnerRumorPubkey` rule).
 * - `future-timestamp` — rumor (or seal) timestamped beyond the tolerance
 *   into the future.
 */
export type GiftWrapRejectionReason =
  | "wrap-wrong-kind"
  | "wrap-signature-invalid"
  | "wrap-decrypt-failed"
  | "seal-unparseable"
  | "seal-wrong-kind"
  | "seal-signature-invalid"
  | "seal-decrypt-failed"
  | "rumor-unparseable"
  | "rumor-id-mismatch"
  | "sender-mismatch"
  | "wrap-key-reused"
  | "future-timestamp";

export interface GiftWrapRejection {
  readonly _tag: "GiftWrapRejection";
  readonly wrapId: string;
  readonly reason: GiftWrapRejectionReason;
}

const reject = (
  wrapId: string,
  reason: GiftWrapRejectionReason,
): Either.Either<ValidatedRumor, GiftWrapRejection> =>
  Either.left({ _tag: "GiftWrapRejection", wrapId, reason });

/** A rumor that survived unwrap + sender validation. */
export interface ValidatedRumor {
  /** The wrap this rumor arrived in (one rumor can arrive in many wraps). */
  readonly wrapId: string;
  /** The wrap's ephemeral signer (needed by the nested-payload check). */
  readonly wrapPubkey: string;
  /** The authenticated sender (seal author == rumor author). */
  readonly senderPubkey: string;
  readonly rumor: ChatRumor;
}

export interface UnwrapGiftWrapOptions {
  /** Unix seconds "now" for the future-timestamp check (from `Clock`). */
  readonly nowSec: number;
  /** Defaults to {@link DEFAULT_FUTURE_TOLERANCE_SEC}. */
  readonly futureToleranceSec?: number;
  /**
   * Skip re-verifying the wrap's own signature (id + Schnorr) when the
   * caller already did — `RelayPool.subscribe` verifies every delivered
   * event. Default `false` (verify).
   */
  readonly skipWrapSignatureCheck?: boolean;
}

const tryDecrypt = (
  payload: string,
  secretKey: Uint8Array,
  publicKeyHex: string,
): string | undefined => {
  try {
    return decryptNip44(payload, getConversationKey(secretKey, publicKeyHex));
  } catch {
    return undefined;
  }
};

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Unwraps and validates one kind-1059 event addressed to
 * `recipientSecretKey`. Pure given `nowSec`; total — every failure mode is a
 * typed {@link GiftWrapRejection}.
 */
export const unwrapGiftWrap = (
  wrap: NostrEvent,
  recipientSecretKey: Uint8Array,
  options: UnwrapGiftWrapOptions,
): Either.Either<ValidatedRumor, GiftWrapRejection> => {
  const tolerance = options.futureToleranceSec ?? DEFAULT_FUTURE_TOLERANCE_SEC;
  const latestAcceptedSec = options.nowSec + tolerance;

  if (wrap.kind !== GIFT_WRAP_KIND) return reject(wrap.id, "wrap-wrong-kind");
  if (options.skipWrapSignatureCheck !== true && !verifyNostrEvent(wrap)) {
    return reject(wrap.id, "wrap-signature-invalid");
  }

  const sealText = tryDecrypt(wrap.content, recipientSecretKey, wrap.pubkey);
  if (sealText === undefined) return reject(wrap.id, "wrap-decrypt-failed");
  const sealJson = tryParseJson(sealText);
  if (sealJson === undefined) return reject(wrap.id, "seal-unparseable");

  const sealOption = decodeNostrEventOption(sealJson);
  if (sealOption._tag === "None") return reject(wrap.id, "seal-unparseable");
  const seal = sealOption.value;
  if (seal.kind !== SEAL_KIND) return reject(wrap.id, "seal-wrong-kind");
  if (!verifyNostrEvent(seal)) return reject(wrap.id, "seal-signature-invalid");
  if (seal.created_at > latestAcceptedSec) return reject(wrap.id, "future-timestamp");

  const rumorText = tryDecrypt(seal.content, recipientSecretKey, seal.pubkey);
  if (rumorText === undefined) return reject(wrap.id, "seal-decrypt-failed");
  const rumorJson = tryParseJson(rumorText);
  if (rumorJson === undefined) return reject(wrap.id, "rumor-unparseable");

  const rumorOption = decodeRumorOption(rumorJson);
  if (rumorOption._tag === "None") return reject(wrap.id, "rumor-unparseable");
  const rumor = rumorOption.value;

  if (nostrEventId(rumor) !== rumor.id) return reject(wrap.id, "rumor-id-mismatch");
  if (rumor.pubkey !== seal.pubkey) return reject(wrap.id, "sender-mismatch");
  if (rumor.pubkey === wrap.pubkey) return reject(wrap.id, "wrap-key-reused");
  if (rumor.created_at > latestAcceptedSec) return reject(wrap.id, "future-timestamp");

  return Either.right({
    wrapId: wrap.id,
    wrapPubkey: wrap.pubkey,
    senderPubkey: seal.pubkey,
    rumor,
  });
};
