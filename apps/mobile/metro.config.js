// Metro config for the pnpm monorepo.
//
// Modern Expo (SDK 52+) auto-detects the workspace root and configures
// watchFolders / nodeModulesPaths for monorepos, so the default config is
// enough. NativeWind wraps it to compile global.css + tailwind classes
// (tailwind.config.js pulls the shared preset from @linky/ui).
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: "./global.css" });
