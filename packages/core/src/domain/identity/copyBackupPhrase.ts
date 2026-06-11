/**
 * copyBackupPhrase — explicit, user-initiated copy of the recovery phrase
 * to the system clipboard (`identity.backup`, issue #19).
 *
 * Copying secret material is allowed ONLY as an explicit user action (see
 * the Clipboard port contract); this workflow exists so the backup screen
 * never touches the port directly and so the action has a single, testable
 * definition. The phrase transits as the canonical space-separated string —
 * exactly what `restoreMasterIdentity` accepts back on paste.
 */
import { Effect } from "effect";

import type { ClipboardError } from "../../ports/Clipboard.js";
import { Clipboard } from "../../ports/Clipboard.js";
import type { BackupPhrase } from "./MasterIdentity.js";

/** Copies the canonical 20-word phrase to the clipboard. */
export const copyBackupPhrase = (
  phrase: BackupPhrase,
): Effect.Effect<void, ClipboardError, Clipboard> =>
  Effect.gen(function* () {
    const clipboard = yield* Clipboard;
    yield* clipboard.copy(phrase);
  });
