/**
 * Onboarding step 1 (`onboarding.choose-language`): pick Czech or English
 * BEFORE account setup. Selection goes through LocaleProvider's setLocale,
 * which updates the UI immediately and persists the preference — it carries
 * into the whole app, not just onboarding.
 *
 * Also the gate's landing spot: with a loaded identity this route bounces
 * back to the tabs — but only WHILE FOCUSED. A plain <Redirect> would also
 * fire while this screen sits unfocused at the bottom of the onboarding
 * stack, yanking the user to the tabs the moment create-account invalidates
 * the session (i.e. before profile setup and the backup prompt).
 */
import { Button, Surface, Text } from "@linky/ui";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useLocale } from "../../src/locales";
import { useSession } from "../../src/session/useSession";

export default function LanguageScreen() {
  const { locale, t, setLocale } = useLocale();
  const session = useSession();
  const router = useRouter();

  const identityLoaded = session.status === "success" && session.data._tag === "IdentityLoaded";
  useFocusEffect(
    useCallback(() => {
      if (identityLoaded) {
        router.replace("/(tabs)");
      }
    }, [identityLoaded, router]),
  );

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 justify-center gap-6 px-6" testID="onboarding-language">
        <View className="gap-2">
          <Text weight="bold" className="text-3xl">
            {t("onboardingTitle")}
          </Text>
          <Text className="opacity-70">{t("onboardingSubtitle")}</Text>
        </View>

        {session.status === "error" && (
          // Corrupted/unreadable keychain entry (#14 gate). Typed tag only,
          // never the cause — it may wrap secret material.
          <Text className="text-sm text-danger">
            {t("errorPrefix")}: {session.error._tag}
          </Text>
        )}

        <Surface className="gap-3">
          <Text weight="semibold">{t("onboardingLanguageTitle")}</Text>
          <Button
            label={t("czech")}
            variant={locale === "cs" ? "primary" : "secondary"}
            onPress={() => setLocale("cs")}
            testID="language-cs"
          />
          <Button
            label={t("english")}
            variant={locale === "en" ? "primary" : "secondary"}
            onPress={() => setLocale("en")}
            testID="language-en"
          />
        </Surface>

        <Button
          label={t("onboardingLanguageContinue")}
          onPress={() => router.push("/onboarding/create")}
          testID="language-continue"
        />
      </View>
    </SafeAreaView>
  );
}
