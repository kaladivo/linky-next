/**
 * Registration ownership proofs — NIP-98 HTTP Auth (kind 27235), the exact
 * token format `@linky/core`'s `buildNip98Token` emits (the mobile client
 * reuses that builder; see `nip98.ts` in core).
 *
 * Why NIP-98 instead of the PoC's challenge round-trip: the proof is
 * action-specific by construction — the signed event pins the absolute URL
 * (`u`), the HTTP method, and the sha256 of the exact request body
 * (`payload`), so a register proof can never authorize an unregister and a
 * proof for one token/install can never be replayed for another. Expiry is
 * the `created_at` window (default 60 s), and same-window replay is blocked
 * by remembering consumed proof event ids until their window passes
 * (`consumed_proofs` table). One fewer round trip, no server-side challenge
 * state.
 *
 * The proof's `pubkey` must equal the recipient identity being registered —
 * that is the ownership claim.
 */
import { Data, Effect, Encoding } from "effect";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import {
  decodeNostrEventOption,
  NIP98_AUTHORIZATION_SCHEME,
  NIP98_HTTP_AUTH_KIND,
  verifyNostrEvent,
} from "@linky/core";

import { PushStorage } from "./storage.js";

export type ProofRejectionReason =
  | "missing-header"
  | "bad-encoding"
  | "bad-event"
  | "wrong-kind"
  | "bad-signature"
  | "wrong-url"
  | "wrong-method"
  | "wrong-payload"
  | "expired"
  | "pubkey-mismatch"
  | "replayed";

export class ProofError extends Data.TaggedError("ProofError")<{
  readonly reason: ProofRejectionReason;
}> {}

/** Single-valued tag lookup; duplicated tags are rejected (null). */
const tagValue = (tags: ReadonlyArray<ReadonlyArray<string>>, name: string): string | null => {
  let value: string | null = null;
  for (const tag of tags) {
    if (tag[0] !== name) continue;
    if (value !== null) return null;
    const candidate = tag[1];
    if (candidate === undefined || candidate === "") return null;
    value = candidate;
  }
  return value;
};

export interface VerifyProofArgs {
  /** Raw `Authorization` header value (or undefined when absent). */
  readonly authorization: string | undefined;
  /** Absolute URL the client must have signed (`u` tag). */
  readonly expectedUrl: string;
  /** HTTP method of the request. */
  readonly expectedMethod: string;
  /** Raw request body bytes as received — hashed for the `payload` tag. */
  readonly rawBody: string;
  /** The recipient identity the request claims; must sign the proof. */
  readonly expectedPubkey: string;
  readonly nowMs: number;
  readonly proofMaxAgeSec: number;
}

/**
 * Verifies one proof and consumes its event id (replay barrier). Fails with
 * `ProofError`; succeeds with void.
 */
export const verifyRegistrationProof = (
  args: VerifyProofArgs,
): Effect.Effect<void, ProofError, PushStorage> =>
  Effect.gen(function* () {
    const fail = (reason: ProofRejectionReason) => Effect.fail(new ProofError({ reason }));

    if (args.authorization === undefined) return yield* fail("missing-header");
    if (!args.authorization.startsWith(NIP98_AUTHORIZATION_SCHEME)) {
      return yield* fail("missing-header");
    }

    const base64 = args.authorization.slice(NIP98_AUTHORIZATION_SCHEME.length).trim();
    const bytes = Encoding.decodeBase64(base64);
    if (bytes._tag === "Left") return yield* fail("bad-encoding");
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes.right));
    } catch {
      return yield* fail("bad-encoding");
    }

    const decoded = decodeNostrEventOption(json);
    if (decoded._tag === "None") return yield* fail("bad-event");
    const event = decoded.value;

    if (event.kind !== NIP98_HTTP_AUTH_KIND) return yield* fail("wrong-kind");
    if (!verifyNostrEvent(event)) return yield* fail("bad-signature");

    if (tagValue(event.tags, "u") !== args.expectedUrl) return yield* fail("wrong-url");
    if (tagValue(event.tags, "method") !== args.expectedMethod) return yield* fail("wrong-method");
    const expectedPayloadHash = Encoding.encodeHex(sha256(utf8ToBytes(args.rawBody)));
    if (tagValue(event.tags, "payload") !== expectedPayloadHash) {
      return yield* fail("wrong-payload");
    }

    const nowSec = Math.floor(args.nowMs / 1000);
    if (Math.abs(nowSec - event.created_at) > args.proofMaxAgeSec) {
      return yield* fail("expired");
    }

    if (event.pubkey !== args.expectedPubkey) return yield* fail("pubkey-mismatch");

    const storage = yield* PushStorage;
    // Keep the id until the validity window has passed everywhere (+60 s
    // margin); after that the `expired` check rejects the proof anyway.
    const expiresAtMs = (event.created_at + args.proofMaxAgeSec) * 1000 + 60_000;
    const fresh = yield* storage.consumeProof(event.id, expiresAtMs);
    if (!fresh) return yield* fail("replayed");
  });
