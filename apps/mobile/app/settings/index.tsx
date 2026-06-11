import { describeEnvironment } from "@linky/core";
import { Button, Surface, Text } from "@linky/ui";
import { Link, useRouter } from "expo-router";
import { ScrollView } from "react-native";

import { PlatformSmokeTestPanel } from "../../src/dev/PlatformSmokeTestPanel";
import { useTranslator } from "../../src/locales";
import { paidOverlay } from "../../src/paidOverlay";
import { DevLogoutPanel } from "../../src/session/DevLogoutPanel";
import { useEffectQuery } from "../../src/runtime";
import { toast } from "../../src/toast";

/**
 * The "Environment" card is the reference example for the Effect ↔ React
 * bridge (docs/effect-react-bridge.md): a core workflow
 * (describeEnvironment) runs on the app ManagedRuntime via useEffectQuery
 * and its result renders through the status union. describeEnvironment
 * cannot fail (E = never), but the error branch is written out anyway as
 * the canonical shape every query consumer follows.
 */
function EnvironmentSummary() {
  const summary = useEffectQuery(describeEnvironment);
  const t = useTranslator();

  return (
    <Surface className="gap-2" testID="environment-summary">
      <Text weight="semibold" className="text-primary">
        Environment
      </Text>
      {summary.status === "loading" && <Text className="text-sm">{t("loadingMore")}</Text>}
      {summary.status === "error" && (
        <Text className="text-sm text-danger">Could not read environment.</Text>
      )}
      {summary.status === "success" && <Text className="text-sm">{summary.data}</Text>}
    </Surface>
  );
}

/** Dev-only: exercises the feedback overlays (toasts + paid overlay). */
function DevToastDemo() {
  const t = useTranslator();

  if (!__DEV__) return null;

  return (
    <Surface className="gap-3">
      <Text weight="semibold" className="text-primary">
        Feedback overlays (dev)
      </Text>
      <Button
        label={t("devShowDemoToast")}
        variant="secondary"
        testID="dev-show-toast"
        onPress={() => toast.success(t("devDemoToastMessage"))}
      />
      {/* #36: paid overlay demo — full-screen ✓ sheet, auto-dismisses. */}
      <Button
        label={t("devShowPaidOverlay")}
        variant="secondary"
        testID="dev-show-paid-overlay"
        onPress={() => paidOverlay.show()}
      />
    </Surface>
  );
}

export default function SettingsScreen() {
  const t = useTranslator();
  const router = useRouter();

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      <EnvironmentSummary />
      <Surface className="gap-3">
        <Text>{t("shellSettingsPlaceholder")}</Text>
        <Button
          label={t("advanced")}
          variant="secondary"
          onPress={() => router.push("/settings/advanced")}
        />
      </Surface>
      {/* Dev-only logout (#14); production logout UI ships with settings. */}
      <DevLogoutPanel />
      <DevToastDemo />
      {/* TEMPORARY: storage-spike dev screen (issue #9), removed with #15. */}
      <Link href="/dev/evolu-spike" className="p-4">
        <Text className="text-primary">Evolu spike (dev)</Text>
      </Link>
      {/* TEMPORARY (#8): dev-only platform port smoke test; renders null in production. */}
      <PlatformSmokeTestPanel />
    </ScrollView>
  );
}
