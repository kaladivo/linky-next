/**
 * Sync server settings screen (#53, `sync.servers` / `sync.status` /
 * `settings.sync-servers`): lists the configured Evolu sync servers with
 * live per-server reachability plus an overall summary, adds, removes, and
 * disables servers, and surfaces the restart-required hint — Evolu 7.4.1
 * fixes transports at store creation, so edits only apply on the next boot.
 *
 * PoC parity notes (`EvoluServersPage` / `EvoluServerPage` /
 * `useEvoluServersManager`): status dots with WebSocket probes; per-server
 * disable ("Go offline") that keeps the entry listed; armed two-tap delete;
 * removing the last server is refused; edits arm a reload hint + button.
 * Divergences (documented in core's `syncServerSettings.ts` too): the PoC's
 * list→detail navigation is flattened into inline rows (the #31 relays
 * screen is the design template), status labels say Connected/Disconnected
 * (the probe measures reachability, not sync completion — the PoC's
 * "Synced" overclaimed), and removing a single default sticks.
 */
import type { SyncServerEntry, SyncServerStatus } from "@linky/core";
import { overallSyncServerStatus } from "@linky/core";
import { Button, Surface, Text } from "@linky/ui";
import { useEffect, useRef, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";

import { useTranslator } from "../../src/locales";
import {
  addSyncServer,
  refreshSyncServerStatuses,
  removeSyncServer,
  restartAppForSyncServers,
  setSyncServerEnabled,
  watchSyncServers,
  watchSyncServerStatuses,
} from "../../src/settings/syncServerActions";
import { getAppliedSyncServerUrls } from "../../src/store/storeManager";
import { toast } from "../../src/toast";

const ARM_TIMEOUT_MS = 5000;
/** PoC parity: probe every 15 s while the screen is visible. */
const PROBE_INTERVAL_MS = 15000;

const dotClassName: Record<SyncServerStatus, string> = {
  connected: "bg-primary",
  checking: "bg-foreground opacity-40",
  disconnected: "bg-danger",
};

const sameUrlList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((url, index) => url === b[index]);

export default function SyncServerSettingsScreen() {
  const t = useTranslator();

  const [servers, setServers] = useState<ReadonlyArray<SyncServerEntry> | null>(null);
  const [statuses, setStatuses] = useState<ReadonlyMap<string, SyncServerStatus>>(new Map());
  const [newUrl, setNewUrl] = useState("");
  const [invalidUrl, setInvalidUrl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [armedUrl, setArmedUrl] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    watchSyncServers(setServers, controller.signal);
    watchSyncServerStatuses(setStatuses, controller.signal);
    void refreshSyncServerStatuses();
    const probeTimer = setInterval(() => void refreshSyncServerStatuses(), PROBE_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(probeTimer);
      if (armTimer.current !== null) clearTimeout(armTimer.current);
    };
  }, []);

  const disarm = () => {
    if (armTimer.current !== null) clearTimeout(armTimer.current);
    armTimer.current = null;
    setArmedUrl(null);
  };

  const statusLabel: Record<SyncServerStatus, string> = {
    connected: t("syncServerStatusConnected"),
    checking: t("syncServerStatusChecking"),
    disconnected: t("syncServerStatusDisconnected"),
  };

  // Restart-required: the store boot captured `applied`; edits change the
  // active list, and Evolu cannot pick them up without a restart.
  const applied = getAppliedSyncServerUrls();
  const activeUrls =
    servers?.filter((server) => server.enabled).map((server) => server.url) ?? null;
  const restartRequired =
    applied !== null && activeUrls !== null && !sameUrlList(applied, activeUrls);

  const overall = overallSyncServerStatus(statuses);
  const connectedCount = [...statuses.values()].filter(
    (status) => status === "connected",
  ).length;

  const onAdd = () => {
    const url = newUrl.trim();
    if (url === "") return;
    setBusy(true);
    setInvalidUrl(false);
    addSyncServer(url)
      .then((result) => {
        if (result === "added") {
          setNewUrl("");
          void refreshSyncServerStatuses();
        } else if (result === "invalid") {
          setInvalidUrl(true);
        } else {
          toast.error(t("syncServerUpdateFailed"));
        }
      })
      .catch(() => toast.error(t("syncServerUpdateFailed")))
      .finally(() => setBusy(false));
  };

  /** Armed two-tap delete (PoC pattern); refuses to drop the last server. */
  const onRemove = (url: string) => {
    if (servers !== null && servers.length <= 1) {
      toast.error(t("syncServerKeepAtLeastOne"));
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
    removeSyncServer(url)
      .then((result) => {
        if (result === "last") {
          toast.error(t("syncServerKeepAtLeastOne"));
        } else if (result === "failed") {
          toast.error(t("syncServerUpdateFailed"));
        }
      })
      .catch(() => toast.error(t("syncServerUpdateFailed")))
      .finally(() => setBusy(false));
  };

  const onToggle = (server: SyncServerEntry) => {
    setBusy(true);
    setSyncServerEnabled(server.url, !server.enabled)
      .then((result) => {
        if (result === "failed") {
          toast.error(t("syncServerUpdateFailed"));
        } else {
          void refreshSyncServerStatuses();
        }
      })
      .catch(() => toast.error(t("syncServerUpdateFailed")))
      .finally(() => setBusy(false));
  };

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      {/* Overall status (sync.status): connected count over enabled servers. */}
      <Surface className="flex-row items-center gap-3" testID="sync-overall">
        <View className={`h-3 w-3 rounded-full ${dotClassName[overall]}`} />
        <Text className="flex-1 text-sm" testID="sync-overall-status">
          {statusLabel[overall]}
        </Text>
        <Text className="text-sm opacity-60">
          {t("syncServersConnectedCount", {
            connected: connectedCount,
            total: statuses.size,
          })}
        </Text>
      </Surface>

      {restartRequired && (
        <Surface className="gap-2" testID="sync-restart-banner">
          <Text className="text-sm">{t("syncServersRestartHint")}</Text>
          <Button
            label={t("syncServersRestartButton")}
            variant="secondary"
            testID="sync-restart-now"
            onPress={() => void restartAppForSyncServers()}
          />
        </Surface>
      )}

      <Surface className="gap-3" testID="sync-server-list">
        {servers === null ? (
          <Text className="text-sm opacity-70">…</Text>
        ) : (
          servers.map((server) => {
            const status = server.enabled
              ? (statuses.get(server.url) ?? "checking")
              : "disconnected";
            return (
              <View
                key={server.url}
                className="flex-row items-center gap-3"
                testID={`sync-server-row-${server.url}`}
              >
                <View
                  className={`h-3 w-3 rounded-full ${
                    server.enabled ? dotClassName[status] : "bg-foreground opacity-20"
                  }`}
                />
                <View className="flex-1">
                  <Text className="text-sm" numberOfLines={1}>
                    {server.url}
                  </Text>
                  <Text className="text-xs opacity-60" testID={`sync-server-status-${server.url}`}>
                    {server.enabled ? statusLabel[status] : t("syncServerStatusDisabled")}
                  </Text>
                </View>
                <Button
                  label={server.enabled ? t("syncServerDisable") : t("syncServerEnable")}
                  variant="secondary"
                  className="px-3 py-2"
                  disabled={busy}
                  testID={`sync-server-toggle-${server.url}`}
                  onPress={() => onToggle(server)}
                />
                <Button
                  label={t("delete")}
                  variant={armedUrl === server.url ? "danger" : "secondary"}
                  className="px-3 py-2"
                  disabled={busy}
                  testID={`sync-server-remove-${server.url}`}
                  onPress={() => onRemove(server.url)}
                />
              </View>
            );
          })
        )}
      </Surface>

      <Surface className="gap-2">
        <Text weight="semibold">{t("addSyncServer")}</Text>
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
          testID="sync-server-url-input"
        />
        {invalidUrl && (
          <Text className="text-sm text-danger" testID="sync-server-invalid-url">
            {t("syncServerInvalidUrl")}
          </Text>
        )}
        <Button
          label={t("addSyncServer")}
          disabled={busy || newUrl.trim() === ""}
          testID="sync-server-add"
          onPress={onAdd}
        />
      </Surface>
    </ScrollView>
  );
}
