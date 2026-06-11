/**
 * Runtime access to the design tokens (e.g. for places NativeWind classes
 * cannot reach, like navigator/tab-bar theme options).
 *
 * The single source of truth is ../tailwind/tokens.cjs, shared with the
 * Tailwind preset.
 */
export { colors, fontFamily, spacing, lineHeight } from "../tailwind/tokens.cjs";
