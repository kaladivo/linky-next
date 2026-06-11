# @linky/mobile

Placeholder for the Linky Expo app.

The real Expo scaffold (custom dev client, CNG/prebuild, Expo Router,
NativeWind) is created in issue #3. Until then this workspace intentionally
contains no code and no pipeline tasks.

Notes for issue #3 (from `docs/rewrite-spec.md`):

- Custom dev client only — never Expo Go.
- `ios/` and `android/` are generated via `npx expo prebuild` and are
  gitignored at the repo root.
- All native configuration lives in `app.config.ts` and config plugins.
