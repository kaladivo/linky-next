/**
 * Avatar display URL for React Native (#17).
 *
 * The canonical avatar value — what core derives, what gets stored in the
 * local profile and published as the Nostr `picture` (#24) — is the PoC's
 * DiceBear avataaars **SVG** URL. The PoC renders it in an `<img>`; RN's
 * `Image` cannot rasterize SVG, so for on-screen display we point at
 * DiceBear's `png` endpoint with the SAME query (same seed/options renders
 * the same face) at an explicit pixel size. Custom photos are data URLs and
 * pass through untouched.
 */
const DICEBEAR_SVG_PREFIX = "https://api.dicebear.com/9.x/avataaars/svg?";

/** Rendered at 160pt like the PoC; 480px covers @3x displays. */
export const AVATAR_DISPLAY_PX = 480;

export const toAvatarDisplayUrl = (
  pictureUrl: string,
  sizePx: number = AVATAR_DISPLAY_PX,
): string => {
  if (!pictureUrl.startsWith(DICEBEAR_SVG_PREFIX)) return pictureUrl;
  return `${pictureUrl.replace("/avataaars/svg?", "/avataaars/png?")}&size=${sizePx}`;
};
