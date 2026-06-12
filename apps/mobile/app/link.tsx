/**
 * Deep-link landing screen (#49; `scanner.links` + `shell.link-fallbacks`).
 *
 * `+native-intent` rewrites every external value-carrying URL to
 * `/link?url=<encoded>`; this screen funnels the value into #48's ONE
 * parse+route path (`routeScannedValue`, generic `scan` entry, `replace`
 * navigation — the landing screen never lingers under the destination).
 * Thanks to the root layout's `(tabs)` anchor the stack under this screen
 * is always the tabs, so every outcome has somewhere sensible to go:
 *
 * - parsed → the destination replaces this screen (back → tabs);
 * - unsupported/malformed/value-less (`/link` with no url) → toast + tabs —
 *   old or unknown links NEVER dead-end (feature-map contract);
 * - no identity yet → toast + onboarding (the parser needs the session/
 *   store; running it pre-identity would hang on the store boot).
 *
 * The url param can carry a bearer Cashu token — never log it.
 */
import { Text } from "@linky/ui";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { View } from "react-native";

import { useTranslator } from "../src/locales";
import { routeScannedValue } from "../src/scanner/scanResultHandler";
import { useSession } from "../src/session/useSession";
import { toast } from "../src/toast";

export default function LinkLandingScreen() {
  const params = useLocalSearchParams<{ url?: string }>();
  const router = useRouter();
  const t = useTranslator();
  const session = useSession();
  const startedRef = useRef(false);

  const value = typeof params.url === "string" ? params.url.trim() : "";
  const sessionState =
    session.status === "success"
      ? session.data._tag
      : session.status === "error"
        ? "error"
        : "loading";

  useEffect(() => {
    if (startedRef.current || sessionState === "loading") return;
    startedRef.current = true;

    if (value === "" || sessionState === "error") {
      // Bare /link is the explicit fallback target of +native-intent.
      toast.info(t("linkUnsupported"));
      router.replace("/(tabs)");
      return;
    }
    if (sessionState === "NoIdentity") {
      toast.info(t("linkNeedsAccount"));
      router.replace("/onboarding");
      return;
    }

    void routeScannedValue(value, "scan", { router, t, navigation: "replace" })
      .then((outcome) => {
        if (outcome.kind === "unsupported") {
          // Visible failure, sensible landing (shell.link-fallbacks).
          toast.info(outcome.message);
          router.replace("/(tabs)");
        }
      })
      .catch(() => {
        toast.error(t("linkUnsupported"));
        router.replace("/(tabs)");
      });
  }, [sessionState, value, router, t]);

  // Never blank: a quiet "opening" state while the session loads / the
  // parser (possibly a network LNURL probe) decides where to go.
  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <Text className="text-sm opacity-70" testID="link-opening">
        {t("linkOpening")}
      </Text>
    </View>
  );
}
