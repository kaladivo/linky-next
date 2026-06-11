/**
 * The PoC's deterministic string hash (FNV-1a 32-bit, multiplication done
 * via shifts to stay in 32-bit integer range). Ported VERBATIM from
 * `linky-poc/apps/web-app/src/derivedProfile.ts` — generated avatars and
 * deterministic onboarding names must come out identical for the same npub,
 * which is pinned by `__fixtures__/generatedAvatar.golden.json`.
 *
 * Internal module: not re-exported from the domain barrel (tests import it
 * directly).
 */
export const hash32 = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619 (via shifts to stay in 32-bit)
    hash =
      (hash +
        ((hash << 1) >>> 0) +
        ((hash << 4) >>> 0) +
        ((hash << 7) >>> 0) +
        ((hash << 8) >>> 0) +
        ((hash << 24) >>> 0)) >>
      0;
  }
  return hash >>> 0;
};

/** The PoC's seed normalization: trimmed input, `"linky"` when empty. */
export const normalizeSeed = (seedValue: string): string => {
  return String(seedValue ?? "").trim() || "linky";
};
