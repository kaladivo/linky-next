/**
 * Onboarding step 3 (`onboarding.setup-profile` + `onboarding.customize-avatar`):
 * name + avatar before app entry.
 *
 * PoC parity: the name is pre-filled deterministically from the npub per
 * selected language, the avatar is the deterministic DiceBear avataaars
 * derived from the npub, and each of the 8 editor controls cycles ONE
 * dimension. The avatar surface itself (controls, custom photo, toggle) is
 * the shared `AvatarEditor` (src/profile), also used by the profile editor
 * (#30).
 *
 * Confirm persists the profile locally and publishes the initial metadata
 * through the ProfilePublisher port (#24).
 */
import type { LocalProfile } from "@linky/core";
import {
  completeProfileSetup,
  deriveDefaultLightningAddress,
  pickDeterministicName,
} from "@linky/core";
import { Button, Surface, Text, colors } from "@linky/ui";
import { Redirect, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useLocale } from "../../src/locales";
import {
  AvatarEditor,
  activeAvatarPictureUrl,
  initialAvatarEditorState,
} from "../../src/profile/AvatarEditor";
import { invalidateOwnProfile } from "../../src/profile/ownProfileStore";
import { useEffectMutation } from "../../src/runtime";
import { useSession } from "../../src/session/useSession";

function ProfileSetupForm({ npub }: { readonly npub: string }) {
  const { locale, t } = useLocale();
  const router = useRouter();

  // Deterministic defaults, PoC-identical: name per language, avatar per npub.
  const [name, setName] = useState(() => pickDeterministicName(npub, locale));
  const [avatar, setAvatar] = useState(() => initialAvatarEditorState(npub));
  const [nameMissing, setNameMissing] = useState(false);

  const confirm = useEffectMutation((profile: LocalProfile) => completeProfileSetup(profile));
  const { status } = confirm.state;

  useEffect(() => {
    if (status === "success") {
      invalidateOwnProfile();
      router.replace("/onboarding/backup");
    }
  }, [status, router]);

  const onConfirm = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setNameMissing(true);
      return;
    }
    setNameMissing(false);
    confirm.mutate({
      name: trimmed,
      pictureUrl: activeAvatarPictureUrl(avatar),
      pictureKind: avatar.pictureKind === "custom" && avatar.customPhotoUrl !== null
        ? "custom"
        : "generated",
      avatarSelection: avatar.generated.selection,
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

      <AvatarEditor state={avatar} onChange={setAvatar} />

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
