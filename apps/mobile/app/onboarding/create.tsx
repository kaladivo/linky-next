/**
 * Onboarding step 2 (`onboarding.create-account`): "I'm getting started"
 * runs core's createIdentitySession (fresh SLIP-39 identity + derivations,
 * persisted via SecureStorage). Progress while it runs, typed error + retry
 * on failure, then on to profile setup. "I'm returning" routes to the
 * restore stub that issue #18 fills in.
 */
import { Button, Surface, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTranslator } from "../../src/locales";
import { createAccount } from "../../src/onboarding/onboardingActions";
import { useEffectMutation } from "../../src/runtime";

export default function CreateAccountScreen() {
  const t = useTranslator();
  const router = useRouter();
  const creation = useEffectMutation(() => createAccount);
  const { status } = creation.state;

  useEffect(() => {
    if (status === "success") {
      router.replace("/onboarding/profile");
    }
  }, [status, router]);

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 justify-center gap-6 px-6" testID="onboarding-create">
        <View className="gap-2">
          <Text weight="bold" className="text-3xl">
            {t("onboardingTitle")}
          </Text>
          <Text className="opacity-70">{t("onboardingSubtitle")}</Text>
        </View>

        {(status === "pending" || status === "success") && (
          <Surface className="flex-row items-center gap-3" testID="onboarding-creating">
            <ActivityIndicator />
            <Text>{t("onboardingCreating")}</Text>
          </Surface>
        )}

        {creation.state.status === "error" && (
          <Surface className="gap-3" testID="onboarding-create-error">
            {/* Typed error only (RandomnessError | SecureStorageError) — never
                render the cause, it can wrap native keychain errors. */}
            <Text className="text-danger">
              {t("onboardingCreateFailed")} ({creation.state.error._tag})
            </Text>
            <Button
              label={t("onboardingRetry")}
              onPress={() => creation.mutate()}
              testID="onboarding-create-retry"
            />
          </Surface>
        )}

        {status === "idle" && (
          <Button
            label={t("onboardingCreate")}
            onPress={() => creation.mutate()}
            testID="onboarding-create-account"
          />
        )}

        <Pressable
          accessibilityRole="button"
          disabled={status === "pending" || status === "success"}
          onPress={() => router.push("/onboarding/restore")}
          hitSlop={8}
          testID="onboarding-restore-link"
        >
          <Text className="text-center text-primary">{t("onboardingReturn")}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
