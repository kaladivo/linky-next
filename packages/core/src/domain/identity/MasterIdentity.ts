/**
 * Master identity domain types — the root of the whole Linky account.
 *
 * One 20-word SLIP-39 backup phrase deterministically yields the 16-byte
 * master secret, from which every app identity (Nostr keys, Cashu seed,
 * Evolu owner lanes) is derived in later issues. The phrase format is
 * compatible with existing Linky backups (PoC / slip39-ts), pinned by the
 * golden fixtures in `__fixtures__/slip39.golden.json`.
 *
 * Both values are secrets. They must never be logged, serialized into
 * errors, or stored outside the SecureStorage port.
 */
import { Schema } from "effect";

import {
  SLIP39_MASTER_SECRET_BYTES,
  SLIP39_PHRASE_WORD_COUNT,
  decodeShareWords,
} from "./slip39.js";

/** Number of words in a Linky backup phrase. */
export const BACKUP_PHRASE_WORD_COUNT = SLIP39_PHRASE_WORD_COUNT;

/** Byte length of the master secret recovered from a backup phrase. */
export const MASTER_SECRET_BYTE_COUNT = SLIP39_MASTER_SECRET_BYTES;

const isMasterSecret = (input: unknown): input is Uint8Array =>
  input instanceof Uint8Array && input.length === MASTER_SECRET_BYTE_COUNT;

/**
 * The 16-byte master secret — the SLIP-39 "master secret" the PoC recovers
 * via `Slip39.recoverSecret`. All derived identities are deterministic
 * functions of these bytes.
 */
export const MasterSecret = Schema.Uint8ArrayFromSelf.pipe(
  Schema.filter(isMasterSecret, {
    description: `a Uint8Array of exactly ${MASTER_SECRET_BYTE_COUNT} bytes`,
  }),
  Schema.brand("MasterSecret"),
);
export type MasterSecret = typeof MasterSecret.Type;

const isCanonicalBackupPhrase = (input: unknown): input is string => {
  if (typeof input !== "string") return false;
  const words = input.split(" ");
  if (words.length !== BACKUP_PHRASE_WORD_COUNT) return false;
  if (words.some((word) => word.length === 0 || word !== word.toLowerCase())) return false;
  const decoded = decodeShareWords(words);
  if (decoded._tag !== "Decoded") return false;
  // Only a self-sufficient 1-of-1 share is a Linky backup phrase.
  return decoded.share.groupThreshold === 1 && decoded.share.memberThreshold === 1;
};

/**
 * The canonical 20-word backup phrase: lowercase wordlist words separated by
 * single spaces, valid SLIP-39 checksum, restorable on its own (1-of-1).
 * This is the exact representation shown to the user for backup (#17) and
 * export (#19); `backupPhraseWords` splits it for word-grid display.
 */
export const BackupPhrase = Schema.String.pipe(
  Schema.filter(isCanonicalBackupPhrase, {
    description: "a canonical 20-word SLIP-39 backup phrase",
  }),
  Schema.brand("BackupPhrase"),
);
export type BackupPhrase = typeof BackupPhrase.Type;

/**
 * The master identity: the canonical backup phrase and the master secret it
 * recovers to. `createMasterIdentity` and `restoreMasterIdentity` are the
 * only constructors; the two fields are always consistent with each other.
 */
export interface MasterIdentity {
  readonly backupPhrase: BackupPhrase;
  readonly masterSecret: MasterSecret;
}

/** The backup phrase as its 20 words, for backup display/confirmation UIs. */
export const backupPhraseWords = (phrase: BackupPhrase): ReadonlyArray<string> =>
  phrase.split(" ");
