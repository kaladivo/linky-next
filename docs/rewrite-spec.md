# Linky Rewrite Tech Spec

This is the engineering spec for the Linky rewrite. It defines how we build; **what** we build is defined by the [feature map](./feature-map/index.md), and durable product decisions live in the [initial rewrite discussion](./initial-rewrite-discussion.md).

Status: agreed baseline (2026-06-10). New open questions are collected at the bottom.

## Goals

- One codebase shipping a first-class iOS and Android app via Expo.
- Business logic that outlives the mobile app: reusable in a future web/PWA client and publishable for other developers.
- The compatibility invariants from the initial discussion hold (SLIP-39 master identity, NIP-17 chat, Cashu deterministic seed/counters, Evolu owner lanes, npub.cash flows).
- Real funds in production; testnet/test mints by default everywhere else.

## Non-Goals (v1)

- Web/PWA client (architecture must allow it; we do not build it).
- Database migration for existing `app.linky.fit` users (backup-key import comes later).
- Reusing PoC code. The PoC contributes behavior, colors, and image assets only.

## Tech Stack

| Concern | Choice |
|---|---|
| Language | TypeScript (strict) everywhere |
| Monorepo | pnpm workspaces + Turborepo |
| Mobile app | Expo (custom dev client, CNG/prebuild — never Expo Go) |
| Navigation | Expo Router (file-based; deep links for `cashu:`, `lightning:`, `lnurl`, linky.fit links map to routes) |
| Styling | NativeWind; theme tokens ported from the PoC CSS variables |
| Logic / effects / errors | Effect (`effect`, incl. Schema for config/validation) plus `@effect/platform` for HTTP and key-value ports — services, typed errors, dependency injection via Layers |
| Local data & sync | Evolu (local-first SQLite, owner lanes derived from master identity); latest version with RN/Expo support, pinned during the storage spike |
| Protocols | Cashu (cashu-ts), Nostr (NIP-17 gift wrap, relays), Lightning/LNURL parsing in core |

## Monorepo Layout

```text
apps/
  mobile/        Expo app. Routes, screens, React hooks, app-level wiring.
  push/          Push service for Nostr inbox notifications. Full rewrite —
                 the PoC Bun service is a behavior reference only.
  web/           Future PWA client (placeholder, not v1).

packages/
  core/          Effect-based domain logic and protocol workflows.
                 Publishable as `@linky/core`.
  evolu-store/   Evolu schema, queries, repository adapters.
  platform/      Platform port interfaces + Expo implementations (secure storage,
                 camera/QR, clipboard, notifications, NFC, deep links).
  ui/            Shared React Native primitives, NativeWind theme, design tokens.
  locales/       Translation files (en, cs to start), consumed by mobile and
                 the future web client.
  config/        Shared tsconfig, ESLint, formatting.
```

Dependency rule: `core` imports nothing from React, Expo, Evolu runtime, or the platform. It defines **ports** (Effect service tags) that `platform/` and `evolu-store/` implement and `apps/mobile` wires together with Layers.

## packages/core

The heart of the rewrite and the reason for the Effect choice.

- Every domain workflow from the feature map (identity derivation, Cashu token lifecycle, Lightning/LNURL parsing and payment, NIP-17 messaging, contact logic, mint management) is an Effect service or workflow with typed errors — no thrown exceptions, no `any` failure channels.
- Side effects (storage, network, time, randomness, secure enclave) enter only through service tags, so core runs identically under the app runtime and under test Layers.
- Built as a publishable package (`@linky/core`) from day one: clean `exports` map, no workspace-internal imports, ESM, generated types. **Actual npm publish happens later**, once the API stabilizes — until then it is consumed via the workspace.
- Golden tests pin the compatibility invariants: same mnemonic → same npub, same Cashu seed, same Evolu owner lanes as the PoC produces today.

### Effect ↔ React bridge

`apps/mobile` owns a single `ManagedRuntime` built from the production Layers. React reaches core only through thin hooks that run Effect workflows against that runtime; components never construct Layers or handle Effect errors directly — errors are mapped to UI states at the hook boundary.

## Theming & Assets

Taken from the PoC **as values/files, never as code**:

- Colors from `linky-poc/apps/web-app/src/index.css` become NativeWind theme tokens, e.g. flat background `#020617`, primary `#2dd4bf`, danger `#f87171`, secondary surface `#1e293b`, primary-button foreground `#042f2e`, body text `#e2e8f0`.
- Font: Manrope (400/600/700), loaded via `expo-font`.
- Images/icons copied from `linky-poc/apps/web-app/public/` (logo `icon.svg`, animated icon) into `packages/ui` or `apps/mobile/assets`.

## Localization

The PoC approach (typed TypeScript translation modules, no i18n framework) carries over. Translation files live in `packages/locales` with `en` and `cs` at launch (ported from `linky-poc/apps/web-app/src/i18n/`), so the future web client reuses the same strings.

## Native Build Workflow (CNG)

- `ios/` and `android/` are **gitignored**. All native configuration lives in `app.config.ts` and Expo config plugins; `npx expo prebuild` regenerates the native projects on every build.
- Consequence: any native change (permissions, entitlements, push, NFC, deep-link schemes) must be expressible as config or a config plugin. Hand-editing generated native projects is forbidden.
- The app runs as a **custom development client** (`expo-dev-client`); Expo Go is never a target because we need custom native modules (secure storage, notifications, NFC, camera).

## Environments

Three runtime profiles, selected at build time (separate bundle IDs so they install side by side):

| Profile | Funds | Indicator |
|---|---|---|
| `development` | Test mints / testnet only | Visible dev badge |
| `staging` | Test defaults; mainnet only by explicit config | Visible badge |
| `production` | Mainnet defaults; test mints only via advanced settings | None |

Mint/relay/sync-server endpoints are profile configuration, not literals in code. Payment code paths must make it structurally hard to hit mainnet from a non-production build.

Implementation (issue #4): the profile is selected at build time via `APP_ENV` in `apps/mobile/app.config.ts` (bundle IDs `fit.linky.app.dev` / `fit.linky.app.staging` / `fit.linky.app`, names "Linky Dev" / "Linky Staging" / "Linky", schemes `linky-dev` / `linky-staging` / `linky`) and forwarded to the runtime as `extra.appEnv`. `@linky/core` owns the Effect Schema `EnvironmentConfig` plus the spec defaults (`environmentForProfile`); `apps/mobile/src/environment.ts` decodes the profile at startup. The mainnet guard is structural on two levels: `EnvironmentConfig` is a discriminated union on `network: "test" | "main"` derived from the profile (only `production` decodes to `"main"`, so mainnet-only code can require the narrowed `MainEnvironmentConfig` type), and the test branch of the schema only accepts Cashu mint URLs from a known test-mint allowlist (`TEST_MINT_HOSTS`) and refuses production-only sync hosts — a dev/staging config pointing at a mainnet mint fails to decode at app startup.

### Default Endpoints

These match what the PoC already uses and the most common public infrastructure:

| Endpoint | development / staging | production |
|---|---|---|
| Cashu mint | `https://testnut.cashu.space` (the standard Cashu test mint, fake funds) | `https://cashu.cz` |
| Nostr relays | `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.0xchat.com` | same |
| Evolu sync | `wss://free.evoluhq.com` | `wss://evolu.linky.fit` (+ `wss://free.evoluhq.com`) |

Shared public relays are fine for dev because dev identities are throwaway; mints and sync servers are what must never mix between profiles.

## Distribution

EAS Build for staging and production releases, **but it is not part of the rewrite** — no EAS setup until the app is feature-complete. Until then, everything is local builds via prebuild + `expo run`.

## Local Development & Verification

- Build locally: `expo prebuild` + `expo run:ios` / `expo run:android` (development profile).
- Agent-driven verification with **agent-device**: after a change, build and install the dev app, then verify behavior on simulator/emulator.
- Because Linky is two-sided (chat + payments between people), the standard verification scenario is **two app instances with two identities on testnet**: send a message, send a payment, confirm both sides observe it.
- The repo carries the tooling to make that scenario cheap to run: committed dev-only test mnemonics (test-mint funds only, never real), and scripts under `scripts/` that boot two simulators, install the development build on both, and restore one test identity on each. Goal: one command from fresh checkout to two chatting test instances.
- Compatibility invariants are covered by golden tests in `packages/core` (fast, no device); agent-device covers end-to-end flows.

## Testing Strategy

| Layer | What | How |
|---|---|---|
| core | Domain workflows, protocol logic, identity golden tests | Vitest + Effect test Layers; deterministic, no network by default |
| evolu-store | Schema and repository adapters | Integration tests against local SQLite |
| mobile | End-to-end flows (onboarding, chat, payment, scan) | agent-device against local builds, two-instance testnet scenarios |
| CI | typecheck, lint, unit/golden tests via turbo | Every PR; device E2E stays local for now |

## Open Questions

None currently. New questions discovered during implementation go here or into GitHub issues. One verification task worth flagging early: confirm current Evolu RN/Expo support and pin the latest supported version during the storage spike.
