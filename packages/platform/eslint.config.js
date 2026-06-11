import { baseConfig } from "@linky/config/eslint";

export default [
  ...baseConfig,
  {
    // Dependency rule (issue #8 / rewrite-spec.md): this package implements
    // core's ports with Expo native modules. It must never pull in React or
    // react-native UI — components live in @linky/ui and apps/mobile.
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
              ],
              message: "@linky/platform must not depend on React or react-native UI.",
            },
          ],
        },
      ],
    },
  },
];
