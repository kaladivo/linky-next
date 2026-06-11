/**
 * Backup screen (#19) — `identity.backup` from advanced settings, the
 * pull-based path beyond the onboarding prompt (account-identity.md:
 * "strongly prompted, never required before normal app access").
 *
 * Two stages, gated by explicit user intent:
 *
 *  1. Warning interstitial — nothing secret renders until the user
 *     confirms ("anyone with these words controls your funds and
 *     messages"). Navigating here directly always lands on this stage;
 *     the reveal state lives only in this mount.
 *  2. The 20 backup words as a numbered grid (wallet-style), read from the
 *     live session (`useSession` → core `loadSession`; never re-derived
 *     locally), plus copy (Clipboard port) and export (share sheet — see
 *     src/session/backupActions.ts for the PoC password-manager rationale).
 *
 * Secret handling: the words exist only in render props of this stage;
 * nothing is logged, cached, or persisted here.
 */
import type { BackupPhrase } from "@linky/core";
import { backupPhraseWords } from "@linky/core";
import { Button, Surface, Text } from "@linky/ui";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { useTranslator } from "../../src/locales";
import { copyBackupPhraseToClipboard, exportBackupPhrase } from "../../src/session/backupActions";
import { useSession } from "../../src/session/useSession";
import { toast } from "../../src/toast";

/** Stage 1: explicit confirm before any secret renders. */
function WarningGate({ onConfirm }: { onConfirm: () => void }) {
  const t = useTranslator();

  return (
    <Surface className="gap-3" testID="backup-warning">
      <Text weight="bold" className="text-danger">
        {t("backupWarningTitle")}
      </Text>
      <Text className="text-sm">{t("backupWarningBody")}</Text>
      <Button
        label={t("backupWarningConfirm")}
        variant="danger"
        onPress={onConfirm}
        testID="backup-confirm-warning"
      />
    </Surface>
  );
}

/** Stage 2: numbered word grid + copy/export actions. */
function BackupWords({ phrase }: { phrase: BackupPhrase }) {
  const t = useTranslator();
  const [busy, setBusy] = useState(false);
  const words = backupPhraseWords(phrase);

  const onCopy = () => {
    setBusy(true);
    copyBackupPhraseToClipboard(phrase)
      .then(() => toast.success(t("seedCopied")))
      // Never log the error: it can wrap native pasteboard payloads.
      .catch(() => toast.error(t("backupCopyFailed")))
      .finally(() => setBusy(false));
  };

  const onExport = () => {
    setBusy(true);
    void exportBackupPhrase(phrase)
      .then((result) => {
        if (result === "shared") toast.success(t("onboardingBackupSaveRequested"));
        if (result === "failed") toast.error(t("onboardingBackupSaveFailed"));
        // "dismissed": the user changed their mind — no toast.
      })
      .finally(() => setBusy(false));
  };

  return (
    <View className="gap-4" testID="backup-words">
      <Surface className="gap-2">
        <Text className="text-sm opacity-70">{t("backupWordsHint")}</Text>
        <View className="flex-row flex-wrap">
          {words.map((word, index) => (
            <View key={index} className="w-1/2 flex-row items-baseline gap-2 px-2 py-1.5">
              <Text className="w-6 text-right text-xs opacity-50">{index + 1}</Text>
              <Text weight="semibold" testID={`backup-word-${index + 1}`}>
                {word}
              </Text>
            </View>
          ))}
        </View>
      </Surface>
      <Button
        label={t("onboardingBackupCopy")}
        variant="secondary"
        disabled={busy}
        onPress={onCopy}
        testID="backup-copy"
      />
      <Button
        label={t("onboardingBackupSave")}
        variant="secondary"
        disabled={busy}
        onPress={onExport}
        testID="backup-export"
      />
    </View>
  );
}

export default function BackupScreen() {
  const t = useTranslator();
  // Read through the session (core loadSession) — the single source of the
  // persisted identity; the screen never re-derives or re-reads storage.
  const session = useSession();
  const [revealed, setRevealed] = useState(false);

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      {!revealed ? (
        <WarningGate onConfirm={() => setRevealed(true)} />
      ) : session.status === "success" && session.data._tag === "IdentityLoaded" ? (
        <BackupWords phrase={session.data.session.masterIdentity.backupPhrase} />
      ) : session.status === "loading" ? (
        <Surface>
          <Text className="text-sm">{t("loadingMore")}</Text>
        </Surface>
      ) : (
        // No identity / session error: the boot gate normally prevents this
        // screen from existing without a session; mirror the PoC's copy.
        <Surface testID="backup-missing">
          <Text className="text-sm text-danger">{t("seedMissing")}</Text>
        </Surface>
      )}
    </ScrollView>
  );
}
