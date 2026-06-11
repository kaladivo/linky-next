/**
 * DEV-ONLY scripted identity restore route (#18, the #11 deferred hook).
 *
 *   /dev/restore?phrase=<20-word mnemonic>
 *
 * Runs the SAME workflow as the user-facing restore screen
 * (`restoreAccount` → core `restoreIdentitySession`): derive + persist +
 * session invalidation, then replaces to the tabs. An already-restored
 * device simply gets the phrase re-persisted (idempotent).
 *
 * KNOWN LIMITATION (verified on-device, SDK 56): expo-dev-launcher swallows
 * external `linky-dev://...` URLs in development builds — it restarts the
 * loaded app and never forwards the URL to expo-router (warm or cold), so
 * `xcrun simctl openurl <udid> "linky-dev:///dev/restore?phrase=..."` does
 * NOT reach this route. scripts/dev-two-sims.sh therefore drives the
 * regular onboarding restore screen via agent-device UI automation instead.
 * The route stays: it is reachable through in-app navigation/dev tooling,
 * and becomes the fast path the moment dev-launcher forwards deep links.
 *
 * Gating: outside the development profile this route refuses to act and
 * bounces home — staging/production builds must never accept secrets via
 * URL. The phrase param is secret material: it is never rendered or logged
 * (failures show only the typed error tag/reason).
 */
import { Surface, Text } from "@linky/ui";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { appProfile } from "../../src/environment";
import { restoreAccount } from "../../src/onboarding/onboardingActions";
import { useEffectMutation } from "../../src/runtime";

export default function DevRestoreScreen() {
  const params = useLocalSearchParams<{ phrase?: string }>();
  const router = useRouter();
  const restore = useEffectMutation((phrase: string) => restoreAccount(phrase));
  const { mutate } = restore;

  const phrase = typeof params.phrase === "string" ? params.phrase : "";
  const enabled = appProfile === "development";

  useEffect(() => {
    if (enabled && phrase.length > 0) mutate(phrase);
  }, [enabled, phrase, mutate]);

  useEffect(() => {
    if (restore.state.status === "success") router.replace("/(tabs)");
  }, [restore.state.status, router]);

  if (!enabled) return <Redirect href="/" />;

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 justify-center px-6">
        <Surface className="gap-2" testID="dev-restore-status">
          <Text weight="semibold">dev/restore</Text>
          <Text className="text-sm opacity-70">
            {phrase.length === 0
              ? "Missing ?phrase= param."
              : restore.state.status === "error"
                ? // Typed tag/reason only — never the phrase or its words.
                  `Restore failed: ${restore.state.error._tag}${
                    restore.state.error._tag === "InvalidBackupPhraseError"
                      ? ` (${restore.state.error.reason})`
                      : ""
                  }`
                : "Restoring…"}
          </Text>
        </Surface>
      </View>
    </SafeAreaView>
  );
}
