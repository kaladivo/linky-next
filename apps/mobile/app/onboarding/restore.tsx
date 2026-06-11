/**
 * `onboarding.restore-account` — STUB route for issue #18.
 *
 * The "I'm returning" entry point exists so #17's flow is complete; #18
 * replaces this screen body with the real 20-word input (forgiving paste,
 * word count, suggestions) on this same route. Core already ships the
 * primitives: `restoreIdentitySession`, `analyzeBackupPhraseInput`.
 */
import { Button, Surface, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTranslator } from "../../src/locales";

export default function RestoreAccountScreen() {
  const t = useTranslator();
  const router = useRouter();

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 justify-center gap-6 px-6" testID="onboarding-restore">
        <Text weight="bold" className="text-3xl">
          {t("onboardingReturn")}
        </Text>
        <Surface className="gap-2">
          <Text>{t("onboardingRestoreStub")}</Text>
          <Text className="text-sm opacity-70">{t("onboardingReturnHint")}</Text>
        </Surface>
        <Button label={t("back")} variant="secondary" onPress={() => router.back()} testID="restore-back" />
      </View>
    </SafeAreaView>
  );
}
