# Generated-avatar / default-profile golden fixtures

`generatedAvatar.golden.json` pins the compatibility invariant for onboarding
profile setup (issue #17): **same npub -> same DiceBear avataaars URL, same
deterministic first name (per language), and same default Lightning address
as the PoC produces today**. Do not edit it by hand; do not regenerate it
with this repo's own code (that would make the tests circular).

## How it was generated

Generated on 2026-06-11 directly **from the PoC's own implementation** —
`linky-poc/apps/web-app/src/derivedProfile.ts` (which imports
`firstNames.ts`), run with bun via a throwaway script (no changes to the
PoC):

- For each seed (two npubs, the `"linky"` fallback seed, and the empty
  string), the script recorded:
  - `deriveInitialAvatarSelection(seed)` — the nine deterministic indices,
  - `deriveGeneratedAvatar(seed).pictureUrl` — the full DiceBear URL,
  - `cycleGeneratedAvatar(initial, control)` for every editor control
    (`top`, `hairColor`, `accessories`, `face`, `mouth`, `facialHair`,
    `skin`, `clothing`) — selection + URL after one tap,
  - `topTwice` — cycling `top` twice (pins sequential `+1` advancing),
  - `deriveDefaultProfile(seed, "en")` and `deriveDefaultProfile(seed, "cs")`
    — deterministic name, avatar URL, default Lightning address,
  - `deriveDefaultLightningAddress(seed)`.

The avatar pipeline is pure (FNV-1a hashing + value tables + URL building),
so the fixture needs no pinned external dependency versions; the PoC source
checkout at generation time is the reference.
