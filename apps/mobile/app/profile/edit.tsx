/**
 * Profile editor (`profile.edit`, #30): name, avatar (shared AvatarEditor
 * from #17), Lightning address, NIP-38 status text + exchange-currency
 * preferences (the PoC exposes the currency chips on the profile surface;
 * here they save with the form in ONE publish pass).
 *
 * SAVE runs core `saveProfileEdits`: local persistence (#17 storage) +
 * kind 0 via ProfilePublisher (#24) + kind 30315 NIP-38 status. Offline is
 * success (events queue and flush on reconnect), so the toast simply says
 * saved.
 *
 * `profile.restore-default-ln`: the "use default" affordance appears only
 * when the address was overridden AND no paid alias exists
 * (core `canRestoreDefaultLightningAddress`; aliases are structurally empty
 * until #61).
 */
import type { ProfileEdits, ProfileStatusCurrency } from "@linky/core";
import {
  PROFILE_STATUS_CURRENCIES,
  buildProfileGeneralStatus,
  canRestoreDefaultLightningAddress,
  deriveDefaultLightningAddress,
  parseProfileGeneralStatus,
} from "@linky/core";
import { Button, Surface, Text, colors } from "@linky/ui";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { useLocale } from "../../src/locales";
import {
  AvatarEditor,
  activeAvatarPictureUrl,
  avatarEditorStateFromProfile,
} from "../../src/profile/AvatarEditor";
import type { OwnProfile } from "../../src/profile/ownProfile";
import {
  loadOwnProfile,
  loadOwnedLightningAliases,
  saveOwnProfile,
} from "../../src/profile/ownProfile";
import { useEffectMutation, useEffectQuery } from "../../src/runtime";
import { toast } from "../../src/toast";

function ProfileEditForm({ initial }: { readonly initial: OwnProfile }) {
  const { t } = useLocale();
  const router = useRouter();
  const initialStatus = parseProfileGeneralStatus(initial.status);

  const [name, setName] = useState(initial.name);
  const [avatar, setAvatar] = useState(() => avatarEditorStateFromProfile(initial.npub, initial));
  const [lnAddress, setLnAddress] = useState(initial.lightningAddress);
  const [statusText, setStatusText] = useState(initialStatus.text ?? "");
  const [currencies, setCurrencies] = useState<ReadonlyArray<ProfileStatusCurrency>>(
    initialStatus.currencies,
  );
  const [nameMissing, setNameMissing] = useState(false);

  const aliases = useEffectQuery(loadOwnedLightningAliases);
  // TODO(#61): once aliases can be owned, this hides the restore affordance.
  const ownedAliases = aliases.status === "success" ? aliases.data : [];
  const showRestoreDefault = canRestoreDefaultLightningAddress({
    npub: initial.npub,
    currentAddress: lnAddress,
    ownedAliases,
  });

  const save = useEffectMutation((edits: ProfileEdits) => saveOwnProfile(edits));
  const { status: saveStatus } = save.state;

  useEffect(() => {
    if (saveStatus === "success") {
      toast.success(t("profileSaved"));
      router.back();
    }
  }, [saveStatus, router, t]);

  const toggleCurrency = (currency: ProfileStatusCurrency) => {
    setCurrencies((current) =>
      current.includes(currency)
        ? current.filter((value) => value !== currency)
        : [...current, currency],
    );
  };

  const onSave = () => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setNameMissing(true);
      return;
    }
    setNameMissing(false);
    const usesCustomPhoto = avatar.pictureKind === "custom" && avatar.customPhotoUrl !== null;
    save.mutate({
      profile: {
        name: trimmedName,
        pictureUrl: activeAvatarPictureUrl(avatar),
        pictureKind: usesCustomPhoto ? "custom" : "generated",
        avatarSelection: avatar.generated.selection,
        lightningAddress: lnAddress.trim(),
        status: buildProfileGeneralStatus({ currencies, text: statusText }),
      },
    });
  };

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-4 px-6 pb-8 pt-4"
      keyboardShouldPersistTaps="handled"
    >
      <AvatarEditor state={avatar} onChange={setAvatar} />

      <Surface className="gap-2">
        <Text weight="semibold">{t("name")}</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={t("name")}
          placeholderTextColor={colors.foreground + "66"}
          className="rounded-xl bg-background px-4 py-3 font-sans text-base text-foreground"
          autoCapitalize="words"
          autoCorrect={false}
          testID="profile-edit-name"
        />
        {nameMissing && (
          <Text className="text-sm text-danger" testID="profile-edit-name-required">
            {t("onboardingNameRequired")}
          </Text>
        )}
      </Surface>

      <Surface className="gap-2">
        <View className="flex-row items-center justify-between">
          <Text weight="semibold">{t("lightningAddress")}</Text>
          {showRestoreDefault && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("profileUseDefault")}
              hitSlop={8}
              onPress={() => setLnAddress(deriveDefaultLightningAddress(initial.npub))}
              testID="profile-restore-default-ln"
            >
              <Text className="text-primary">↺ {t("profileUseDefault")}</Text>
            </Pressable>
          )}
        </View>
        <TextInput
          value={lnAddress}
          onChangeText={setLnAddress}
          placeholder={t("lightningAddress")}
          placeholderTextColor={colors.foreground + "66"}
          className="rounded-xl bg-background px-4 py-3 font-sans text-base text-foreground"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          testID="profile-edit-ln-address"
        />
      </Surface>

      <Surface className="gap-2">
        <Text weight="semibold">{t("status")}</Text>
        <TextInput
          value={statusText}
          onChangeText={setStatusText}
          placeholder={t("profileStatusPlaceholder")}
          placeholderTextColor={colors.foreground + "66"}
          className="rounded-xl bg-background px-4 py-3 font-sans text-base text-foreground"
          testID="profile-edit-status"
        />
      </Surface>

      <Surface className="gap-2">
        <Text className="text-sm opacity-70">{t("profileExchangeStatusLabel")}</Text>
        <View className="flex-row gap-2" testID="profile-edit-currencies">
          {PROFILE_STATUS_CURRENCIES.map((currency) => {
            const isActive = currencies.includes(currency);
            return (
              <Pressable
                key={currency}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
                onPress={() => toggleCurrency(currency)}
                className={
                  isActive
                    ? "rounded-full bg-primary px-4 py-2"
                    : "rounded-full bg-background px-4 py-2"
                }
                testID={`profile-currency-${currency}`}
              >
                <Text
                  weight="semibold"
                  className={isActive ? "text-sm text-primary-foreground" : "text-sm opacity-70"}
                >
                  {currency}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Surface>

      {save.state.status === "error" && (
        <Text className="text-danger" testID="profile-save-error">
          {t("errorPrefix")}: {save.state.error._tag}
        </Text>
      )}

      <Button
        label={t("saveChanges")}
        disabled={saveStatus === "pending" || saveStatus === "success"}
        onPress={onSave}
        testID="profile-save"
      />
    </ScrollView>
  );
}

export default function ProfileEditScreen() {
  const { locale, t } = useLocale();
  // No version dep on purpose: the form initializes ONCE from the loaded
  // values; saving navigates back (the view re-reads via the version store).
  const query = useEffectQuery(loadOwnProfile(locale), [locale]);

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
        <Text className="text-danger">
          {query.status === "error"
            ? `${t("errorPrefix")}: ${query.error._tag}`
            : t("profileMissingNpub")}
        </Text>
      </View>
    );
  }

  return <ProfileEditForm initial={query.data} />;
}
