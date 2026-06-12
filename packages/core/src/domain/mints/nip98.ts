/**
 * NIP-98 HTTP Auth token — byte-for-byte what the PoC sends (nostr-tools
 * `nip98.getToken(url, method, sign, true, payload)`), pinned by the golden
 * fixture: a kind-27235 event with `u`/`method` (+ `payload` sha256) tags,
 * serialized in nostr-tools' key order and base64'd behind the `Nostr `
 * scheme.
 *
 * Wire-format invariant: the JSON key order of the encoded event must stay
 * `kind, tags, created_at, content, pubkey, id, sig` — that is what
 * nostr-tools emits and what the golden test compares byte-for-byte.
 * `signNostrEvent` preserves the template's key order and appends
 * `pubkey, id, sig`, so the template below is built in exactly that order.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { Effect, Encoding } from "effect";

import type { RandomnessError } from "../../ports/Randomness.js";
import type { Randomness } from "../../ports/Randomness.js";
import { signNostrEvent } from "../nostr/NostrEvent.js";

export const NIP98_HTTP_AUTH_KIND = 27235;
export const NIP98_AUTHORIZATION_SCHEME = "Nostr ";

export interface Nip98TokenArgs {
  /** Absolute URL of the authorized request (the `u` tag). */
  readonly url: string;
  /** HTTP method exactly as sent, e.g. "PUT". */
  readonly method: string;
  /** JSON payload of the request; hashed into the `payload` tag. */
  readonly payload?: Record<string, string>;
  /** 32-byte Nostr secret key of the active identity. */
  readonly secretKey: Uint8Array;
  /** Event timestamp in unix seconds (callers pass "now"). */
  readonly nowSec: number;
}

/** `Authorization` header value: `Nostr <base64(event JSON)>`. */
export const buildNip98Token = (
  args: Nip98TokenArgs,
): Effect.Effect<string, RandomnessError, Randomness> =>
  Effect.gen(function* () {
    const tags: string[][] = [
      ["u", args.url],
      ["method", args.method],
    ];
    if (args.payload !== undefined) {
      tags.push(["payload", Encoding.encodeHex(sha256(utf8ToBytes(JSON.stringify(args.payload))))]);
    }
    // Key order matters (see module doc): kind, tags, created_at, content.
    const event = yield* signNostrEvent(
      { kind: NIP98_HTTP_AUTH_KIND, tags, created_at: args.nowSec, content: "" },
      args.secretKey,
    );
    return `${NIP98_AUTHORIZATION_SCHEME}${Encoding.encodeBase64(utf8ToBytes(JSON.stringify(event)))}`;
  });
