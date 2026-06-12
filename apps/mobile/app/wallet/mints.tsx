/**
 * Mint settings (#41): main-mint selection, presets with test mints
 * visibly separated, custom mint entry, and the known-mint list.
 *
 * Mirrors the PoC MintsPage: preset buttons select the main mint, the
 * custom-URL save runs the same selection flow, known mints navigate to the
 * detail screen. `mints.select-main` order: validate → optional
 * consolidation warning → hosted npub.cash sync → persist locally
 * (mintActions.selectMainMint enforces the sync-then-persist half).
 *
 * PoC divergence (documented): the PoC's pre-change warning is about
 * AUTOSWAP (which the rewrite does not have yet); here the warning tells
 * the user their spendable funds STAY on the current mint — same decision
 * point, adapted copy.
 */
import { Button, Surface, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, ScrollView, TextInput, View } from "react-native";

import { useTranslator } from "../../src/locales";
import { useEffectQuery } from "../../src/runtime";
import { getStoreDataVersion, subscribeToStoreData } from "../../src/store/storeManager";
import type { MintListEntry, MintsData } from "../../src/wallet/mintActions";
import {
  loadMintsData,
  refreshStaleMints,
  selectMainMint,
} from "../../src/wallet/mintActions";
import { toast } from "../../src/toast";

/** One selectable mint row: tap = select main, chevron = detail. */
function MintRow({
  entry,
  busy,
  onSelect,
  onDetail,
  t,
}: {
  readonly entry: MintListEntry;
  readonly busy: boolean;
  readonly onSelect: (entry: MintListEntry) => void;
  readonly onDetail: (entry: MintListEntry) => void;
  readonly t: ReturnType<typeof useTranslator>;
}) {
  return (
    <View className="flex-row items-center gap-3" testID={`mint-row-${entry.url}`}>
      <Pressable
        accessibilityRole="button"
        className={`flex-1 rounded-xl border px-4 py-3 ${
          entry.isMain ? "border-primary" : "border-surface"
        }`}
        disabled={busy}
        onPress={() => onSelect(entry)}
        testID={`mint-select-${entry.url}`}
      >
        <View className="flex-row items-center gap-2">
          <Text weight="semibold" className="shrink" numberOfLines={1}>
            {entry.name ?? entry.displayName}
          </Text>
          {entry.isMain && (
            <Text className="rounded-full bg-primary px-2 text-xs text-background">
              {t("mintMainBadge")}
            </Text>
          )}
          {entry.isTest && (
            <Text className="rounded-full bg-surface px-2 text-xs opacity-70">
              {t("testMintBadge")}
            </Text>
          )}
        </View>
        <Text className="text-xs opacity-60" numberOfLines={1}>
          {entry.url}
        </Text>
        {entry.spendableSat > 0 && (
          <Text className="text-xs opacity-70">
            {t("mintSpendableHere")}: {entry.spendableSat} sat
          </Text>
        )}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => onDetail(entry)}
        testID={`mint-detail-${entry.url}`}
        className="px-1 py-3"
      >
        <Text className="text-xl opacity-60">›</Text>
      </Pressable>
    </View>
  );
}

export default function MintsScreen() {
  const t = useTranslator();
  const router = useRouter();
  const dataVersion = useSyncExternalStore(subscribeToStoreData, getStoreDataVersion);
  const mintsQuery = useEffectQuery(loadMintsData, [dataVersion]);
  const [busy, setBusy] = useState(false);
  const [customUrl, setCustomUrl] = useState("");

  const data: MintsData | null = mintsQuery.status === "success" ? mintsQuery.data : null;

  // Background info refresh for stale mints (`mints.fetch-info`).
  useEffect(() => {
    if (data === null) return;
    void refreshStaleMints([...data.regularMints, ...data.testMints]);
  }, [data]);

  /** Optional consolidation warning, then hosted-sync-then-persist. */
  const applySelection = useCallback(
    async (url: string) => {
      if (data === null || busy) return;
      const current = [...data.regularMints, ...data.testMints].find((entry) => entry.isMain);
      if (current !== undefined && current.url === url) return;

      // Optional consolidation warning (`mints.select-main` flow): the
      // current main still holds spendable funds that will NOT move.
      if (current !== undefined && current.spendableSat > 0) {
        const confirmed = await new Promise<boolean>((resolve) => {
          Alert.alert(
            t("mintChangeKeepsFundsTitle"),
            t("mintChangeKeepsFundsBody", {
              amount: current.spendableSat,
              fromMint: current.displayName,
            }),
            [
              { text: t("cancel"), style: "cancel", onPress: () => resolve(false) },
              { text: t("mintAutoswapChangeWarningKeep"), onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          );
        });
        if (!confirmed) return;
      }

      setBusy(true);
      toast.info(t("mintUpdating"));
      try {
        const outcome = await selectMainMint(url);
        if (outcome === "saved") {
          setCustomUrl("");
          toast.success(t("mintSaved"));
        } else if (outcome === "invalid") {
          toast.error(t("mintUrlInvalid"));
        } else if (outcome === "no-session") {
          toast.error(t("profileMissingNpub"));
        } else {
          toast.error(t("mintUpdateFailed"));
        }
      } catch {
        toast.error(t("mintUpdateFailed"));
      } finally {
        setBusy(false);
      }
    },
    [busy, data, t],
  );

  const openDetail = useCallback(
    (entry: MintListEntry) => {
      router.push(`/wallet/mint/${encodeURIComponent(entry.url)}`);
    },
    [router],
  );

  const mainEntry =
    data === null
      ? null
      : ([...data.regularMints, ...data.testMints].find((entry) => entry.isMain) ?? null);

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      {/* Selected main mint (`mints.select-main`). */}
      <Surface className="gap-1" testID="mint-selected">
        <Text weight="semibold" className="text-primary">
          {t("selectedMint")}
        </Text>
        {mainEntry === null ? (
          <Text className="text-sm opacity-70">…</Text>
        ) : (
          <>
            <Text weight="semibold">{mainEntry.name ?? mainEntry.displayName}</Text>
            <Text className="text-xs opacity-60">{mainEntry.url}</Text>
            {/* A selected test mint is loudly NOT real funds (contract). */}
            {mainEntry.isTest && (
              <Text className="text-sm text-danger" testID="mint-test-funds-note">
                {t("mintTestFundsNote")}
              </Text>
            )}
          </>
        )}
      </Surface>

      {/* Presets (`mints.presets`) — regular first… (hidden when the
          profile's presets are test mints only, e.g. development). */}
      {(data === null || data.regularMints.some((entry) => entry.isPreset)) && (
        <Surface className="gap-3" testID="mint-presets">
          <Text weight="semibold" className="text-primary">
            {t("mintPresetsTitle")}
          </Text>
          {data === null ? (
            <Text className="text-sm opacity-70">…</Text>
          ) : (
            data.regularMints
              .filter((entry) => entry.isPreset)
              .map((entry) => (
                <MintRow
                  key={entry.url}
                  entry={entry}
                  busy={busy}
                  onSelect={(item) => void applySelection(item.url)}
                  onDetail={openDetail}
                  t={t}
                />
              ))
          )}
        </Surface>
      )}

      {/* …test mints visibly separated (`mints.presets` contract). */}
      {data !== null && data.testMints.length > 0 && (
        <Surface className="gap-3 border-l-4 border-l-danger" testID="mint-test-group">
          <View className="flex-row items-center gap-2">
            <Text weight="semibold" className="text-primary">
              {t("mintTestGroupTitle")}
            </Text>
            <Text className="rounded-full bg-surface px-2 text-xs opacity-70">
              {t("testMintBadge")}
            </Text>
          </View>
          {data.testMints.map((entry) => (
            <MintRow
              key={entry.url}
              entry={entry}
              busy={busy}
              onSelect={(item) => void applySelection(item.url)}
              onDetail={openDetail}
              t={t}
            />
          ))}
        </Surface>
      )}

      {/* Custom mint (`mints.add-custom`): same selection flow as the PoC. */}
      <Surface className="gap-2" testID="mint-custom">
        <Text weight="semibold">{t("setCustomMint")}</Text>
        <TextInput
          className="rounded-xl border border-surface bg-background px-4 py-3 text-foreground"
          placeholder="https://…"
          placeholderTextColor="#64748b"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          keyboardType="url"
          value={customUrl}
          onChangeText={setCustomUrl}
          onSubmitEditing={() => void applySelection(customUrl)}
          testID="mint-custom-input"
        />
        <Button
          label={t("setCustomMint")}
          disabled={busy || customUrl.trim() === ""}
          testID="mint-custom-save"
          onPress={() => void applySelection(customUrl)}
        />
      </Surface>

      {/* Known mints (cashuMint rows) → detail (`mints.refresh-delete`). */}
      <Surface className="gap-3" testID="mint-known">
        <Text weight="semibold" className="text-primary">
          {t("mintKnownTitle")}
        </Text>
        {data === null ? (
          <Text className="text-sm opacity-70">…</Text>
        ) : (
          (() => {
            const known = [...data.regularMints, ...data.testMints].filter(
              (entry) => !entry.isPreset,
            );
            if (known.length === 0) {
              return <Text className="text-sm opacity-70">{t("mintsEmpty")}</Text>;
            }
            return known.map((entry) => (
              <MintRow
                key={entry.url}
                entry={entry}
                busy={busy}
                onSelect={(item) => void applySelection(item.url)}
                onDetail={openDetail}
                t={t}
              />
            ));
          })()
        )}
      </Surface>
    </ScrollView>
  );
}
