/**
 * Main surfaces (shell.contacts-wallet-tabs): Contacts and Wallet as
 * material top tabs rendered at the BOTTOM via expo-router's built-in
 * `TopTabs` (expo-router/js-top-tabs — SDK 56 vendors material-top-tabs;
 * importing @react-navigation/* directly is a bundler error). This gives
 * the PoC behavior — bottom tab bar + horizontal swipe between the two
 * surfaces (react-native-pager-view) — while each surface keeps its own
 * Expo Router URL ("/" and "/wallet").
 *
 * Settings is deliberately NOT a tab: the PoC bottom nav has only
 * Contacts/Wallet, with settings behind the header menu (☰). Here the
 * header menu glyph pushes the /settings stack screen.
 */
import { loadLocalProfile } from "@linky/core";
import { colors, fontFamily, Text } from "@linky/ui";
import { Option } from "effect";
import { Link, Redirect } from "expo-router";
import { TopTabs } from "expo-router/js-top-tabs";
import { useEffect } from "react";
import { Image, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTranslator } from "../../src/locales";
import { toAvatarDisplayUrl } from "../../src/onboarding/avatarDisplay";
import { useOwnProfileVersion } from "../../src/profile/ownProfileStore";
import { useEffectQuery } from "../../src/runtime";
import { useSession } from "../../src/session/useSession";
import { ensureStoreForSession } from "../../src/store/storeManager";

/**
 * Own avatar opening the profile screen (#30) — the PoC's top-left topbar
 * profile button. Reads ONLY the local profile (no relay hit in the shell
 * header); a generic glyph covers the restored-account-without-local-profile
 * case until the first profile save.
 */
function ProfileButton() {
  const t = useTranslator();
  const version = useOwnProfileVersion();
  const profileQuery = useEffectQuery(loadLocalProfile, [version]);
  const pictureUrl =
    profileQuery.status === "success" ? Option.getOrNull(profileQuery.data)?.pictureUrl : null;

  return (
    <Link href="/profile" asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("profile")}
        hitSlop={8}
        testID="open-profile"
      >
        {pictureUrl != null ? (
          <Image
            source={{ uri: toAvatarDisplayUrl(pictureUrl, 96) }}
            style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface }}
          />
        ) : (
          <Text className="text-2xl leading-8">👤</Text>
        )}
      </Pressable>
    </Link>
  );
}

/** Profile button + app title + menu glyph (PoC's topbar: profile left, ☰ right). */
function ShellHeader() {
  const t = useTranslator();
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-row items-center justify-between px-6 pb-1"
      style={{ paddingTop: insets.top + 4 }}
    >
      <View className="flex-row items-center gap-3">
        <ProfileButton />
        <Text weight="bold" className="text-2xl">
          {t("appTitle")}
        </Text>
      </View>
      <Link href="/settings" asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings")}
          hitSlop={12}
          testID="open-settings"
        >
          <Text className="text-2xl leading-7">☰</Text>
        </Pressable>
      </Link>
    </View>
  );
}

export default function TabsLayout() {
  const t = useTranslator();
  const insets = useSafeAreaInsets();
  const session = useSession();

  /**
   * Session-scoped store boot (#26): as soon as an identity is loaded, the
   * gate boots the Linky Evolu store for it (idempotent per identity; a
   * relaunch reattaches to the same per-identity database). Teardown is
   * logout's job (src/session/sessionActions.ts).
   */
  const identitySession = session.status === "success" && session.data._tag === "IdentityLoaded"
    ? session.data.session
    : null;
  useEffect(() => {
    if (identitySession === null) return;
    // Failures are defects (storeManager docs); crash loudly in dev via the
    // unhandled rejection instead of painting a recoverable state.
    void ensureStoreForSession(identitySession);
  }, [identitySession]);

  /**
   * Boot gate (#14): the main surfaces render only when an identity is
   * persisted; with no identity the user is redirected to /onboarding
   * (placeholder until #17).
   */
  if (session.status === "loading") {
    return null;
  }
  if (session.status === "error") {
    // SecureStorageError / IdentitySessionCorruptedError — typed, never
    // carrying secret material. Recovery UX is part of #17.
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-danger">Could not load your account ({session.error._tag}).</Text>
      </View>
    );
  }
  if (session.data._tag === "NoIdentity") {
    return <Redirect href="/onboarding" />;
  }

  return (
    // Bottom inset on the wrapper keeps the bottom-positioned tab bar above
    // the home indicator (material top tabs are not safe-area aware).
    <View className="flex-1 bg-background" style={{ paddingBottom: insets.bottom }}>
      <ShellHeader />
      <TopTabs
        tabBarPosition="bottom"
        screenOptions={{
          sceneStyle: { backgroundColor: colors.background },
          tabBarStyle: {
            backgroundColor: colors.background,
            borderTopWidth: 1,
            borderTopColor: colors.surface,
          },
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.foreground,
          tabBarLabelStyle: {
            fontFamily: fontFamily["sans-semibold"][0],
            fontSize: 13,
            textTransform: "none",
          },
          // The bar sits at the bottom, so the active indicator goes on its
          // top edge.
          tabBarIndicatorStyle: { backgroundColor: colors.primary, top: 0, height: 2 },
        }}
      >
        <TopTabs.Screen name="index" options={{ title: t("contactsTitle") }} />
        <TopTabs.Screen name="wallet" options={{ title: t("wallet") }} />
      </TopTabs>
    </View>
  );
}
