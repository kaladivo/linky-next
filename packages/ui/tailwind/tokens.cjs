/**
 * Linky design tokens, ported 1:1 from the PoC CSS variables
 * (linky-poc/apps/web-app/src/index.css). Values only — never code.
 *
 * This file is CommonJS so the Tailwind preset (loaded by the Tailwind v3
 * config loader via require) and the TypeScript sources (via the adjacent
 * tokens.d.cts declarations) can share a single source of truth.
 *
 * Not ported (web-only, expressed with env()/keyboard CSS at runtime):
 *   --safe-area-top / --safe-area-bottom   -> react-native-safe-area-context
 *   --chat-keyboard-inset / --native-keyboard-inset -> native keyboard APIs
 */

/** Semantic color tokens. */
const colors = {
  /** --app-flat-bg: app-wide flat background. */
  background: "#020617",
  /** :root color: default body text. */
  foreground: "#e2e8f0",
  /** --app-secondary-button-bg: secondary surface / secondary button. */
  surface: "#1e293b",
  /** --app-primary-button-bg: brand teal, primary actions and links. */
  primary: "#2dd4bf",
  /** --app-primary-button-fg: text on primary backgrounds. */
  "primary-foreground": "#042f2e",
  /** a:hover color: hovered/pressed links and bright primary accents. */
  "primary-hover": "#5eead4",
  /** --app-danger-button-bg: destructive actions. */
  danger: "#f87171",
};

/**
 * Font families. Manrope 400/600/700 is loaded via expo-font
 * (@expo-google-fonts/manrope), where each weight registers as its own
 * family name, hence one token per weight.
 */
const fontFamily = {
  sans: ["Manrope_400Regular"],
  "sans-semibold": ["Manrope_600SemiBold"],
  "sans-bold": ["Manrope_700Bold"],
};

/** Layout sizes from the PoC custom properties (px values only). */
const spacing = {
  /** --topbar-content-height */
  "topbar-content": "48px",
  /** --chat-compose-height */
  "chat-compose": "116px",
  /** --floating-safe-area-bottom: min(safe-area-bottom, 24px) cap. */
  "floating-safe-area-max": "24px",
};

/** :root line-height. */
const lineHeight = {
  body: "1.6",
};

module.exports = { colors, fontFamily, spacing, lineHeight };
