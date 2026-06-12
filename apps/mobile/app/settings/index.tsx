import { describeEnvironment } from "@linky/core";
import { Button, Surface, Text } from "@linky/ui";
import { Link, useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView } from "react-native";

import { openFeedbackContact } from "../../src/contacts/feedbackContact";
import { DevRotationPanel } from "../../src/dev/DevRotationPanel";
import { DevSeedPanel } from "../../src/dev/DevSeedPanel";
import { PlatformSmokeTestPanel } from "../../src/dev/PlatformSmokeTestPanel";
import { useTranslator } from "../../src/locales";
import { paidOverlay } from "../../src/paidOverlay";
import { DevLogoutPanel } from "../../src/session/DevLogoutPanel";
import { useEffectQuery } from "../../src/runtime";
import { useLinkyStore } from "../../src/store/useLinkyStore";
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

/**
 * `contacts.feedback` (#26): opens the hard-coded feedback contact from the
 * menu (the PoC's ☰ menu = this pushed Settings screen) and routes to its
 * chat (placeholder until #29). Hidden while the store is still booting.
 */
function FeedbackEntry() {
  const t = useTranslator();
  const router = useRouter();
  const storeState = useLinkyStore();
  const [busy, setBusy] = useState(false);

  if (storeState.status !== "ready") return null;
  const store = storeState.store;

  const onOpen = () => {
    setBusy(true);
    openFeedbackContact(store)
      .then(({ id }) => router.push(`/chat/${id}`))
      .catch(() => toast.error(t("errorPrefix")))
      .finally(() => setBusy(false));
  };

  return (
    <Button
      label={t("feedback")}
      variant="secondary"
      disabled={busy}
      onPress={onOpen}
      testID="settings-feedback"
    />
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
        {/* settings.notifications (#52): enable/disable + debug entry. */}
        <Button
          label={t("notifications")}
          variant="secondary"
          onPress={() => router.push("/settings/notifications")}
          testID="open-notifications"
        />
        <Button
          label={t("advanced")}
          variant="secondary"
          onPress={() => router.push("/settings/advanced")}
        />
        <FeedbackEntry />
      </Surface>
      {/* Dev-only logout (#14); production logout UI ships with settings. */}
      <DevLogoutPanel />
      {/* TEMPORARY (#26): dev-only demo data seeding via the repositories. */}
      <DevSeedPanel />
      {/* sync.storage-rotation (#54): dev-only inspector + manual rotation. */}
      <DevRotationPanel />
      <DevToastDemo />
      {/* TEMPORARY: storage-spike dev screen (issue #9), removed with #15. */}
      <Link href="/dev/evolu-spike" className="p-4">
        <Text className="text-primary">Evolu spike (dev)</Text>
      </Link>
      {/* Deep-link lab (#49): dev-client verification of link arrivals
          (expo-dev-launcher swallows external custom-scheme URLs, so the
          lab feeds them through the +native-intent transform directly).
          The screen itself is dev-profile gated. */}
      <Link href="/dev/link-lab" className="p-4">
        <Text className="text-primary">Deep-link lab (dev)</Text>
      </Link>
      {/* Pending-payment queue lab (#46): deterministic queue/expiry
          verification + the pay-with-cashu stand-in toggle (settings UI
          lands with #56). The screen is dev-profile gated. */}
      <Link href="/dev/pay-queue" className="p-4">
        <Text className="text-primary">Pay queue lab (dev)</Text>
      </Link>
      {/* TEMPORARY (#8): dev-only platform port smoke test; renders null in production. */}
      <PlatformSmokeTestPanel />
    </ScrollView>
  );
}
