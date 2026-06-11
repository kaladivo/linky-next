import { baseConfig } from "@linky/config/eslint";

export default [
  {
    ignores: ["ios/**", "android/**", ".expo/**", "expo-env.d.ts", "metro.config.js"],
  },
  ...baseConfig,
];
