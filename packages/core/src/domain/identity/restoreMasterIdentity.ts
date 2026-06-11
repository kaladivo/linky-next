/**
 * restoreMasterIdentity — recovers the master identity from user-entered
 * backup words (`identity.restore` in the feature map).
 *
 * Accepts raw user input: mixed case, pasted text, extra whitespace, and
 * `,`/`;`/newline separators are all normalized before parsing. Failures are
 * a single typed error whose `reason` (plus word-level detail) tells the
 * restore UI (#18) exactly what is wrong.
 *
 * Compatibility: any phrase the PoC (slip39-ts@0.1.13) created or accepted
 * restores to the identical master secret bytes — including non-extendable
 * shares and non-zero iteration exponents. Pinned by the golden fixtures.
 */
import { Data, Effect } from "effect";

import { normalizeBackupPhraseInput } from "./backupPhraseInput.js";
import type { MasterIdentity } from "./MasterIdentity.js";
import { BACKUP_PHRASE_WORD_COUNT, BackupPhrase, MasterSecret } from "./MasterIdentity.js";
import type { DecodedShare } from "./slip39.js";
import { decodeShareWords, recoverMasterSecretBytes } from "./slip39.js";

/**
 * The input is not a restorable backup phrase.
 *
 * - `word-count` — not exactly 20 words after normalization (`wordCount`
 *   carries the actual count; 0 for empty input).
 * - `unknown-words` — words outside the SLIP-39 wordlist (`unknownWords`
 *   lists them for highlighting).
 * - `checksum` — all words are valid but the SLIP-39 checksum fails
 *   (typo with valid words, wrong word order).
 * - `share-format` — checksum-valid but structurally invalid share
 *   (non-zero padding bits, group threshold above group count).
 * - `unsupported-share` — a valid SLIP-39 share that cannot restore an
 *   account on its own (member/group threshold above 1). Linky never
 *   creates these.
 *
 * Carries no secret material: only counts and dictionary words.
 */
export class InvalidBackupPhraseError extends Data.TaggedError("InvalidBackupPhraseError")<{
  readonly reason:
    | "word-count"
    | "unknown-words"
    | "checksum"
    | "share-format"
    | "unsupported-share";
  readonly wordCount: number;
  readonly unknownWords: ReadonlyArray<string>;
}> {}

interface ParsedPhrase {
  readonly normalized: string;
  readonly share: DecodedShare;
}

const parse = (input: string): ParsedPhrase | InvalidBackupPhraseError => {
  const normalized = normalizeBackupPhraseInput(input);
  const words = normalized.length === 0 ? [] : normalized.split(" ");

  const fail = (
    reason: InvalidBackupPhraseError["reason"],
    unknownWords: ReadonlyArray<string> = [],
  ): InvalidBackupPhraseError =>
    new InvalidBackupPhraseError({ reason, wordCount: words.length, unknownWords });

  if (words.length !== BACKUP_PHRASE_WORD_COUNT) return fail("word-count");

  const decoded = decodeShareWords(words);
  switch (decoded._tag) {
    case "UnknownWords":
      return fail("unknown-words", decoded.unknownWords);
    case "InvalidChecksum":
      return fail("checksum");
    case "InvalidShareFormat":
      return fail("share-format");
    case "Decoded": {
      const { share } = decoded;
      if (share.groupThreshold !== 1 || share.memberThreshold !== 1) {
        return fail("unsupported-share");
      }
      return { normalized, share };
    }
  }
};

/**
 * Restores the master identity from raw backup-word input. Same phrase ->
 * same master secret bytes as the PoC, forever.
 *
 * The returned values are secrets — never log them.
 */
export const restoreMasterIdentity = (
  input: string,
): Effect.Effect<MasterIdentity, InvalidBackupPhraseError> =>
  Effect.suspend(() => {
    const result = parse(input);
    return result instanceof InvalidBackupPhraseError
      ? Effect.fail(result)
      : Effect.succeed({
          backupPhrase: BackupPhrase.make(result.normalized),
          masterSecret: MasterSecret.make(recoverMasterSecretBytes(result.share)),
        });
  });

/**
 * True when `input` (raw, un-normalized) is a complete, restorable backup
 * phrase — the PoC's `validateSlip39Share` equivalent for enabling the
 * restore button. Cheap: validates without running the SLIP-39 key
 * derivation.
 */
export const isValidBackupPhrase = (input: string): boolean =>
  !(parse(input) instanceof InvalidBackupPhraseError);
