/**
 * Onboarding step 3 (`onboarding.setup-profile` + `onboarding.customize-avatar`):
 * name + avatar before app entry.
 *
 * PoC parity: the name is pre-filled deterministically from the npub per
 * selected language, the avatar is the deterministic DiceBear avataaars
 * derived from the npub, and each of the 8 editor controls cycles ONE
 * dimension (core `cycleGeneratedAvatar`). A custom photo (expo-image-picker,
 * square-cropped to 160px JPEG data URL like the PoC) is optional.
 *
 * Confirm persists the profile locally and publishes the initial metadata
 * through the ProfilePublisher port — a logged no-op Layer until #24.
 */
import type { AvatarEditorControlId, LocalProfile } from "@linky/core";
import {
  completeProfileSetup,
  cycleGeneratedAvatar,
  deriveDefaultLightningAddress,
  deriveGeneratedAvatar,
  pickDeterministicName,
} from "@linky/core";
import type { TranslationKey } from "@linky/locales";
import { Button, Surface, Text, colors } from "@linky/ui";
import { Redirect, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Image, Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useLocale } from "../../src/locales";
import { toAvatarDisplayUrl } from "../../src/onboarding/avatarDisplay";
import { pickProfilePhoto } from "../../src/onboarding/pickProfilePhoto";
import { useEffectMutation } from "../../src/runtime";
import { useSession } from "../../src/session/useSession";

/** The PoC's 8 avatar editor controls: same icons, localized a11y labels. */
const AVATAR_CONTROLS = [
  { id: "top", icon: "💇", labelKey: "onboardingAvatarControlTop" },
  { id: "hairColor", icon: "🎨", labelKey: "onboardingAvatarControlHairColor" },
  { id: "accessories", icon: "🕶️", labelKey: "onboardingAvatarControlAccessories" },
  { id: "face", icon: "👀", labelKey: "onboardingAvatarControlFace" },
  { id: "mouth", icon: "👄", labelKey: "onboardingAvatarControlMouth" },
  { id: "facialHair", icon: "🧔", labelKey: "onboardingAvatarControlFacialHair" },
  { id: "skin", icon: "🟤", labelKey: "onboardingAvatarControlSkin" },
  { id: "clothing", icon: "👕", labelKey: "onboardingAvatarControlClothing" },
] as const satisfies ReadonlyArray<{
  readonly id: AvatarEditorControlId;
  readonly icon: string;
  readonly labelKey: TranslationKey;
}>;

function ProfileSetupForm({ npub }: { readonly npub: string }) {
  const { locale, t } = useLocale();
  const router = useRouter();

  // Deterministic defaults, PoC-identical: name per language, avatar per npub.
  const [name, setName] = useState(() => pickDeterministicName(npub, locale));
  const [generated, setGenerated] = useState(() => deriveGeneratedAvatar(npub));
  const [customPhotoUrl, setCustomPhotoUrl] = useState<string | null>(null);
  const [pictureKind, setPictureKind] = useState<"generated" | "custom">("generated");
  const [nameMissing, setNameMissing] = useState(false);

  const confirm = useEffectMutation((profile: LocalProfile) => completeProfileSetup(profile));
  const { status } = confirm.state;

  useEffect(() => {
    if (status === "success") {
      router.replace("/onboarding/backup");
    }
  }, [status, router]);

  // Non-null exactly when the custom photo is the active picture.
  const activeCustomUrl = pictureKind === "custom" ? customPhotoUrl : null;
  const showCustom = activeCustomUrl !== null;
  const displayUrl = activeCustomUrl ?? toAvatarDisplayUrl(generated.pictureUrl);

  const onCycle = (controlId: AvatarEditorControlId) => {
    setPictureKind("generated");
    setGenerated((current) => cycleGeneratedAvatar(current.selection, controlId));
  };

  const onUploadPhoto = () => {
    pickProfilePhoto()
      .then((dataUrl) => {
        if (dataUrl !== null) {
          setCustomPhotoUrl(dataUrl);
          setPictureKind("custom");
        }
      })
      .catch(() => {
        // Picker/codec failure — the generated avatar simply stays selected.
      });
  };

  const onConfirm = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setNameMissing(true);
      return;
    }
    setNameMissing(false);
    confirm.mutate({
      name: trimmed,
      pictureUrl: activeCustomUrl ?? generated.pictureUrl,
      pictureKind: activeCustomUrl !== null ? "custom" : "generated",
      avatarSelection: generated.selection,
      lightningAddress: deriveDefaultLightningAddress(npub),
    });
  };

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-6 px-6 py-8"
      keyboardShouldPersistTaps="handled"
    >
      <View className="gap-2">
        <Text weight="bold" className="text-3xl">
          {t("onboardingAvatarTitle")}
        </Text>
        <Text className="opacity-70">{t("onboardingAvatarIntro")}</Text>
      </View>

      <View className="items-center gap-4">
        <Image
          source={{ uri: displayUrl }}
          style={{ width: 160, height: 160, borderRadius: 80, backgroundColor: colors.surface }}
          accessibilityLabel={t("onboardingAvatarTitle")}
          testID="profile-avatar"
        />
        <View
          className="flex-row flex-wrap justify-center gap-3"
          accessibilityLabel={t("onboardingAvatarGridLabel")}
          testID="profile-avatar-controls"
        >
          {AVATAR_CONTROLS.map((control) => (
            <Pressable
              key={control.id}
              accessibilityRole="button"
              accessibilityLabel={t(control.labelKey)}
              onPress={() => onCycle(control.id)}
              className="h-12 w-12 items-center justify-center rounded-xl bg-surface active:opacity-70"
              testID={`avatar-control-${control.id}`}
            >
              <Text className="text-xl">{control.icon}</Text>
            </Pressable>
          ))}
        </View>
        <Button
          label={t("profileUploadPhoto")}
          variant="secondary"
          onPress={onUploadPhoto}
          testID="profile-upload-photo"
        />
        {showCustom && (
          <Pressable
            accessibilityRole="button"
            onPress={() => setPictureKind("generated")}
            hitSlop={8}
            testID="profile-use-generated"
          >
            <Text className="text-primary">{t("profileUseGeneratedAvatar")}</Text>
          </Pressable>
        )}
      </View>

      <Surface className="gap-2">
        <Text weight="semibold">{t("name")}</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={t("namePlaceholder")}
          placeholderTextColor={colors.foreground + "66"}
          className="rounded-xl bg-background px-4 py-3 font-sans text-base text-foreground"
          autoCapitalize="words"
          autoCorrect={false}
          testID="profile-name-input"
        />
        {nameMissing && (
          <Text className="text-sm text-danger" testID="profile-name-required">
            {t("onboardingNameRequired")}
          </Text>
        )}
      </Surface>

      {confirm.state.status === "error" && (
        <Text className="text-danger" testID="profile-confirm-error">
          {t("errorPrefix")}: {confirm.state.error._tag}
        </Text>
      )}

      <Button
        label={t("onboardingConfirmProfile")}
        disabled={status === "pending" || status === "success"}
        onPress={onConfirm}
        testID="profile-confirm"
      />
    </ScrollView>
  );
}

export default function ProfileSetupScreen() {
  const session = useSession();

  if (session.status === "loading") return null;
  if (session.status === "error" || session.data._tag === "NoIdentity") {
    // No identity to set a profile for — back to the start of onboarding.
    return <Redirect href="/onboarding" />;
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ProfileSetupForm npub={session.data.session.nostr.npub} />
    </SafeAreaView>
  );
}
