import type { ExpoConfig } from "expo/config";

import { colors } from "@linky/ui/tokens";

/**
 * All native configuration lives here (CNG): `npx expo prebuild` regenerates
 * the gitignored ios/ and android/ projects from this file and the config
 * plugins listed below. Hand-editing the generated native projects is
 * forbidden — anything native must be expressible as config or a plugin.
 *
 * Environment profiles (issue #4): the build-time APP_ENV env var selects
 * development / staging / production. Each profile gets its own bundle ID,
 * app name, and URL scheme so all three install side by side. The selected
 * profile is forwarded to the JS runtime via `extra.appEnv`, where
 * apps/mobile/src/environment.ts turns it into a validated @linky/core
 * EnvironmentConfig (endpoints live there, never in this file).
 */

const APP_PROFILES = ["development", "staging", "production"] as const;
type AppProfile = (typeof APP_PROFILES)[number];

const isAppProfile = (value: string): value is AppProfile =>
  (APP_PROFILES as readonly string[]).includes(value);

const appEnv = process.env.APP_ENV ?? "development";
if (!isAppProfile(appEnv)) {
  throw new Error(`Invalid APP_ENV "${appEnv}". Expected one of: ${APP_PROFILES.join(", ")}.`);
}

const identity: Record<AppProfile, { name: string; bundleId: string; scheme: string }> = {
  development: { name: "Linky Dev", bundleId: "fit.linky.app.dev", scheme: "linky-dev" },
  staging: { name: "Linky Staging", bundleId: "fit.linky.app.staging", scheme: "linky-staging" },
  production: { name: "Linky", bundleId: "fit.linky.app", scheme: "linky" },
};

const { name, bundleId, scheme } = identity[appEnv];

const config: ExpoConfig = {
  name,
  slug: "linky",
  scheme,
  version: "0.0.1",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "dark",
  backgroundColor: colors.background,
  ios: {
    bundleIdentifier: bundleId,
    supportsTablet: false,
  },
  android: {
    package: bundleId,
  },
  extra: {
    appEnv,
  },
  plugins: [
    "expo-router",
    [
      "expo-splash-screen",
      {
        backgroundColor: colors.background,
        image: "./assets/splash-icon.png",
        imageWidth: 200,
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
