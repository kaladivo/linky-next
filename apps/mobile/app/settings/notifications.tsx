/**
 * Notification settings (#52, `settings.notifications` — the polished #56
 * settings surface can restyle this; the underlying enable/disable is
 * final): one switch driving `notifications.enable` / `notifications.disable`,
 * status + last error below it, and (dev/support) the advanced debug entry.
 *
 * Enabling prompts for the OS permission and registers this install with
 * the push service under the active identity (NIP-98 ownership proof);
 * disabling unregisters. A denied permission renders as state, not an
 * error dialog (the user can flip it in the OS settings and re-toggle).
 */
import { Button, Surface, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, Switch, View } from "react-native";

import { useTranslator } from "../../src/locales";
import {
  disableNotifications,
  enableNotifications,
} from "../../src/notifications/notificationActions";
import { useNotificationsState } from "../../src/notifications/useNotificationsState";
import { toast } from "../../src/toast";

export default function NotificationSettingsScreen() {
  const t = useTranslator();
  const router = useRouter();
  const view = useNotificationsState();
  const [busy, setBusy] = useState(false);

  const enabled = view.status === "ready" && view.state.enabled;
  const registration = view.status === "ready" ? view.state.registration : null;
  const lastError = view.status === "ready" ? view.state.lastError : null;

  const onToggle = (next: boolean) => {
    if (busy || view.status !== "ready") return;
    setBusy(true);
    const action = next
      ? enableNotifications().then((outcome) => {
          if (outcome === "permission-denied") toast.error(t("notificationsDenied"));
          else if (outcome === "no-session") toast.error(t("notificationsNotLoggedIn"));
          else if (outcome === "failed") toast.error(t("notificationsError"));
          else toast.success(t("notificationsRegistered"));
        })
      : disableNotifications().then(() => undefined);
    void action
      .catch(() => toast.error(t("notificationsError")))
      .finally(() => setBusy(false));
  };

  const statusText = (): string => {
    if (view.status !== "ready" || busy) return t("notificationsRegistering");
    if (enabled && registration !== null) return t("notificationsRegistered");
    if (lastError !== null && lastError === "permission denied") return t("notificationsDenied");
    return t("notificationsDisabled");
  };

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      <Surface className="gap-3">
        <View className="flex-row items-center justify-between">
          <Text weight="semibold" className="text-primary">
            {t("notifications")}
          </Text>
          <Switch
            value={enabled}
            disabled={busy || view.status !== "ready"}
            onValueChange={onToggle}
            testID="notifications-toggle"
          />
        </View>
        <Text className="text-sm opacity-70">{t("notificationsEnableHint")}</Text>
        <Text className="text-sm" testID="notifications-status">
          {statusText()}
        </Text>
        {lastError !== null && (
          <Text className="text-sm text-danger" testID="notifications-error">
            {t("notificationsError")}: {lastError}
          </Text>
        )}
      </Surface>
      <Surface className="gap-3">
        {/* notifications.debug: registration/delivery state (dev/support). */}
        <Button
          label={t("notificationsDebugTitle")}
          variant="secondary"
          onPress={() => router.push("/settings/push-debug")}
          testID="open-push-debug"
        />
      </Surface>
    </ScrollView>
  );
}
