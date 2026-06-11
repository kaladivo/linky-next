// Metro config for the pnpm monorepo.
//
// Modern Expo (SDK 52+) auto-detects the workspace root and configures
// watchFolders / nodeModulesPaths for monorepos, so the default config is
// enough. Keep this file as the single place for any future Metro tweaks.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

module.exports = config;
