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

Instances: `src/domain/identity/__fixtures__/slip39.golden.json` (SLIP-39 backup phrase ↔ master secret, generated from `slip39-ts@0.1.13`) and `src/domain/identity/__fixtures__/derivedIdentities.golden.json` (master secret → Nostr keys / Cashu seed / owner-lane mnemonics, generated from the PoC's identity code and pinned deps; the Evolu owner-id end of the chain is pinned in `packages/evolu-store/test/__fixtures__/ownerLanes.golden.json`).

### 7. Secrets

Workflows that touch secret material (master secret, backup phrase, derived keys) must never log it, embed it in error payloads, or pass it outside typed return values. `no-console` is an ESLint error across `src/`.

This extends to **error `cause` chains**: a typed error's `cause` (and anything reachable from it — wrapped errors, native exception messages, stack data) must not carry secrets either. When translating an error whose payload could contain fragments of secret input (e.g. `InvalidBackupPhraseError.unknownWords` for a stored phrase), map it to a reason-only error instead of attaching the original as `cause` — see `IdentitySessionCorruptedError` in `src/domain/identity/identitySession.ts`. Tests assert that serialized session errors contain no phrase words or secret hex.

Secrets at rest go through the `SecureStorage` port only. The stored keys are owned and documented by the module that writes them; currently:

| Key                                | Value                                              | Owner module                          |
| ---------------------------------- | -------------------------------------------------- | ------------------------------------- |
| `linky.identity.backupPhrase.v1`   | canonical 20-word SLIP-39 phrase                   | `src/domain/identity/identitySession` |
| `linky.identity.customNostrKey.v1` | JSON `{ nsec, activatedAtSec }` custom-key override | `src/domain/identity/customNostrKey`  |

## The ports

| Port              | Tag / module                                                                                                              | Errors               | Notes                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `SecureStorage`   | `@linky/core/SecureStorage`                                                                                               | `SecureStorageError` | String secrets (mnemonic, derived keys). Keychain/Keystore-backed in `packages/platform`.  |
| `KeyValueStorage` | `@effect/platform` `KeyValueStore` (re-exported)                                                                          | `PlatformError`      | Non-secret prefs. Tests use `KeyValueStorage.layerMemory`. Never put secrets here.         |
| `HttpClient`      | `@effect/platform` `HttpClient` (re-exported, with `HttpClientRequest`/`HttpClientResponse`/`HttpClientError`/`HttpBody`) | `HttpClientError`    | The app wires `FetchHttpClient.layer` or a tuned client; tests stub via `HttpClient.make`. |
| `Randomness`      | `@linky/core/Randomness`                                                                                                  | `RandomnessError`    | Cryptographically secure bytes for key/secret generation. Implementation MUST be a CSPRNG. |
| `Clipboard`       | `@linky/core/Clipboard`                                                                                                   | `ClipboardError`     | Copy/read plain text (tokens, invoices). Empty clipboard is `Option.none()`.               |
| `DeepLinks`       | `@linky/core/DeepLinks`                                                                                                   | `DeepLinksError`     | Launch URL (`initialUrl`) + live URL `Stream` (`urls`). Raw strings; parsing is domain.    |

### Time and non-secret randomness: built-in services, not ports

- **Clock** — workflows never call `Date.now()`. Use Effect's built-in `Clock` (`Clock.currentTimeMillis`, `Effect.sleep`, `Schedule`). Tests control time with `TestClock` (`TestClock.setTime`, `TestClock.adjust`) via `TestContext.TestContext`. There is no Linky clock port and there must never be one.
- **Random (non-secret)** — jitter, shuffling, sampling use Effect's built-in `Random`, which is seedable in tests. The `Randomness` port exists **only** because cryptographic entropy must come from platform CSPRNGs that core cannot import.

## Package mechanics

- ESM only, `type: "module"`, relative imports carry `.js` extensions.
- `exports` map exposes the root entry only; build is `tsc` emitting `dist/` with `.d.ts` + source maps.
- Publishable from day one (`@linky/core`); actual npm publish happens once the API stabilizes. Until then it is consumed via the pnpm workspace.
- Scripts: `pnpm build` / `typecheck` / `lint` / `test`.
