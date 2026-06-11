/**
 * Imperative backup actions (#19): copy + export of the recovery phrase,
 * triggered from the backup screen. Follows the sessionActions pattern —
 * components call these promises; Effect stays behind `runAppEffect`.
 *
 * Export mechanism: the PoC (web) saves the phrase into the browser's
 * password manager via the Credential Management API (`PasswordCredential`
 * + a hidden sign-in form — see linky-poc `platform/passwordManager.ts`).
 * iOS has no API to push a password into the user's password manager
 * programmatically, so the closest RN-native equivalent is the system
 * share sheet (`Share.share`): password managers (1Password, Bitwarden,
 * iCloud Notes…) register share extensions, so "Save to passwords" hands
 * the phrase to whichever safe destination the user picks. No file is
 * written — the phrase transits only through the share payload.
 *
 * Everything here handles secret material: never log the phrase or the
 * raw errors (they can wrap native payloads).
 */
import type { BackupPhrase } from "@linky/core";
import { copyBackupPhrase } from "@linky/core";
import { Share } from "react-native";

import { runAppEffect } from "../runtime";

/** Copies the canonical 20-word phrase via the Clipboard port. */
export const copyBackupPhraseToClipboard = async (phrase: BackupPhrase): Promise<void> => {
  await runAppEffect(copyBackupPhrase(phrase));
};

export type ExportBackupPhraseResult = "shared" | "dismissed" | "failed";

/** Opens the system share sheet with the phrase (see module docs). */
export const exportBackupPhrase = async (
  phrase: BackupPhrase,
): Promise<ExportBackupPhraseResult> => {
  try {
    const result = await Share.share({ message: phrase });
    return result.action === Share.dismissedAction ? "dismissed" : "shared";
  } catch {
    return "failed";
  }
};
