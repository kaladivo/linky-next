import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Shared flat ESLint config for all Linky workspaces.
 *
 * Usage in a workspace's eslint.config.js:
 *
 *   import { baseConfig } from "@linky/config/eslint";
 *   export default [...baseConfig];
 */
export const baseConfig = tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".turbo/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.es2022,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  prettier,
);

export default baseConfig;
