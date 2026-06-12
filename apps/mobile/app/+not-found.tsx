/**
 * Unmatched-route screen (#49, `shell.link-fallbacks`): any path the router
 * can't place — outdated app links, typo'd internal hrefs — lands here and
 * is bounced to the tabs with a visible toast. Never a blank screen, never
 * a dead end (feature-map contract: "old shared links keep landing
 * somewhere useful").
 */
import { Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";

import { useTranslator } from "../src/locales";
import { toast } from "../src/toast";

export default function NotFoundScreen() {
  const router = useRouter();
  const t = useTranslator();

  useEffect(() => {
    toast.info(t("linkUnsupported"));
    router.replace("/(tabs)");
  }, [router, t]);

  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <Text className="text-sm opacity-70" testID="not-found">
        {t("linkUnsupported")}
      </Text>
    </View>
  );
}
