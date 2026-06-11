/**
 * NostrEvent — NIP-01 event model, id computation, Schnorr signing and
 * verification.
 *
 * Pure protocol code: the id is the SHA-256 of the canonical NIP-01
 * serialization `[0, pubkey, created_at, kind, tags, content]` (plain
 * `JSON.stringify`, exactly like nostr-tools — pinned by
 * `__fixtures__/signedEvents.golden.json`); signatures are BIP-340 Schnorr
 * over secp256k1 via @noble/curves, the same primitives the identity domain
 * uses (#13).
 *
 * Signing needs 32 bytes of auxiliary randomness (BIP-340), which is secret
 * adjacent entropy and therefore comes from the `Randomness` port — never
 * from an ambient global.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { Effect, Encoding, Schema } from "effect";

import type { RandomnessError } from "../../ports/Randomness.js";
import { Randomness } from "../../ports/Randomness.js";

// ---------------------------------------------------------------------------
// Types and schema
// ---------------------------------------------------------------------------

/** What a caller provides to create an event: everything except identity. */
export interface NostrEventTemplate {
  readonly kind: number;
  readonly created_at: number;
  readonly tags: ReadonlyArray<ReadonlyArray<string>>;
  readonly content: string;
}

/** A template bound to an author public key — the input of id computation. */
export interface UnsignedNostrEvent extends NostrEventTemplate {
  readonly pubkey: string;
}

/** A finalized NIP-01 event as it travels over the wire. */
export interface NostrEvent extends UnsignedNostrEvent {
  readonly id: string;
  readonly sig: string;
}

const LowercaseHex = (length: number) =>
  Schema.String.pipe(
    Schema.pattern(new RegExp(`^[0-9a-f]{${length}}$`), {
      identifier: `LowercaseHex${length}`,
      description: `${length} lowercase hex characters`,
    }),
  );

/**
 * Schema for wire-shaped events (incoming relay payloads, persisted pending
 * queue entries). Validates structure only — signature verification is
 * `verifyNostrEvent`.
 */
export const NostrEventSchema: Schema.Schema<NostrEvent> = Schema.Struct({
  id: LowercaseHex(64),
  pubkey: LowercaseHex(64),
  sig: LowercaseHex(128),
  kind: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  created_at: Schema.Number.pipe(Schema.int()),
  tags: Schema.Array(Schema.Array(Schema.String)),
  content: Schema.String,
});

export const decodeNostrEventOption = Schema.decodeUnknownOption(NostrEventSchema);

// ---------------------------------------------------------------------------
// Id, signing, verification
// ---------------------------------------------------------------------------

const nostrEventIdBytes = (event: UnsignedNostrEvent): Uint8Array =>
  sha256(
    utf8ToBytes(
      JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]),
    ),
  );

/** NIP-01 event id (lowercase hex SHA-256 of the canonical serialization). */
export const nostrEventId = (event: UnsignedNostrEvent): string =>
  Encoding.encodeHex(nostrEventIdBytes(event));

/**
 * Signs a template with a 32-byte Nostr secret key (e.g. the identity
 * domain's `NostrSecretKey`). Auxiliary signing randomness comes from the
 * `Randomness` port. An invalid secret key is a programmer error → defect.
 */
export const signNostrEvent = (
  template: NostrEventTemplate,
  secretKey: Uint8Array,
): Effect.Effect<NostrEvent, RandomnessError, Randomness> =>
  Effect.gen(function* () {
    const randomness = yield* Randomness;
    const auxRand = yield* randomness.nextBytes(32);
    return yield* Effect.sync(() => {
      const pubkey = Encoding.encodeHex(schnorr.getPublicKey(secretKey));
      const unsigned: UnsignedNostrEvent = { ...template, pubkey };
      const idBytes = nostrEventIdBytes(unsigned);
      const sig = Encoding.encodeHex(schnorr.sign(idBytes, secretKey, auxRand));
      return { ...unsigned, id: Encoding.encodeHex(idBytes), sig };
    });
  });

/**
 * Full NIP-01 validity check: recomputed id matches and the Schnorr
 * signature verifies against the author key. Malformed hex → `false`,
 * never a throw.
 */
export const verifyNostrEvent = (event: NostrEvent): boolean => {
  try {
    if (nostrEventId(event) !== event.id) return false;
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
};
