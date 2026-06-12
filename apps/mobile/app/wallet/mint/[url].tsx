/**
 * Mint detail (#41, `mints.fetch-info` / `mints.refresh-delete`): cached
 * NUT-06 info (name, icon, fees), reachability + latency from the runtime
 * store, manual refresh, set-as-main, and the armed two-tap delete.
 *
 * Delete contract: removal is explicit and never silently strands
 * spendable funds — when the mint still holds spendable sat the armed hint
 * carries the amount and says tokens are NOT deleted nor moved. (The PoC
 * deletes without any funds warning; the guard is a rewrite contract.)
 */
import { Button, Surface, Text } from "@linky/ui";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Image, ScrollView, View } from "react-native";

import { useLocale } from "../../../src/locales";
import { useEffectQuery } from "../../../src/runtime";
import { getStoreDataVersion, subscribeToStoreData } from "../../../src/store/storeManager";
import {
  loadMintDetail,
  refreshMint,
  removeMint,
  selectMainMint,
  spendableSatOnMint,
} from "../../../src/wallet/mintActions";
import {
  getMintRuntime,
  getMintRuntimeVersion,
  subscribeMintRuntime,
} from "../../../src/wallet/mintRuntimeStore";
import { toast } from "../../../src/toast";

const ARM_TIMEOUT_MS = 5000;

function InfoRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View className="flex-row items-baseline justify-between gap-3">
      <Text className="text-sm opacity-70">{label}</Text>
      <Text className="shrink text-sm" numberOfLines={2} testID={`mint-info-${label}`}>
        {value}
      </Text>
    </View>
  );
}

export default function MintDetailScreen() {
  const { t, locale } = useLocale();
  const router = useRouter();
  const params = useLocalSearchParams<{ url: string }>();
  const mintUrl = decodeURIComponent(String(params.url ?? ""));

  const dataVersion = useSyncExternalStore(subscribeToStoreData, getStoreDataVersion);
  const detailQuery = useEffectQuery(loadMintDetail(mintUrl), [mintUrl, dataVersion]);
  const runtimeVersion = useSyncExternalStore(subscribeMintRuntime, getMintRuntimeVersion);

  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (armTimer.current !== null) clearTimeout(armTimer.current);
    },
    [],
  );

  const detail = detailQuery.status === "success" ? detailQuery.data : null;
  const runtime = getMintRuntime(mintUrl);
  void runtimeVersion; // subscription dependency

  const onRefresh = async () => {
    setBusy(true);
    try {
      const outcome = await refreshMint(mintUrl);
      if (outcome === "refreshed") toast.success(t("mintInfoRefreshed"));
      else toast.error(t("mintRefreshFailed"));
    } finally {
      setBusy(false);
    }
  };

  const onSetMain = async () => {
    setBusy(true);
    toast.info(t("mintUpdating"));
    try {
      const outcome = await selectMainMint(mintUrl);
      if (outcome === "saved") toast.success(t("mintSaved"));
      else if (outcome === "invalid") toast.error(t("mintUrlInvalid"));
      else toast.error(t("mintUpdateFailed"));
    } finally {
      setBusy(false);
    }
  };

  /** Armed two-tap delete; the funds warning is part of the arming step. */
  const onDelete = async () => {
    if (!armed) {
      const spendable = await spendableSatOnMint(mintUrl);
      if (spendable > 0) {
        // Never silently strand spendable funds (feature-map contract).
        Alert.alert(
          t("mintDelete"),
          `${t("mintDeleteHasFunds", { amount: spendable })}\n\n${t("deleteArmedHint")}`,
        );
      } else {
        toast.info(t("deleteArmedHint"));
      }
      setArmed(true);
      if (armTimer.current !== null) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), ARM_TIMEOUT_MS);
      return;
    }
    if (armTimer.current !== null) clearTimeout(armTimer.current);
    setArmed(false);
    setBusy(true);
    try {
      await removeMint(mintUrl);
      toast.success(t("mintDeleted"));
      router.back();
    } finally {
      setBusy(false);
    }
  };

  if (detailQuery.status === "success" && detail === null) {
    return (
      <ScrollView className="flex-1 bg-background" contentContainerClassName="px-6 pt-4">
        <Text className="opacity-70">{t("mintNotFound")}</Text>
      </ScrollView>
    );
  }

  // Reachability + latency collapse into one display value (PoC shows
  // latency ms or "Unknown"; we add the explicit unreachable state).
  const latencyText =
    runtime.status === "checking"
      ? t("mintStatusChecking")
      : runtime.status === "reachable"
        ? `${String(runtime.latencyMs)} ms (${t("mintStatusReachable")})`
        : runtime.status === "unreachable"
          ? t("mintStatusUnreachable")
          : t("unknown");

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      <Surface className="gap-3" testID="mint-detail">
        <View className="flex-row items-center gap-3">
          {detail?.iconUrl != null && (
            <Image
              source={{ uri: detail.iconUrl }}
              className="h-10 w-10 rounded-full bg-surface"
              testID="mint-icon"
            />
          )}
          <View className="flex-1">
            <Text weight="semibold" className="text-lg" numberOfLines={1}>
              {detail?.name ?? detail?.displayName ?? "…"}
            </Text>
            <View className="flex-row gap-2">
              {detail?.isMain === true && (
                <Text className="rounded-full bg-primary px-2 text-xs text-background">
                  {t("mintMainBadge")}
                </Text>
              )}
              {detail?.isTest === true && (
                <Text className="rounded-full bg-surface px-2 text-xs opacity-70">
                  {t("testMintBadge")}
                </Text>
              )}
            </View>
          </View>
        </View>

        <InfoRow label={t("mintUrl")} value={detail?.url ?? mintUrl} />
        <InfoRow
          label={t("mintFees")}
          value={
            detail?.feePpk != null
              ? `ppk: ${String(detail.feePpk)}`
              : (detail?.feesJson ?? t("unknown"))
          }
        />
        <InfoRow label={t("mintLatency")} value={latencyText} />
        <InfoRow
          label={t("mintLastChecked")}
          value={
            detail?.infoFetchedAtSec != null
              ? new Date(detail.infoFetchedAtSec * 1000).toLocaleString(
                  locale === "cs" ? "cs-CZ" : "en-US",
                )
              : t("unknown")
          }
        />
        {detail !== null && detail.spendableSat > 0 && (
          <InfoRow label={t("mintSpendableHere")} value={`${String(detail.spendableSat)} sat`} />
        )}
        {detail?.isTest === true && (
          <Text className="text-sm text-danger">{t("mintTestFundsNote")}</Text>
        )}
      </Surface>

      {detail !== null && !detail.isMain && (
        <Button
          label={t("mintSetMain")}
          disabled={busy}
          testID="mint-set-main"
          onPress={() => void onSetMain()}
        />
      )}
      <Button
        label={t("mintRefresh")}
        variant="secondary"
        disabled={busy}
        testID="mint-refresh"
        onPress={() => void onRefresh()}
      />
      <Button
        label={t("mintDelete")}
        variant={armed ? "danger" : "secondary"}
        disabled={busy}
        testID="mint-delete"
        onPress={() => void onDelete()}
      />
    </ScrollView>
  );
}
