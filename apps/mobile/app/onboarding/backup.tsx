/**
 * Onboarding step 4 (`onboarding.backup-prompt`): show the 20 backup words,
 * strongly prompt saving them — and NEVER block app entry (PoC contract:
 * both "Got it, enter" and "I'll do it later" go straight to the tabs, and
 * a relaunch mid-flow lands in the app regardless).
 *
 * Copy goes through the Clipboard port (an explicit user action on secret
 * material — the port's secrecy rule).
 *
 * Password-manager save: the PoC's "Save to passwords" uses the web
 * Credential Management API (`navigator.credentials.store(new
 * PasswordCredential(...))` behind a hidden username/password form) — that
 * mechanism is web-only. The RN/iOS equivalent is a TextInput with
 * `textContentType="newPassword"` plus Associated Domains
 * (webcredentials:linky.fit + an AASA file) so iCloud Keychain offers to
 * save; Android needs Credential Manager / autofill integration. Both need
 * domain/server setup, so that affordance is deferred to #19 (backup &
 * recovery surfaces) — until then copy-to-clipboard is the save path.
 */
import { backupPhraseWords } from "@linky/core";
import type { BackupPhrase } from "@linky/core";
import { Button, Surface, Text } from "@linky/ui";
import { Redirect, useRouter } from "expo-router";
import { useEffect } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTranslator } from "../../src/locales";
import { copyTextToClipboard } from "../../src/onboarding/onboardingActions";
import { useEffectMutation } from "../../src/runtime";
import { useSession } from "../../src/session/useSession";
import { toast } from "../../src/toast";

function BackupPrompt({ backupPhrase }: { readonly backupPhrase: BackupPhrase }) {
  const t = useTranslator();
  const router = useRouter();
  const words = backupPhraseWords(backupPhrase);

  const copy = useEffectMutation((text: string) => copyTextToClipboard(text));
  const copyStatus = copy.state.status;

  useEffect(() => {
    if (copyStatus === "success") {
      toast.success(t("copiedToClipboard"));
    }
  }, [copyStatus, t]);

  const enterApp = () => router.replace("/(tabs)");

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-6 px-6 py-8">
      <View className="gap-2">
        <Text weight="bold" className="text-3xl">
          {t("onboardingBackupTitle")}
        </Text>
        <Text className="opacity-70">{t("onboardingBackupIntro")}</Text>
      </View>

      <Surface className="flex-row flex-wrap gap-2" testID="backup-words">
        {words.map((word, index) => (
          <View
            key={`${index}-${word}`}
            className="flex-row items-baseline gap-1 rounded-lg bg-background px-2 py-1"
          >
            <Text className="text-xs opacity-50">{index + 1}</Text>
            <Text weight="semibold" className="text-sm">
              {word}
            </Text>
          </View>
        ))}
      </Surface>

      {copy.state.status === "error" && (
        <Text className="text-sm text-danger" testID="backup-copy-error">
          {t("errorPrefix")}: {copy.state.error._tag}
        </Text>
      )}

      <View className="gap-3">
        <Button
          label={t("onboardingBackupCopy")}
          variant="secondary"
          disabled={copyStatus === "pending"}
          onPress={() => copy.mutate(backupPhrase)}
          testID="backup-copy"
        />
        <Button label={t("onboardingBackupEnter")} onPress={enterApp} testID="backup-enter" />
        <Pressable accessibilityRole="button" onPress={enterApp} hitSlop={8} testID="backup-later">
          <Text className="text-center opacity-70">{t("onboardingBackupLater")}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

export default function BackupScreen() {
  const session = useSession();

  if (session.status === "loading") return null;
  if (session.status === "error" || session.data._tag === "NoIdentity") {
    return <Redirect href="/onboarding" />;
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <BackupPrompt backupPhrase={session.data.session.masterIdentity.backupPhrase} />
    </SafeAreaView>
  );
}
