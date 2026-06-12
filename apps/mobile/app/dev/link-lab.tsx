/**
 * DEV-ONLY deep-link lab (#49 verification hook).
 *
 * expo-dev-launcher swallows external custom-scheme URLs in development
 * builds (verified on-device — see app/dev/restore.tsx), so `xcrun simctl
 * openurl <udid> "cashu:…"` never reaches the router in the dev client.
 * This screen feeds a URL string through the EXACT production pipeline —
 * `redirectIncomingPath` (the +native-intent transform) followed by router
 * navigation — so every link form is verifiable in the dev client; release
 * builds exercise the same code via real OS delivery.
 *
 * Gated to the development profile like /dev/restore: staging/production
 * builds bounce home.
 */
import { Button, Surface, Text } from "@linky/ui";
import type { Href } from "expo-router";
import { Redirect, useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { appProfile } from "../../src/environment";
import { redirectIncomingPath } from "../../src/scanner/deepLinkRouting";

export default function DevLinkLabScreen() {
  const router = useRouter();
  const [url, setUrl] = useState("");

  if (appProfile !== "development") return <Redirect href="/" />;

  const trimmed = url.trim();
  // Live preview of the +native-intent rewrite (tokens may be bearer
  // values — shown on-screen only, never logged).
  const resolved = trimmed === "" ? null : redirectIncomingPath(trimmed);

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="gap-4 px-6 py-4" keyboardShouldPersistTaps="handled">
        <Text weight="bold" className="text-2xl">
          dev/link-lab
        </Text>
        <Surface className="gap-3" testID="dev-link-lab">
          <Text className="text-sm opacity-70">
            Simulates an incoming OS URL through the +native-intent transform.
          </Text>
          <View className="rounded-xl bg-background px-4">
            <TextInput
              value={url}
              onChangeText={setUrl}
              placeholder="cashu:… / nostr:… / lightning:… / https://linky.fit/…"
              placeholderTextColor="#94a3b8"
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              testID="dev-link-lab-input"
              className="min-h-[72px] py-3 font-sans text-base text-foreground"
            />
          </View>
          {resolved !== null && (
            <Text className="text-xs opacity-70" testID="dev-link-lab-resolved">
              → {resolved}
            </Text>
          )}
          <Button
            label="Deliver URL"
            disabled={resolved === null}
            onPress={() => {
              if (resolved !== null) router.push(resolved as Href);
            }}
            testID="dev-link-lab-submit"
          />
        </Surface>
      </ScrollView>
    </SafeAreaView>
  );
}
