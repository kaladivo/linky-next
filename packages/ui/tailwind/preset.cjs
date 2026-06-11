/**
 * Shared Tailwind/NativeWind preset for all Linky clients.
 *
 * Apps consume it from their own tailwind.config.js:
 *
 *   module.exports = {
 *     content: [...],
 *     presets: [require("@linky/ui/tailwind-preset")],
 *   };
 *
 * The future web client reuses this preset so mobile and web share the same
 * semantic tokens (background, surface, primary, danger, ...).
 */
const { colors, fontFamily, spacing, lineHeight } = require("./tokens.cjs");

module.exports = {
  // NativeWind's preset is nested here so consuming apps only need this one
  // preset. Order matters: our `extend` below must beat NativeWind's own
  // fontFamily.sans ("system font" -> Times fallback on iOS), and a config
  // always wins over its own presets.
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors,
      fontFamily,
      spacing,
      lineHeight,
    },
  },
};
