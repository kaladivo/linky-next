/**
 * Relay settings screen (#31, `nostr.relays` / `settings.relays`): lists
 * the user's relay URLs with live per-relay connection status (#21's
 * RelayPool), adds and removes relays, and republishes the relay lists
 * (#23) on every change.
 *
 * PoC parity notes (`NostrRelaysPage` / `NostrRelayPage` / `useRelayDomain`):
 * status is a colored dot per relay; deleting is the armed two-tap pattern
 * (first tap arms for 5 s, second confirms — the PoC put this on a detail
 * page, here it is inline on the row); removing the last relay is refused;
 * a relay with no status yet renders as "checking".
 */
import type { RelayStatus } from "@linky/core";
import { Button, Surface, Text } from "@linky/ui";
import { useEffect, useRef, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";

import { useTranslator } from "../../src/locales";
import {
  addRelay,
  removeRelay,
  watchRelayStatuses,
  watchRelayUrls,
} from "../../src/settings/relaySettingsActions";
import { toast } from "../../src/toast";

const ARM_TIMEOUT_MS = 5000;

const dotClassName: Record<RelayStatus, string> = {
  connected: "bg-primary",
  checking: "bg-foreground opacity-40",
  disconnected: "bg-danger",
};

export default function RelaySettingsScreen() {
  const t = useTranslator();

  const [urls, setUrls] = useState<ReadonlyArray<string> | null>(null);
  const [statuses, setStatuses] = useState<ReadonlyMap<string, RelayStatus>>(new Map());
  const [newUrl, setNewUrl] = useState("");
  const [invalidUrl, setInvalidUrl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [armedUrl, setArmedUrl] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    watchRelayUrls(setUrls, controller.signal);
    watchRelayStatuses(setStatuses, controller.signal);
    return () => {
      controller.abort();
      if (armTimer.current !== null) clearTimeout(armTimer.current);
    };
  }, []);

  const disarm = () => {
    if (armTimer.current !== null) clearTimeout(armTimer.current);
    armTimer.current = null;
    setArmedUrl(null);
  };

  const statusLabel: Record<RelayStatus, string> = {
    connected: t("relayStatusConnected"),
    checking: t("relayStatusChecking"),
    disconnected: t("relayStatusDisconnected"),
  };

  const onAdd = () => {
    const url = newUrl.trim();
    if (url === "") return;
    setBusy(true);
    setInvalidUrl(false);
    addRelay(url)
      .then((result) => {
        if (result === "added") {
          setNewUrl("");
        } else if (result === "invalid") {
          setInvalidUrl(true);
        } else {
          toast.error(t("relayUpdateFailed"));
        }
      })
      .catch(() => toast.error(t("relayUpdateFailed")))
      .finally(() => setBusy(false));
  };

  /** Armed two-tap delete (PoC pattern); refuses to drop the last relay. */
  const onRemove = (url: string) => {
    if (urls !== null && urls.length <= 1) {
      toast.error(t("relayKeepAtLeastOne"));
      return;
    }
    if (armedUrl !== url) {
      if (armTimer.current !== null) clearTimeout(armTimer.current);
      setArmedUrl(url);
      toast.info(t("deleteArmedHint"));
      armTimer.current = setTimeout(() => setArmedUrl(null), ARM_TIMEOUT_MS);
      return;
    }
    disarm();
    setBusy(true);
    removeRelay(url)
      .then((result) => {
        if (result === "last") {
          toast.error(t("relayKeepAtLeastOne"));
        } else if (result === "failed") {
          toast.error(t("relayUpdateFailed"));
        }
      })
      .catch(() => toast.error(t("relayUpdateFailed")))
      .finally(() => setBusy(false));
  };

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      <Surface className="gap-3" testID="relay-list">
        {urls === null ? (
          <Text className="text-sm opacity-70">…</Text>
        ) : (
          urls.map((url) => {
            const status = statuses.get(url) ?? "checking";
            return (
              <View
                key={url}
                className="flex-row items-center gap-3"
                testID={`relay-row-${url}`}
              >
                <View className={`h-3 w-3 rounded-full ${dotClassName[status]}`} />
                <View className="flex-1">
                  <Text className="text-sm" numberOfLines={1}>
                    {url}
                  </Text>
                  <Text className="text-xs opacity-60" testID={`relay-status-${url}`}>
                    {statusLabel[status]}
                  </Text>
                </View>
                <Button
                  label={t("delete")}
                  variant={armedUrl === url ? "danger" : "secondary"}
                  className="px-4 py-2"
                  disabled={busy}
                  testID={`relay-remove-${url}`}
                  onPress={() => onRemove(url)}
                />
              </View>
            );
          })
        )}
      </Surface>

      <Surface className="gap-2">
        <Text weight="semibold">{t("addRelay")}</Text>
        <TextInput
          className="rounded-xl border border-surface bg-background px-4 py-3 text-foreground"
          placeholder="wss://…"
          placeholderTextColor="#64748b"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          keyboardType="url"
          value={newUrl}
          onChangeText={(value) => {
            setNewUrl(value);
            setInvalidUrl(false);
          }}
          onSubmitEditing={onAdd}
          testID="relay-url-input"
        />
        {invalidUrl && (
          <Text className="text-sm text-danger" testID="relay-invalid-url">
            {t("relayInvalidUrl")}
          </Text>
        )}
        <Button
          label={t("addRelay")}
          disabled={busy || newUrl.trim() === ""}
          testID="relay-add"
          onPress={onAdd}
        />
      </Surface>
    </ScrollView>
  );
}
