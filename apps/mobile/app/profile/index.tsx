/**
 * Profile view (`profile.view`, #30): own name, avatar, the npub QR — THE
 * main share/copy surface (PoC: the topbar profile button opens exactly
 * this) — and the Lightning address.
 *
 * PoC parity (`ProfilePage` view mode / `ProfileQrModal`): XL avatar, name,
 * a big QR of the plain npub that copies on tap (plus an explicit Copy
 * button — the PoC's copy badge), the ⚡ Lightning address row that copies
 * on tap, the NIP-38 status text, and the exchange-currency preferences.
 * Editing is a pushed screen (PoC `#profile/edit`).
 */
import { parseProfileGeneralStatus } from "@linky/core";
import { Button, Surface, Text, colors } from "@linky/ui";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";

import { QrCode } from "../../src/components/QrCode";
import { useLocale } from "../../src/locales";
import { buildProfileTagUrl } from "../../src/nfc/nfcPayload";
import { cancelNfcSession, writeNfcTagUri } from "../../src/nfc/nfcSession";
import { useNfcSupported } from "../../src/nfc/nfcSupport";
import { toAvatarDisplayUrl } from "../../src/onboarding/avatarDisplay";
import { loadOwnProfile } from "../../src/profile/ownProfile";
import { useOwnProfileVersion } from "../../src/profile/ownProfileStore";
import { useEffectQuery } from "../../src/runtime";
import { copyToClipboard } from "../../src/settings/nostrKeyActions";
import { toast } from "../../src/toast";
import { shortNpub } from "../../src/contacts/contactsListModel";

/** PoC `formatShortLightningAddress`: long local parts get middle-dotted. */
const shortLightningAddress = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  const atIndex = trimmed.indexOf("@");
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    return trimmed.length <= 20 ? trimmed : `${trimmed.slice(0, 10)}...`;
  }
  const localPart = trimmed.slice(0, atIndex);
  const domainPart = trimmed.slice(atIndex);
  if (localPart.length <= 10) return trimmed;
  return `${localPart.slice(0, 10)}...${domainPart}`;
};

export default function ProfileScreen() {
  const { locale, t } = useLocale();
  const router = useRouter();
  const version = useOwnProfileVersion();
  const query = useEffectQuery(loadOwnProfile(locale), [locale, version]);

  const copy = (text: string) => {
    void copyToClipboard(text).then((ok) => {
      if (ok) toast.success(t("copiedToClipboard"));
      else toast.error(t("copyFailed"));
    });
  };

  /** `profile.share-nfc` (#50): gated on device support, like every NFC UI. */
  const nfcSupported = useNfcSupported();
  const [nfcWriting, setNfcWriting] = useState(false);

  /**
   * Writes `nostr://<npub>` as one URI NDEF record (PoC
   * `writeCurrentNpubToNfc` parity) — a tag tap then routes through the
   * #48 contact flow on any Linky phone. Cancel is silent; failures toast.
   */
  const writeProfileTag = async (npub: string) => {
    if (nfcWriting) return;
    const url = buildProfileTagUrl(npub);
    if (url === null) {
      toast.error(t("profileMissingNpub"));
      return;
    }
    setNfcWriting(true);
    try {
      const outcome = await writeNfcTagUri(url, {
        prompt: t("nfcWriteTapPrompt"),
        success: t("nfcWriteProfileSuccess"),
      });
      switch (outcome.kind) {
        case "written":
          toast.success(t("nfcWriteProfileSuccess"));
          return;
        case "cancelled":
          return;
        case "busy":
          toast.error(t("nfcWriteBusy"));
          return;
        case "disabled":
          toast.error(t("nfcWriteDisabled"));
          return;
        case "unavailable":
          toast.error(t("nfcWriteUnsupported"));
          return;
        case "failed":
          toast.error(
            outcome.message === null
              ? t("nfcWriteFailed")
              : `${t("nfcWriteFailed")}: ${outcome.message}`,
          );
          return;
      }
    } finally {
      setNfcWriting(false);
    }
  };

  if (query.status === "loading") {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text className="opacity-70">{t("loadingMore")}</Text>
      </View>
    );
  }

  if (query.status === "error" || query.data === null) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-danger" testID="profile-error">
          {query.status === "error" ? `${t("errorPrefix")}: ${query.error._tag}` : t("profileMissingNpub")}
        </Text>
      </View>
    );
  }

  const profile = query.data;
  const status = parseProfileGeneralStatus(profile.status);

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      <View className="items-center gap-3">
        <Image
          source={{ uri: toAvatarDisplayUrl(profile.pictureUrl) }}
          style={{ width: 120, height: 120, borderRadius: 60, backgroundColor: colors.surface }}
          accessibilityLabel={t("profile")}
          testID="profile-view-avatar"
        />
        <Text weight="bold" className="text-2xl" testID="profile-view-name">
          {profile.name}
        </Text>
        {status.text !== null && (
          <Text className="text-center opacity-70" testID="profile-view-status">
            {status.text}
          </Text>
        )}
      </View>

      {/* THE share surface: big QR of the plain npub; tap = copy (PoC). */}
      <View className="gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("myNpubQr")}
          onPress={() => copy(profile.npub)}
          testID="profile-npub-qr"
        >
          <QrCode value={profile.npub} size={240} />
        </Pressable>
        <Text className="text-center text-sm opacity-70" selectable testID="profile-npub-text">
          {shortNpub(profile.npub)}
        </Text>
        <Button
          label={t("copy")}
          variant="secondary"
          onPress={() => copy(profile.npub)}
          testID="profile-copy-npub"
        />
        {/* profile.share-nfc: rendered ONLY on NFC-capable devices. */}
        {nfcSupported && (
          <Button
            label={t("uploadProfileToNfc")}
            variant="secondary"
            disabled={nfcWriting}
            onPress={() => void writeProfileTag(profile.npub)}
            testID="profile-write-nfc"
          />
        )}
        {/* iOS shows the system NFC sheet; Android writes silently, so
            this inline prompt (with cancel) is its UI. */}
        {nfcWriting && (
          <Surface className="gap-3" testID="profile-nfc-pending">
            <Text className="text-sm opacity-70">{t("nfcWriteTapPrompt")}</Text>
            <Button label={t("cancel")} variant="secondary" onPress={() => cancelNfcSession()} />
          </Surface>
        )}
      </View>

      {profile.lightningAddress !== "" && (
        <Surface className="gap-1">
          <Text weight="semibold">{t("lightningAddress")}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("lightningAddress")}
            onPress={() => copy(profile.lightningAddress)}
            className="flex-row items-center gap-2 active:opacity-70"
            testID="profile-ln-address"
          >
            <Text>⚡️</Text>
            <Text className="shrink text-sm opacity-80">
              {shortLightningAddress(profile.lightningAddress)}
            </Text>
            <Text className="opacity-50">⧉</Text>
          </Pressable>
        </Surface>
      )}

      {status.currencies.length > 0 && (
        <Surface className="gap-2">
          <Text className="text-sm opacity-70">{t("profileExchangeStatusLabel")}</Text>
          <View className="flex-row gap-2" testID="profile-view-currencies">
            {status.currencies.map((currency) => (
              <View key={currency} className="rounded-full bg-surface px-3 py-1">
                <Text className="text-sm text-primary">{currency}</Text>
              </View>
            ))}
          </View>
        </Surface>
      )}

      <Button
        label={t("edit")}
        onPress={() => router.push("/profile/edit")}
        testID="profile-edit"
      />
    </ScrollView>
  );
}
