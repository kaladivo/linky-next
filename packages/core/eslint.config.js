import { baseConfig } from "@linky/config/eslint";

export default [
  ...baseConfig,
  {
    // Dependency rule (rewrite-spec.md): core imports nothing from React, Expo,
    // the Evolu runtime, or platform code. It defines ports (Effect service
    // tags) that other workspaces implement.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "react",
                "react/*",
                "react-dom",
                "react-dom/*",
                "react-native",
                "react-native/*",
                "react-native-*",
              ],
              message: "@linky/core must not depend on React or React Native.",
            },
            {
              group: ["expo", "expo/*", "expo-*", "@expo/*"],
              message: "@linky/core must not depend on Expo.",
            },
            {
              group: ["@evolu/*", "evolu", "evolu/*"],
              message: "@linky/core must not depend on the Evolu runtime; define ports instead.",
            },
            {
              group: ["@linky/*"],
              message: "@linky/core is publishable and must have no workspace-internal imports.",
            },
          ],
        },
      ],
    },
  },
];
