# Evolu Storage Spike (issue #9)

Time-boxed spike verifying that Evolu works for the rewrite: React Native /
Expo support, local SQLite persistence, sync against `wss://free.evoluhq.com`,
and owner lanes derived from external entropy (the derived-identity scheme).

## Verdict: GO

Evolu runs in the Expo SDK 56 custom dev client with the `expo-sqlite` driver,
persists locally, connects to the public relay, and its owner API supports the
derived-identity scheme exactly as the spec expects. Versions are pinned below.

## Pinned versions

| Package | Version | Why |
| --- | --- | --- |
| `@evolu/common` | `7.4.1` (exact) | Latest stable; **identical to the PoC's version**, so owner derivation (SLIP-21 from `OwnerSecret`) is bit-for-bit compatible with what `app.linky.fit` produces today. |
| `@evolu/react-native` | `14.3.0` (exact) | Latest stable; "Evolu for React Native and Expo". Peers: `expo >= 54`, `expo-sqlite >= 16`, `react-native >= 0.81`, `react >= 19` — all satisfied by Expo SDK 56 / RN 0.85.3 / React 19.2.3. |
| `@evolu/react` | `10.4.0` (exact) | Latest stable; hooks (`useQuery`, `useOwner`, `EvoluProvider`) for later app wiring. |
| `@evolu/nodejs` | `2.4.0` (exact, dev-only) | better-sqlite3 driver + local relay; powers the vitest integration tests in `packages/evolu-store`. |
| `expo-sqlite` | `~56.0.5` | SDK-56-matched, via `expo install`. |
| `expo-secure-store` | `~56.0.4` | Required at module load by `@evolu/react-native/expo-sqlite` (its `localAuth` secure storage). |
| `expo-crypto` | `~56.0.4` | Provides `crypto.getRandomValues` for Hermes (see polyfill note below). |

Do not bump to `@evolu/common@8.x` / `@evolu/react-native@15.x` casually: they
are still `-next` prereleases (as of 2026-06) and the changelog signals an
"owner-api" rework. Re-evaluate when stable.

## RN / Expo support status

- `@evolu/react-native@14.3.0` ships three driver entries:
  `./expo-sqlite` (used here), `./expo-op-sqlite`, and `./bare-op-sqlite`.
  The expo-sqlite entry needs **no extra native modules beyond `expo-sqlite`
  and `expo-secure-store`** — both are Expo config-plugin friendly (CNG safe).
  The op-sqlite entries would additionally pull `@op-engineering/op-sqlite` +
  nitro modules; not needed for the spike, available if SQLite perf on the JS
  thread ever becomes a problem.
- The driver uses `expo-sqlite`'s synchronous API on the JS thread (no worker
  threads on RN). Fine for our data volumes; revisit only if profiling says so.
- Requires a custom dev client (native `expo-sqlite` module) — we never target
  Expo Go anyway.
- **Hermes provides no `crypto.getRandomValues`** — Evolu (via
  `@noble/hashes`) throws "crypto.getRandomValues must be defined" at startup
  without a polyfill. Evolu's own Expo example installs
  `react-native-quick-crypto`; we use the lighter Expo-native equivalent:
  `expo-crypto` plus `apps/mobile/lib/cryptoPolyfill.ts`, which must be
  imported before any `@evolu/*` import. (`Promise.withResolvers` is the only
  polyfill Evolu bundles itself.)
- **Metro does not rewrite NodeNext-style `.js` import extensions to `.ts`.**
  `packages/evolu-store` is consumed as TypeScript source by Metro, so unlike
  the publishable `core` package it uses extensionless relative imports with
  `moduleResolution: "bundler"` (see its `tsconfig.json`).

## Owner lanes from external entropy (derived-identity scheme)

Confirmed in `@evolu/common@7.4.1` — everything the spec / issue #13 needs:

- `Mnemonic.fromUnknown(string)` → `mnemonicToOwnerSecret(mnemonic)` →
  `createAppOwner(secret)`: deterministic `AppOwner` (id, encryption key,
  write key via SLIP-21) from an externally derived BIP-39 mnemonic. This is
  exactly what the PoC does per lane (`meta`, `identity`, `contacts`, `cashu`,
  `messages`, `transactions` × rotation index).
- `OwnerSecret.fromUnknown(bytes)` accepts raw 32-byte entropy directly, so
  lanes can skip the mnemonic encoding entirely if we want.
- `createEvolu(deps)(schema, { externalAppOwner })` boots the instance with
  the externally derived owner — Evolu never generates or stores its own
  mnemonic in that mode.
- Separate lanes: `createShardOwner(secret)` (independent secret per lane,
  PoC-style) or `deriveShardOwner(appOwner, path)` (derived from the AppOwner;
  deterministic, supports the rotation-index pattern as path elements).
- Lane writes: `evolu.insert(table, props, { ownerId })`; lane sync:
  `evolu.useOwner(syncOwner)` where a `SyncOwner` can carry its own
  `transports`. Marked `@experimental` upstream but present and typed.
- Golden values for the test mnemonic are pinned in
  `packages/evolu-store/test/ownerDerivation.test.ts`; same-version-as-PoC
  means the derivation matches production data.

## What the integration tests cover

The spike's `integration.test.ts` was superseded by the issue #15 base-schema
suite (vitest, node environment, Evolu on real local SQLite via
`@evolu/nodejs`'s better-sqlite3 driver, `transports: []` so no network):

- `packages/evolu-store/test/ownerDerivation.test.ts` — deterministic owner
  derivation from mnemonics / raw entropy, golden owner-id snapshots,
  `ShardOwner` lanes.
- `packages/evolu-store/test/store.integration.test.ts` — six-domain schema
  creation, per-domain owner-lane assignment, offline reads, and the
  restore-reconnect approximation (live relay sync belongs to #53/#58).
- `packages/evolu-store/test/contactsRepository.test.ts` — the repository
  adapter conventions.

## Device verification

Dev client built from this worktree on the iPhone 17 simulator
(`npx expo run:ios`, Metro :8083). Temporary route
`apps/mobile/app/dev/evolu-spike.tsx`, opened via the temporary "Evolu spike
(dev)" link on the Settings tab (in the dev client, `linky://` scheme links
launch the app but do not navigate to the route). Issue #15 kept the route
but pointed it at the real schema's `metaEntry` table (the spike's
`spikeNote` table is gone). Verified with agent-device:

- Creates the Evolu instance with `evoluReactNativeDeps`
  (`@evolu/react-native/expo-sqlite`) and an `externalAppOwner` from a fixed
  dev test mnemonic.
- The on-device owner id equals the node integration test's golden value
  (`F0xh0HpiAx5shgCgtGENww`) — identical derivation on both platforms.
- Insert + subscribed query work (rows appear immediately); after a full app
  restart (`simctl terminate` + relaunch) the same rows are still there —
  local SQLite persistence confirmed.
- Relay status for `wss://free.evoluhq.com?ownerId=<derived owner>` reaches
  `connected`, and Evolu reports no errors with the live transport
  configured.

## Limitations / notes

- **No public sync-state API in this Evolu line.** `@evolu/react`'s
  `useSyncState` is commented out upstream ("TODO: Update it for the
  owner-api"); the instance only exposes `subscribeError`. Per-server
  connected/checking/disconnected status (feature `sync.status`) must be
  implemented PoC-style: probe the relay WebSocket ourselves.
- `{ ownerId }` mutations and `useOwner` are marked `@experimental` upstream;
  they are the documented mechanism for partitioning, but expect API movement
  in Evolu v8 ("owner-api" rework). Our repository layer should wrap them so
  a future migration is contained in `packages/evolu-store`.
- `createEvolu` caches instances per database name; identity switching needs
  distinct names (PoC already handles it this way).
- better-sqlite3 (test driver) writes `<name>.db` into the process cwd; the
  integration test chdirs into a temp dir.
- The expo-sqlite driver runs on the JS thread. If large syncs ever jank the
  UI, `@evolu/react-native/expo-op-sqlite` is the escape hatch (extra native
  deps, still CNG-compatible).
