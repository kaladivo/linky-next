# @linky/core

Effect-based domain logic and protocol workflows for Linky: identity derivation, Cashu token lifecycle, Lightning/LNURL, NIP-17 messaging, contacts, mint management.

This README is the **architecture contract**. Every domain workflow added to this package follows the conventions below — no exceptions, no thrown errors, no direct side effects.

## Hard rules

- **No platform imports.** Core never imports React, React Native, Expo, the Evolu runtime, or any `@linky/*` workspace package. Enforced by ESLint (`no-restricted-imports` in `eslint.config.js`). The package is publishable to npm as-is.
- **All side effects enter through ports** — Effect service tags defined in `src/ports/`. Implementations live in `packages/platform` (and `packages/evolu-store` for persistence); `apps/mobile` wires them together with Layers into a single `ManagedRuntime`.
- **No thrown exceptions, no `any` failure channels.** Every expected failure is a tagged error in the Effect `E` channel. Bugs (violated invariants) are defects (`Effect.die`), not typed errors.

## Layout

```text
src/
  ports/    Service tags for side effects (the only door to the outside world)
  domain/   Domain workflows, one directory per area (environment, identity, ...)
  index.ts  Public API — everything importable from "@linky/core"
```

Inside a domain directory, modules that exist only to support the public workflows (e.g. `domain/identity/slip39.ts`, the raw SLIP-39 codec) are **not** re-exported from the domain's `index.ts`; tests may import them directly.

## Conventions

### 1. Defining a service (port)

One module per service. The tag is a class extending `Context.Tag`; the tag key is namespaced `"@linky/core/<Name>"`; the service shape is a separate `<Name>Service` interface.

```ts
// src/ports/SecureStorage.ts (abridged)
import { Context, Data } from "effect";
import type { Effect, Option } from "effect";

export class SecureStorageError extends Data.TaggedError("SecureStorageError")<{
  readonly operation: "get" | "set" | "delete";
  readonly key: string;
  readonly cause?: unknown;
}> {}

export interface SecureStorageService {
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, SecureStorageError>;
  readonly set: (key: string, value: string) => Effect.Effect<void, SecureStorageError>;
  readonly delete: (key: string) => Effect.Effect<void, SecureStorageError>;
}

export class SecureStorage extends Context.Tag("@linky/core/SecureStorage")<
  SecureStorage,
  SecureStorageService
>() {}
```

Rules:

- Tag key format: `@linky/core/<PascalCaseName>`. Tag keys are global identity — never reuse or rename one casually.
- Absence is a value (`Option.none()`), not an error.
- Operations are total over their typed errors: every native exception an implementation can hit is mapped into the port's error type.

### 2. Defining a typed error

Always `Data.TaggedError`. Name is `<Subject>Error`, the tag string equals the class name, and the payload carries what a caller needs to react (plus `cause?: unknown` for the underlying exception).

```ts
import { Data } from "effect";

export class MintConnectionError extends Data.TaggedError("MintConnectionError")<{
  readonly mintUrl: string;
  readonly cause?: unknown;
}> {}
```

- Expected failures (network down, keychain locked, invalid token, insufficient balance) → typed error in the `E` channel.
- Programmer errors / impossible states → `Effect.die` (defect). Defects are not part of a workflow's API.
- Workflows translate port errors into domain errors at their boundary when the port error would leak an implementation detail; they let port errors pass through when the caller genuinely needs them.
- Callers handle errors by tag: `Effect.catchTag("MintConnectionError", ...)`, `Effect.catchTags({...})`.

### 3. Writing a workflow

Workflows are plain `Effect` values (or functions returning them) built with `Effect.gen`. Dependencies and errors are **inferred** — never widened by hand to `any`/`unknown`.

```ts
// src/domain/identity/loadOrCreateIdentityKey.ts (illustrative)
import { Effect, Encoding, Option } from "effect";
import { Randomness, SecureStorage } from "../../ports/index.js";

export const loadOrCreateIdentityKey = Effect.gen(function* () {
  const storage = yield* SecureStorage;
  const existing = yield* storage.get("identity.secretKey");
  if (Option.isSome(existing)) return existing.value;

  const randomness = yield* Randomness;
  const bytes = yield* randomness.nextBytes(32);
  const encoded = Encoding.encodeHex(bytes);
  yield* storage.set("identity.secretKey", encoded);
  return encoded;
});
// Inferred type:
// Effect<string, SecureStorageError | RandomnessError, SecureStorage | Randomness>
```

The `R` channel documents exactly which ports a workflow touches; the `E` channel documents exactly how it can fail. Both are part of the public API.

### 4. Defining a Layer

Core ships **no production Layers** — implementations come from `packages/platform`. Conventions for whoever implements a port:

- A package's main implementation is exported as `layer` (or `layerLive`); variants get suffixes: `layerMemory`, `layerConfig(...)`.
- Layers map every native failure into the port's typed error before it escapes.
- `apps/mobile` composes all production Layers once into a single `ManagedRuntime`; React reaches core only through hooks that run workflows on that runtime.

```ts
// packages/platform (illustrative) — Expo SecureStore implementation
import { Effect, Layer, Option } from "effect";
import { SecureStorage, SecureStorageError } from "@linky/core";
import * as ExpoSecureStore from "expo-secure-store";

export const SecureStorageLive = Layer.succeed(SecureStorage, {
  get: (key) =>
    Effect.tryPromise({
      try: async () => Option.fromNullable(await ExpoSecureStore.getItemAsync(key)),
      catch: (cause) => new SecureStorageError({ operation: "get", key, cause }),
    }),
  // set / delete analogous
});
```

### 5. Testing with test Layers

Tests are Vitest + in-memory Layers. Deterministic, no network, no timers. Build a fresh Layer per test (state lives inside `Layer.sync`), provide it with `Effect.provide`, run with `Effect.runPromise` (or `Effect.flip` / `Effect.runPromiseExit` for error paths).

```ts
import { Effect, Layer, Option } from "effect";
import { SecureStorage } from "@linky/core";

const SecureStorageMemory = Layer.sync(SecureStorage, () => {
  const store = new Map<string, string>();
  return {
    get: (key) => Effect.sync(() => Option.fromNullable(store.get(key))),
    set: (key, value) => Effect.sync(() => void store.set(key, value)),
    delete: (key) => Effect.sync(() => void store.delete(key)),
  };
});

it("stores the generated key", async () => {
  const result = await Effect.runPromise(myWorkflow.pipe(Effect.provide(SecureStorageMemory)));
  expect(result).toBe("...");
});
```

Error paths are tested by providing a Layer that fails with the port's typed error and asserting on the flipped value. See `src/ports/ports.test.ts` for the executable version of all of these conventions.

### 6. Golden fixtures (compatibility tests)

Compatibility invariants (same mnemonic → same master secret / npub / Cashu seed / owner lanes as the PoC) are pinned by **golden fixtures**:

- Fixtures live next to the domain they pin: `src/domain/<area>/__fixtures__/<name>.golden.json`, with a `README.md` in the same directory documenting exactly how (and from which PoC library version) they were generated.
- Fixtures are generated **from the PoC's own dependencies before the new implementation is written** — never from code in this repo, which would make the test circular. They are committed and never regenerated casually.
- The corresponding `<name>.golden.test.ts` loads the JSON with `fs.readFileSync(new URL(...))` (tests are excluded from the build, so fixtures never end up in `dist/`).

Instances: `src/domain/identity/__fixtures__/slip39.golden.json` (SLIP-39 backup phrase ↔ master secret, generated from `slip39-ts@0.1.13`), `src/domain/identity/__fixtures__/derivedIdentities.golden.json` (master secret → Nostr keys / Cashu seed / owner-lane mnemonics, generated from the PoC's identity code and pinned deps; the Evolu owner-id end of the chain is pinned in `packages/evolu-store/test/__fixtures__/ownerLanes.golden.json`), and `src/domain/cashu/__fixtures__/cashuWallet.golden.json` (seed + keyset + counter → NUT-13 secrets / blinding factors / blinded messages, token V3/V4 encodings, linky.fit wrapped-link formats and token-extraction behavior, generated from the PoC's `@cashu/cashu-ts@2.9.0` and verbatim PoC token code).

### 7. Secrets

Workflows that touch secret material (master secret, backup phrase, derived keys) must never log it, embed it in error payloads, or pass it outside typed return values. `no-console` is an ESLint error across `src/`.

This extends to **error `cause` chains**: a typed error's `cause` (and anything reachable from it — wrapped errors, native exception messages, stack data) must not carry secrets either. When translating an error whose payload could contain fragments of secret input (e.g. `InvalidBackupPhraseError.unknownWords` for a stored phrase), map it to a reason-only error instead of attaching the original as `cause` — see `IdentitySessionCorruptedError` in `src/domain/identity/identitySession.ts`. Tests assert that serialized session errors contain no phrase words or secret hex.

Secrets at rest go through the `SecureStorage` port only. The stored keys are owned and documented by the module that writes them; currently:

| Key                                | Value                                               | Owner module                          |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------- |
| `linky.identity.backupPhrase.v1`   | canonical 20-word SLIP-39 phrase                    | `src/domain/identity/identitySession` |
| `linky.identity.customNostrKey.v1` | JSON `{ nsec, activatedAtSec }` custom-key override | `src/domain/identity/customNostrKey`  |

## The ports

| Port               | Tag / module                                                                                                              | Errors                | Notes                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SecureStorage`    | `@linky/core/SecureStorage`                                                                                               | `SecureStorageError`  | String secrets (mnemonic, derived keys). Keychain/Keystore-backed in `packages/platform`.                                                                                                                                                                                                                                              |
| `KeyValueStorage`  | `@effect/platform` `KeyValueStore` (re-exported)                                                                          | `PlatformError`       | Non-secret prefs. Tests use `KeyValueStorage.layerMemory`. Never put secrets here.                                                                                                                                                                                                                                                     |
| `HttpClient`       | `@effect/platform` `HttpClient` (re-exported, with `HttpClientRequest`/`HttpClientResponse`/`HttpClientError`/`HttpBody`) | `HttpClientError`     | The app wires `FetchHttpClient.layer` or a tuned client; tests stub via `HttpClient.make`.                                                                                                                                                                                                                                             |
| `Randomness`       | `@linky/core/Randomness`                                                                                                  | `RandomnessError`     | Cryptographically secure bytes for key/secret generation. Implementation MUST be a CSPRNG.                                                                                                                                                                                                                                             |
| `CounterStore`     | `@linky/core/CounterStore`                                                                                                | `CounterStoreError`   | Cashu deterministic counters + restore cursors per (mint, unit, keyset) with a per-keyset lock. Production Layer comes from `evolu-store` (#35); `CounterStoreMemory` / `CounterStoreKeyValue` ship here. Counters are not secrets, but their key semantics are a funds contract — see the module doc.                                  |
| `Clipboard`        | `@linky/core/Clipboard`                                                                                                   | `ClipboardError`      | Copy/read plain text (tokens, invoices). Empty clipboard is `Option.none()`.                                                                                                                                                                                                                                                           |
| `DeepLinks`        | `@linky/core/DeepLinks`                                                                                                   | `DeepLinksError`      | Launch URL (`initialUrl`) + live URL `Stream` (`urls`). Raw strings; parsing is domain.                                                                                                                                                                                                                                                |
| `ProfilePublisher` | `@linky/core/ProfilePublisher`                                                                                            | `ProfilePublishError` | Publishes own profile metadata (Nostr kind 0). Stub Layer in `apps/mobile` until #24.                                                                                                                                                                                                                                                  |
| `NostrTransport`   | `@linky/core/NostrTransport`                                                                                              | `NostrTransportError` | Raw text-frame access to one relay (`connect(url)` → scoped `{ send, frames }`). Core ships `layerNostrTransportSocket` on `@effect/platform` `Socket`; the app provides `Socket.WebSocketConstructor` (`WebSocketConstructorLive` / `NostrTransportLive` in `packages/platform`). Tests use the in-memory fake relay network instead. |

### Nostr relay services (`src/domain/nostr/`, issue #21)

Domain services built on `NostrTransport` + `CurrentEnvironment` (relay set) + `KeyValueStorage`. Core ships their Layers because they are pure domain logic — all platform access still goes through the ports above.

| Service             | Tag / Layer                                               | Errors                   | API                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RelayPool`         | `@linky/core/RelayPool`, `layerRelayPool(config?)`        | `NostrPublishError`      | `relayUrls`; `publish(event)` — resolves once ≥ 1 relay ACKs, remaining relays keep retrying in background (capped exponential backoff, `publishMaxAttempts` per relay; `OK false` is terminal); `subscribe(filters)` — pooled REQ, re-issued on reconnect, dedup by id, signature-verified; `status` / `statusChanges` — per-relay `"checking" \| "connected" \| "disconnected"` map (SubscriptionRef-backed, for deferred startup + relay settings #31). |
| `NostrPendingQueue` | `@linky/core/NostrPendingQueue`, `layerNostrPendingQueue` | `NostrPendingQueueError` | Persistent outbox under KV key `linky.nostr.pendingEvents.v1`, survives restart. `enqueue` (idempotent by event id), `pending`, `remove(id)`, `flush` (oldest-first, partial success keeps failures queued, single-flight). `runPendingFlushLoop` flushes on app start / reconnect edges.                                                                                                                                                                  |

Supporting protocol modules (same directory, all exported): `NostrEvent` (NIP-01 schema, `nostrEventId`, `signNostrEvent` — BIP-340 via `@noble`, aux randomness from the `Randomness` port — and `verifyNostrEvent`; id/signing pinned to the PoC's nostr-tools by `__fixtures__/signedEvents.golden.json`), `NostrFilter`/`matchesFilter`, the NIP-01 wire codec (`encodeClientMessage`/`decodeRelayMessage` + relay-side duals), and `makeFakeRelayNetwork` — the canonical in-memory fake relay Layer for tests (scriptable per relay: online/offline, accept/reject/silent publish responses, server-emitted events, received/stored event introspection).

Relay list publishing (`relayLists.ts`, issue #23; `nostr.publish-relay-lists`): `publishRelayLists(activeIdentity, relaySettings)` signs and publishes the NIP-65 relay metadata (kind 10002, `["r", url]` tags, no markers) and the NIP-17 inbox relay list (kind 10050, `["relay", url]` tags) — shapes pinned against the PoC by `__fixtures__/relayLists.golden.json`. Replaceable events, so every trigger (relay-settings change, startup sync via `publishCurrentRelayLists`) just re-publishes; offline publishes fall back to `NostrPendingQueue` (`outcome: "queued"`) and go out on the next flush. `RelaySettings` is an input on purpose: today it comes from `CurrentEnvironment` (`currentRelaySettings`); #31's user-editable relay settings produce it instead.

### Lightning & LNURL (`src/domain/lightning/`, issue #34)

Parsing is pure and PoC-pinned (`__fixtures__/lightning.golden.json`, generated from the PoC's `lightningInvoice.ts`/`lnurlPay.ts` — two documented PoC bugs fixed, see the fixture README): `parseBolt11Invoice` (HRP amount, memo, expiry, payment/description hash; amountless supported; lenient like the PoC), `parseLightningAddress` (LUD-16 → well-known LNURL-pay URL), `parseLnurl` (bech32 `lnurl1…`, `lnurlp://`/`lnurlw://`, bare http; pay/withdraw kind hint), and `parseLightningInput` — the unified discriminated union (`LightningAddressInput | Bolt11Input | LnurlPayInput | LnurlWithdrawInput | LnurlInput`) that #48's unified parser builds on. No bolt11 library: like the PoC, the codec is `@scure/base` bech32.

Workflows (all LNURL HTTP through the `HttpClient` port): `fetchLnurlPayMetadata` → `fetchLnurlPayInvoice` (range validation, LUD-12 comments, LUD-06 step-7 verification — invoice amount and metadata-hash mismatches are rejected, never paid) → `payLightningAddress` (melts via #32's `payInvoice`, single mint, remainder preserved as NUT-08 change); `payBolt11Invoice` (amountless → `InvoiceAmountRequiredError`); `fetchLnurlWithdrawOffer` → `withdrawViaLnurl` (mints a #32 top-up quote and hands its invoice to the withdraw callback; claim via `checkTopupQuote`/`claimTopup`). The auto-pay limit is a contract only: `decideAutoPay(invoice, AutoPaySetting)` — the setting itself lives with #39's UI.

### Protocol libraries and the network

cashu-ts would perform its own `fetch` by default — a side effect outside the ports. The Cashu engine therefore injects a custom request implementation into every `CashuMint` (`src/domain/cashu/internal/transport.ts`), built on the `HttpClient` port and reproducing cashu-ts's native error mapping. No code in core calls `fetch`; tests run the full engine against an in-process fake mint provided as an `HttpClient` Layer (`src/domain/cashu/__tests__/fakeMint.ts`) and never touch a real mint.

### Time and non-secret randomness: built-in services, not ports

- **Clock** — workflows never call `Date.now()`. Use Effect's built-in `Clock` (`Clock.currentTimeMillis`, `Effect.sleep`, `Schedule`). Tests control time with `TestClock` (`TestClock.setTime`, `TestClock.adjust`) via `TestContext.TestContext`. There is no Linky clock port and there must never be one.
- **Random (non-secret)** — jitter, shuffling, sampling use Effect's built-in `Random`, which is seedable in tests. The `Randomness` port exists **only** because cryptographic entropy must come from platform CSPRNGs that core cannot import.

## Package mechanics

- ESM only, `type: "module"`, relative imports carry `.js` extensions.
- `exports` map exposes the root entry only; build is `tsc` emitting `dist/` with `.d.ts` + source maps.
- Publishable from day one (`@linky/core`); actual npm publish happens once the API stabilizes. Until then it is consumed via the pnpm workspace.
- Scripts: `pnpm build` / `typecheck` / `lint` / `test`.
