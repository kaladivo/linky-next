/**
 * Onboarding placeholder (#14): rendered by the boot gate when no identity
 * is persisted. The real onboarding flow (create + backup prompt, restore)
 * is issue #17/#18 — this screen only marks the spot and, in dev builds,
 * offers "Create dev identity" so the session round-trip can be exercised
 * end-to-end before #17 lands.
 */
// TODO(#17): copy via @linky/locales once the mobile app wires i18n.
import { Button, Surface, Text } from "@linky/ui";
import { useState } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { appProfile } from "../environment";
import { createDevIdentity } from "./sessionActions";

export function OnboardingPlaceholder() {
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState(false);

  const onCreate = () => {
    setCreating(true);
    setFailed(false);
    createDevIdentity()
      .catch(() => {
        // Never log the error object here: session failures can wrap native
        // keychain errors, and this path handles secret material.
        setFailed(true);
      })
      .finally(() => setCreating(false));
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 justify-center gap-4 px-6" testID="onboarding-placeholder">
        <Text weight="bold" className="text-2xl">
          Welcome to Linky
        </Text>
        <Surface className="gap-2">
          <Text>Onboarding goes here (#17).</Text>
          <Text className="text-sm opacity-70">
            Create or restore your account once the onboarding flow lands.
          </Text>
        </Surface>
        {appProfile !== "production" && (
          <Surface className="gap-3">
            <Text weight="semibold">Dev scaffolding (#14)</Text>
            <Button
              label={creating ? "Creating…" : "Create dev identity"}
              disabled={creating}
              onPress={onCreate}
              testID="create-dev-identity"
            />
            {failed && (
              <Text className="text-sm text-danger">Could not create the dev identity.</Text>
            )}
          </Surface>
        )}
      </View>
    </SafeAreaView>
  );
}
