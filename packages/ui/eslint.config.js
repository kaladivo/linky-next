import { baseConfig } from "@linky/config/eslint";

export default [
  {
    // Plain CJS token/preset files consumed by Tailwind's config loader.
    ignores: ["tailwind/**"],
  },
  ...baseConfig,
];
