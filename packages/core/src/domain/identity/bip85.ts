/**
 * Internal BIP-32 / BIP-85 primitives over the master secret.
 *
 * Exactly the PoC's mechanism (`linky-poc/.../identity/utils.ts` /
 * `IdentityProvider.ts`):
 *
 * - the BIP-32 root is `HDKey.fromMasterSeed(masterSecret)` — the master
 *   secret bytes are used as the seed directly,
 * - BIP-85 entropy is `HMAC-SHA512(key="bip-entropy-from-k",
 *   msg=derivedNode.privateKey)` truncated to 16 or 32 bytes.
 *
 * Functions here throw on violated invariants (a derived node without a
 * private key — probability ~2^-128); callers wrap them in `Effect.sync`,
 * which turns such throws into defects, never typed errors.
 *
 * Internal module — not exported from the package root.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";

import type { MasterSecret } from "./MasterIdentity.js";

// ASCII bytes of "bip-entropy-from-k" (BIP-85); no TextEncoder — core's lib
// is pure ES (no DOM globals).
const BIP85_HMAC_KEY = Uint8Array.from("bip-entropy-from-k", (char) => char.charCodeAt(0));

/** The BIP-32 root of all derived identities. */
export const hdRootFromMasterSecret = (masterSecret: MasterSecret): HDKey =>
  HDKey.fromMasterSeed(masterSecret);

/** The private key at `path`. Throws (defect) if the node has none. */
export const derivePrivateKey = (root: HDKey, path: string): Uint8Array => {
  const node = root.derive(path);
  if (!node.privateKey) {
    throw new Error(`BIP-32 derivation produced no private key at ${path}`);
  }
  return node.privateKey;
};

/** BIP-85 entropy bytes at `path` (16 for owner lanes, 32 for the Cashu seed). */
export const bip85Entropy = (root: HDKey, path: string, byteLength: 16 | 32): Uint8Array =>
  hmac(sha512, BIP85_HMAC_KEY, derivePrivateKey(root, path)).slice(0, byteLength);
