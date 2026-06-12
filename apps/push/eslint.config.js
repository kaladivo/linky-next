import { baseConfig } from "@linky/config/eslint";

export default [
  ...baseConfig,
  {
    // Dev verification scripts (#52): plain Node ESM, run with `node`.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        WebSocket: "readonly",
        fetch: "readonly",
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
