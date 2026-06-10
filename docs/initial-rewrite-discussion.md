# Initial Rewrite Discussion

## Context

Linky is being rebuilt from an existing dirty proof-of-concept app in the local workspace:

- Local PoC folder: [../../linky-poc/](../../linky-poc/)
- Current deployed app: https://app.linky.fit

The PoC should be used as a feature and behavior reference, not as a code reference. Its implementation is intentionally treated as disposable.

The product combines:

- Contacts
- Nostr messaging
- Lightning and Cashu payments
- Local-first storage and sync through Evolu
- npub.cash-compatible Lightning address and mint preference flows

The rewrite target is a mobile-first app built with Expo in a pnpm monorepo. The architecture should keep business and background logic reusable for future PWA and desktop clients.

## Agreed Decisions

- Start clean with the new data model and architecture.
- Existing `app.linky.fit` users do not need direct database/schema migration in the first version.
- Importing an existing Linky backup key should be supported later, but it should not force old schema or architecture choices.
- `Effect` is a firm architectural choice for `packages/core`; core workflows and services should be written in the Effect style.
- iOS and Android are equally important targets.
- The app should handle real mainnet funds in production.
- Development and staging builds should default to testnet/test mints, with clear environment-level separation.
- Advanced and debug features from the PoC should be mapped one by one and classified before implementation.
- Roadmap planning should use GitHub issue style and be visualized on the GitHub Project board rather than maintained as only a linear markdown roadmap.

## PoC Scope Observed

The PoC currently includes more than the visible product app:

- `apps/web-app`: product PWA and primary feature implementation.
- `apps/site`: public website and Cashu landing/deeplink flows.
- `apps/native-shell`: Capacitor-based native shell.
- `apps/push`: Bun push service for Nostr inbox notifications.
- `packages/core`: small core package, currently mostly identity derivation.
- `packages/config`: shared tooling config.

Most business behavior still lives in the web app hooks and utilities, not in `packages/core`. The rewrite should extract behavior into explicit domain contracts instead of copying the current boundaries.

## Core Compatibility Invariants

These details should be protected by tests before or during the rewrite:

- SLIP-39 master identity remains the root identity.
- Nostr keys are derived from the master identity by default.
- Custom Nostr keys remain possible as a local override.
- Evolu owner lanes are deterministic from the master identity.
- Cashu wallet seed and deterministic wallet counters must remain reliable.
- Nostr chat uses NIP-17 gift-wrapped messaging.
- Chat supports messages, replies, edits, reactions, deletes, and unknown-contact handling.
- Lightning payment parsing supports Lightning addresses, BOLT11 invoices, LNURL-pay, and LNURL-withdraw.
- Cashu token flows support receive, send, restore, validation, mint selection, top-up, and chat payments.
- npub.cash compatibility should remain, with a planned path toward `npub.linky.fit`.

## Proposed Monorepo Shape

Initial package direction:

```text
apps/
  mobile/       Expo app, first-class client
  push/         Push service, cleaned up from the PoC later
  web/          Future PWA client

packages/
  core/         Effect-based business logic and protocol workflows
  evolu-store/  Evolu schema and repository adapters
  platform/     Platform ports for secure storage, camera, clipboard, links, notifications
  ui/           Shared React Native UI primitives
  config/       Shared TypeScript, ESLint, and formatting config
```

`packages/core` should not import React, Expo, Evolu runtime hooks, browser APIs, or local storage. Apps and platform packages provide those dependencies through services/adapters.

## Feature Areas To Map

Initial feature buckets for the GitHub issue backlog:

- Foundation and repo setup
- Identity and onboarding
- Evolu schema and storage adapters
- Profile and Nostr metadata
- Contacts and contact requests
- Wallet and Cashu token lifecycle
- Lightning and LNURL payments
- Mint selection and npub.cash sync
- Chat and NIP-17 sync
- Chat payments
- Push notifications
- Native capabilities: QR scan, deep links, secure storage, NFC
- Settings and advanced screens
- Developer/debug screens
- Import from old Linky backup key

## Advanced And Debug Feature Policy

Initial classification policy:

- User-facing v1 candidates: mint settings, relay settings, backup/export, display currency, transaction history.
- Internal/dev-only candidates: Evolu current/history data, owner lane diagnostics, push debug, raw database counts.
- Decide later: manual owner rotation, NFC write, PWA install/update flows, old Capacitor-specific behavior.
- Rebuild or drop: browser-only localStorage diagnostics and PoC-specific repair screens unless they remain useful for support.

## Environment Profiles

The app should have explicit runtime profiles:

- `development`: test mints/testnet defaults, clear visual indicator.
- `staging`: test defaults, optional mainnet override through explicit config.
- `production`: mainnet defaults, test mints available only from advanced settings.

Payment code must make it hard to accidentally use mainnet defaults in development or staging.

## Planning Workflow

The roadmap should be represented as GitHub issues with:

- Problem statement
- Scope
- Out of scope
- Acceptance criteria
- Dependencies
- Test expectations
- Labels such as `area:identity`, `area:wallet`, `area:chat`, `type:foundation`, `type:feature`, `risk:funds`

The GitHub Project board is the canonical kanban view:

https://github.com/users/kaladivo/projects/4/views/1

Docs should capture durable decisions. Issues should carry implementation tasks.

## Next Planning Pass

Before implementation, create the first issue set for:

1. Repo and tooling scaffold.
2. Core identity package with golden tests.
3. Expo app shell and navigation foundation.
4. Evolu schema and repository adapter spike.
5. Environment profile and network/mint configuration.
6. PoC feature map with decisions for `v1`, `later`, `dev-only`, and `drop`.
