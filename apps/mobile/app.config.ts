import type { ExpoConfig } from "expo/config";

/**
 * All native configuration lives here (CNG): `npx expo prebuild` regenerates
 * the gitignored ios/ and android/ projects from this file and the config
 * plugins listed below. Hand-editing the generated native projects is
 * forbidden — anything native must be expressible as config or a plugin.
 *
 * Environment profiles (development/staging/production with separate bundle
 * IDs and endpoint config) arrive in issue #4; until then this is the
 * development app.
 */
const config: ExpoConfig = {
  name: "Linky (dev)",
  slug: "linky",
  scheme: "linky",
  version: "0.0.1",
  orientation: "portrait",
  ios: {
    bundleIdentifier: "fit.linky.app.dev",
    supportsTablet: false,
  },
  android: {
    package: "fit.linky.app.dev",
  },
  plugins: ["expo-router"],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
