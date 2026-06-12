/**
 * AvatarEditor — the PoC's avatar editing surface, extracted from the #17
 * onboarding screen so the profile editor (#30) reuses the exact same
 * controls: the avatar preview, the 8 one-dimension cycle buttons
 * (core `cycleGeneratedAvatar`), the custom-photo upload
 * (expo-image-picker, square 160px JPEG data URL) and the
 * "use generated avatar" escape hatch.
 *
 * Controlled component: the screen owns an {@link AvatarEditorState} and
 * passes `onChange`; `activeAvatarPictureUrl` is the canonical picture URL
 * to persist/publish for the current state.
 */
import type { AvatarEditorControlId, AvatarSelection, GeneratedAvatar } from "@linky/core";
import { cycleGeneratedAvatar, deriveGeneratedAvatar } from "@linky/core";
import type { TranslationKey } from "@linky/locales";
import { Button, Text, colors } from "@linky/ui";
import { Image, Pressable, View } from "react-native";

import { useLocale } from "../locales";
import { toAvatarDisplayUrl } from "../onboarding/avatarDisplay";
import { pickProfilePhoto } from "../onboarding/pickProfilePhoto";

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

export interface AvatarEditorState {
  readonly generated: GeneratedAvatar;
  /** The picked custom photo (JPEG data URL), kept while toggling back and forth. */
  readonly customPhotoUrl: string | null;
  readonly pictureKind: "generated" | "custom";
}

/** Fresh state for a new profile: the deterministic avatar for the npub. */
export const initialAvatarEditorState = (npub: string): AvatarEditorState => ({
  generated: deriveGeneratedAvatar(npub),
  customPhotoUrl: null,
  pictureKind: "generated",
});

/**
 * Resume state from saved/loaded profile values (#30 edit): a stored
 * `avatarSelection` restores the exact generated face; a custom picture
 * stays selected with the generated avatar available behind the toggle.
 */
export const avatarEditorStateFromProfile = (
  npub: string,
  profile: {
    readonly pictureUrl: string;
    readonly pictureKind: "generated" | "custom";
    readonly avatarSelection: AvatarSelection | null;
  },
): AvatarEditorState => ({
  generated:
    profile.avatarSelection !== null
      ? deriveGeneratedAvatar(npub, profile.avatarSelection)
      : deriveGeneratedAvatar(npub),
  customPhotoUrl: profile.pictureKind === "custom" ? profile.pictureUrl : null,
  pictureKind: profile.pictureKind,
});

/** The canonical picture URL for the current state (stored + published). */
export const activeAvatarPictureUrl = (state: AvatarEditorState): string =>
  state.pictureKind === "custom" && state.customPhotoUrl !== null
    ? state.customPhotoUrl
    : state.generated.pictureUrl;

export interface AvatarEditorProps {
  readonly state: AvatarEditorState;
  readonly onChange: (state: AvatarEditorState) => void;
}

export function AvatarEditor({ state, onChange }: AvatarEditorProps) {
  const { t } = useLocale();

  const activeCustomUrl = state.pictureKind === "custom" ? state.customPhotoUrl : null;
  const showCustom = activeCustomUrl !== null;
  const displayUrl = activeCustomUrl ?? toAvatarDisplayUrl(state.generated.pictureUrl);

  const onCycle = (controlId: AvatarEditorControlId) => {
    onChange({
      ...state,
      pictureKind: "generated",
      generated: cycleGeneratedAvatar(state.generated.selection, controlId),
    });
  };

  const onUploadPhoto = () => {
    pickProfilePhoto()
      .then((dataUrl) => {
        if (dataUrl !== null) {
          onChange({ ...state, customPhotoUrl: dataUrl, pictureKind: "custom" });
        }
      })
      .catch(() => {
        // Picker/codec failure — the generated avatar simply stays selected.
      });
  };

  return (
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
          onPress={() => onChange({ ...state, pictureKind: "generated" })}
          hitSlop={8}
          testID="profile-use-generated"
        >
          <Text className="text-primary">{t("profileUseGeneratedAvatar")}</Text>
        </Pressable>
      )}
    </View>
  );
}
