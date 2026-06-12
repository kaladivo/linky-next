/**
 * Push debug screen (#52, `notifications.debug` — dev/support only, the
 * PoC's PushDebugPage equivalent): the full registration and delivery
 * state, gathered live. Technical values render untranslated on purpose —
 * this screen exists to be read over a support call / Metro console.
 *
 * Shown: permission state, install id, the CURRENT obtainable Expo token
 * (+ source — `dev-fake` marks the simulator/dev fallback), the service
 * URL and its /health reply, what was last REGISTERED (identity, token,
 * when, how many stale installs the service replaced), the last delivery
 * seen by this device and the last error. Actions: refresh, force
 * re-register (replace-stale path), unregister.
 */
import { Button, Surface, Text } from "@linky/ui";
import { useCallback, useEffect, useState } from "react";
import { ScrollView } from "react-native";

import { useTranslator } from "../../src/locales";
import {
  disableNotifications,
  enableNotifications,
  getNotificationsDebugSnapshot,
  reconcileNotificationRegistration,
} from "../../src/notifications/notificationActions";
import type { NotificationsDebugSnapshot } from "../../src/notifications/notificationActions";
import { toast } from "../../src/toast";

const shortValue = (value: string | null, keep = 28): string => {
  if (value === null) return "—";
  return value.length <= keep ? value : `${value.slice(0, keep)}…`;
};

const timestamp = (ms: number | null | undefined): string =>
  ms === null || ms === undefined || ms === 0 ? "—" : new Date(ms).toISOString();

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Text className="text-xs" selectable>
      <Text weight="semibold" className="text-xs">
        {label}:{" "}
      </Text>
      {value}
    </Text>
  );
}

export default function PushDebugScreen() {
  const t = useTranslator();
  const [snapshot, setSnapshot] = useState<NotificationsDebugSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setSnapshot(null);
    void getNotificationsDebugSnapshot()
      .then(setSnapshot)
      .catch(() => toast.error(t("notificationsError")));
  }, [t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const act = (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void action()
      .then((outcome) => {
        if (typeof outcome === "string") toast.info(outcome);
        refresh();
      })
      .catch(() => toast.error(t("notificationsError")))
      .finally(() => setBusy(false));
  };

  const registration = snapshot?.state.registration ?? null;
  const delivery = snapshot?.state.lastDelivery ?? null;

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      <Surface className="gap-2" testID="push-debug-state">
        <Text weight="semibold" className="text-primary">
          Registration
        </Text>
        {snapshot === null ? (
          <Text className="text-sm">{t("loadingMore")}</Text>
        ) : (
          <>
            <Row label="enabled" value={String(snapshot.state.enabled)} />
            <Row label="permission" value={snapshot.permission} />
            <Row label="installationId" value={snapshot.installationId} />
            <Row label="serviceUrl" value={snapshot.serviceUrl} />
            <Row
              label="currentToken"
              value={`${shortValue(snapshot.currentToken, 40)}${
                snapshot.currentTokenSource === null ? "" : ` (${snapshot.currentTokenSource})`
              }`}
            />
            <Row label="registered.identity" value={shortValue(registration?.pubkeyHex ?? null)} />
            <Row
              label="registered.token"
              value={`${shortValue(registration?.expoPushToken ?? null, 40)}${
                registration === null ? "" : ` (${registration.tokenSource})`
              }`}
            />
            <Row label="registered.serviceUrl" value={registration?.serviceUrl ?? "—"} />
            <Row label="registered.at" value={timestamp(registration?.registeredAtMs)} />
            <Row
              label="replacedStaleInstalls"
              value={registration === null ? "—" : String(registration.replacedStaleInstalls)}
            />
            <Row label="lastError" value={snapshot.state.lastError ?? "—"} />
          </>
        )}
      </Surface>

      <Surface className="gap-2" testID="push-debug-delivery">
        <Text weight="semibold" className="text-primary">
          Last delivery
        </Text>
        <Row label="receivedAt" value={timestamp(delivery?.receivedAtMs)} />
        <Row label="eventId" value={shortValue(delivery?.eventId ?? null, 40)} />
        <Row label="presentation" value={delivery?.presentation ?? "—"} />
      </Surface>

      <Surface className="gap-2" testID="push-debug-health">
        <Text weight="semibold" className="text-primary">
          Service /health
        </Text>
        <Text className="text-xs" selectable>
          {snapshot?.health ?? t("loadingMore")}
        </Text>
      </Surface>

      <Surface className="gap-3">
        <Button label="Refresh" variant="secondary" disabled={busy} onPress={refresh} />
        <Button
          label="Re-register now"
          variant="secondary"
          disabled={busy}
          testID="push-debug-reregister"
          onPress={() => act(() => enableNotifications())}
        />
        <Button
          label="Reconcile (replace-stale)"
          variant="secondary"
          disabled={busy}
          testID="push-debug-reconcile"
          onPress={() => act(() => reconcileNotificationRegistration())}
        />
        <Button
          label="Unregister"
          variant="secondary"
          disabled={busy}
          testID="push-debug-unregister"
          onPress={() => act(() => disableNotifications())}
        />
      </Surface>
    </ScrollView>
  );
}
