/**
 * Owner-lane helpers for the derived-identity scheme.
 *
 * Linky derives Evolu owners deterministically from the SLIP-39 master
 * identity (issue #13): master secret -> per-lane BIP-39 mnemonic (or 32 bytes
 * of entropy) -> Evolu `OwnerSecret` -> `AppOwner`/`ShardOwner`. Evolu derives
 * the owner id, encryption key, and write key from the secret via SLIP-21, so
 * the same external input always reconstructs the same sync lane.
 */
import {
  createAppOwner,
  createShardOwner,
  Mnemonic,
  mnemonicToOwnerSecret,
  OwnerSecret,
} from "@evolu/common";
import type { AppOwner, ShardOwner } from "@evolu/common";

export { deriveShardOwner } from "@evolu/common";
export type { AppOwner, ShardOwner, SyncOwner } from "@evolu/common";

/**
 * Creates an Evolu {@link AppOwner} from an externally derived BIP-39
 * mnemonic. Returns `null` when the mnemonic is invalid.
 */
export const appOwnerFromMnemonic = (mnemonic: string): AppOwner | null => {
  const parsed = Mnemonic.fromUnknown(mnemonic);
  if (!parsed.ok) return null;
  return createAppOwner(mnemonicToOwnerSecret(parsed.value));
};

/**
 * Creates an Evolu {@link AppOwner} from 32 bytes of external entropy (e.g.
 * derived from the master identity). Returns `null` when the input is not
 * exactly 32 bytes.
 */
export const appOwnerFromEntropy = (entropy: Uint8Array): AppOwner | null => {
  const secret = OwnerSecret.fromUnknown(entropy);
  if (!secret.ok) return null;
  return createAppOwner(secret.value);
};

/**
 * Creates an Evolu {@link ShardOwner} (a deletable, separately syncable data
 * lane) from 32 bytes of external entropy. Returns `null` when the input is
 * not exactly 32 bytes.
 */
export const shardOwnerFromEntropy = (entropy: Uint8Array): ShardOwner | null => {
  const secret = OwnerSecret.fromUnknown(entropy);
  if (!secret.ok) return null;
  return createShardOwner(secret.value);
};

/**
 * Creates an Evolu {@link ShardOwner} from an externally derived BIP-39
 * mnemonic. Returns `null` when the mnemonic is invalid.
 */
export const shardOwnerFromMnemonic = (mnemonic: string): ShardOwner | null => {
  const parsed = Mnemonic.fromUnknown(mnemonic);
  if (!parsed.ok) return null;
  return createShardOwner(mnemonicToOwnerSecret(parsed.value));
};
