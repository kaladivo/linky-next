# Effect ↔ React bridge

How React in `apps/mobile` talks to the Effect world of `@linky/core`. The rule from the [rewrite spec](./rewrite-spec.md#effect--react-bridge): one `ManagedRuntime`, thin hooks, errors mapped to UI states at the hook boundary. Components never construct Layers and never see raw Effect errors.

## The one-runtime rule

The app owns exactly **one** `ManagedRuntime`, created once at module load in [`apps/mobile/src/runtime/runtime.ts`](../apps/mobile/src/runtime/runtime.ts) and never disposed:

```ts
export const appRuntime = ManagedRuntime.make(appLayer);
```

- Never create another `ManagedRuntime` (or call `Effect.runPromise` & co. directly) anywhere in the app. A second runtime would rebuild every memoized service — duplicate HTTP clients, duplicate storage handles, broken invariants.
- Nothing outside `src/runtime/` imports `appRuntime`. Components reach it only through hooks.
- Tests of core workflows don't need the runtime at all — they provide test Layers with `Effect.provide` (see `packages/core/README.md` §5).

## `appLayer` — the single composition point

[`apps/mobile/src/runtime/appLayer.ts`](../apps/mobile/src/runtime/appLayer.ts) is the only place production Layers are composed:

```ts
const environmentLayer = Layer.succeed(CurrentEnvironment, environment);

export const appLayer = Layer.mergeAll(
  environmentLayer,
  // #8 platform Layers slot in here.
);

export type AppServices = Layer.Layer.Success<typeof appLayer>;
```

It provides `CurrentEnvironment` (the decoded `EnvironmentConfig` from `src/environment.ts`, wrapped in the service tag that `@linky/core` defines — core owns service definitions, the app owns the values) plus the Expo-backed platform Layers from `@linky/platform` (#8): `SecureStorageLive`, `KeyValueStorageLive`, `RandomnessLive`, `ClipboardLive`, `DeepLinksLive`, `HttpClientLive`. New implementations are added as another argument to `Layer.mergeAll(...)`; `AppServices` widens automatically, so workflows requiring those ports immediately become runnable from hooks — no hook or component changes.

## The session-scoped Evolu store (#26)

The Linky store (`createLinkyStore` from `@linky/evolu-store`) is the one piece of app state that does NOT fit the one-runtime shape: `appLayer` is composed once per JS context, but the store must be **created when a session loads and torn down on logout** (and a different identity must get a different store). It therefore lives outside the Layer system, in [`apps/mobile/src/store/storeManager.ts`](../apps/mobile/src/store/storeManager.ts) — a module singleton in the style of `src/session/sessionStore.ts`:

- **Boot**: the session gate (`app/(tabs)/_layout.tsx`) calls `ensureStoreForSession(session)` once the identity loads. The lane mnemonics come from core's `deriveOwnerLaneMnemonics` (run via `runAppEffect` — the derivation is a core workflow, the manager only orchestrates); sync transports come from the profile's `evoluSyncUrls`. Idempotent per identity.
- **Identity isolation**: the SQLite database name is `linky-<fnv1a(npub)>` (the PoC's scheme) — one database per identity. Logout → new identity boots a *different, empty* database; restoring the same identity reattaches to its data and its sync lanes.
- **Teardown**: `logout` (`src/session/sessionActions.ts`) calls `teardownStore()` — lane sync stops and the reference is dropped, so no screen can read the previous account's data. Evolu 7.4.1 cannot dispose instances (`[Symbol.dispose]` throws upstream) and caches them per name; the per-identity name is what guarantees isolation, teardown is the sync/reference half.
- **Consumption**: components use `useLinkyStore()` (`useSyncExternalStore` over the manager) and pass the store to the plain-TypeScript repositories from `@linky/evolu-store`. Repository reads are one-shot promises; write paths call `invalidateStoreData()` so mounted lists re-query (`useContactsScreenData` is the reference consumer). When live Evolu query subscriptions become necessary (#29 chat), that is a deliberate extension of this seam, not a per-screen decision.

Why not a Layer in `appLayer`? A per-session Layer would require either rebuilding the runtime per login (forbidden — one-runtime rule) or a mutable service holding "maybe a store", which moves the same lifecycle problem behind a Tag without removing it. Why not React context? The store is consumed on screens outside the gate's subtree (Settings is pushed above the tabs), and teardown must be reachable from the non-React logout action. The module singleton keeps one owner for boot (the gate), one for teardown (logout), and read-only subscription everywhere else.

Non-React consumers that run *behind* the gate (the wallet-data seam, the cashu flows below) reach the store through `getReadyLinkyStore()` — a promise that resolves once the gate's boot finished. It must only be called from code paths that render after the gate; with no identity it would never resolve, exactly like the screens themselves never rendering.

## Cashu workflows and the session-scoped CounterStore (#37)

Core's Cashu engine (#32) takes all counter state through the `CounterStore` port, and the production backend (#35 `createCashuCounterStoreLayer`) is built **on the session store** — the `_cashuCounter` table of the per-identity database. That makes `CounterStore` the one core service that cannot live in `appLayer` (same lifecycle argument as the store itself).

The wiring is [`apps/mobile/src/runtime/runCashuEffect.ts`](../apps/mobile/src/runtime/runCashuEffect.ts):

```ts
runCashuEffect(store, claimTopup({ ... })) // Effect<A, E, AppServices | CounterStore>
```

- It builds the CounterStore service from the given store and provides it over `runAppEffect`, so the workflow's remaining requirements stay ⊆ `AppServices`.
- **One service instance per store** (WeakMap-memoized): the #32 fund-safety contract serializes counter-consuming mint operations through an in-memory per-keyset FIFO lock that lives inside the service. Rebuilding the Layer per call would hand every call its own lock map and void the contract. A new session (new store) gets a fresh service; the old one is garbage with its store.
- Flows that need it: top-up claim (#37), send/melt and restore later (#39/#42). Quote creation/checking need only `HttpClient` and keep using `runAppEffect`.

The wallet-data seam closed the same way: `loadWalletData` (`src/wallet/walletData.ts`) awaits `getReadyLinkyStore()` and reads `TokensRepository.balances()`; screens re-query by passing the store data version (`subscribeToStoreData`) as a `useEffectQuery` dep.

## The hook pattern: `useEffectQuery`

[`apps/mobile/src/runtime/useEffectQuery.ts`](../apps/mobile/src/runtime/useEffectQuery.ts) is the bridge for read-style workflows:

```ts
const result = useEffectQuery(describeEnvironment);
// result: { status: "loading" }
//       | { status: "success"; data: A }
//       | { status: "error"; error: E }
```

- `useEffectQuery(effect, deps?)` runs the Effect on `appRuntime` once per mount (or per change of `deps`, semantics like `useEffect` deps). The `effect` argument itself is deliberately not a dependency — Effect values are routinely rebuilt every render.
- The Effect may require at most `AppServices`. If TypeScript complains about a missing service in `R`, the fix belongs in `appLayer.ts`, never in the component.
- Cancellation: each run gets an `AbortController`; unmount or deps change aborts the signal, which **interrupts the underlying fiber**. Interrupted runs update no state, so stale results can never overwrite fresh ones.
- The runtime-agnostic half (state union + `Exit` → state mapping) lives in [`queryState.ts`](../apps/mobile/src/runtime/queryState.ts) and is unit-tested without a device (`apps/mobile/src/runtime/queryState.test.ts`).

Hand-rolled on purpose: no react-query/effect-rx at this stage. If a workflow needs caching, refetching, or mutation semantics later, that is a deliberate architecture change, not a per-screen decision.

### When to add a hook

- A screen needs the **result of a core workflow** → use `useEffectQuery` directly for one-off cases, or wrap it in a named hook (`useBalance`, `useContacts`) in `src/hooks/` once more than one component needs the same workflow or the call needs arguments:

  ```ts
  export const useBalance = (mintUrl: string) =>
    useEffectQuery(computeBalance(mintUrl), [mintUrl]);
  ```

- A screen needs to **trigger a workflow on user action** (send payment, save contact) → that is a mutation, not a query; use `useEffectMutation` from `src/runtime/` (landed with onboarding #17). It exposes `{ state: idle | pending | success | error, mutate, reset }` and follows the same Exit-mapping rules below; only the latest invocation may settle state.
- Code must run a workflow **outside the render cycle** (the deferred-startup coordinator, fire-and-forget persistence like the locale preference) → `runAppEffect` from `src/runtime/` (#16), the one sanctioned imperative escape hatch. It runs the Effect on the app runtime and returns a promise that rejects on failures and defects alike; callers decide whether that is awaited or logged.
- A component wants to **import `effect`, a Layer, or `appRuntime`** → stop; that logic belongs in core (workflow) or `src/runtime/` (bridge).

### Error mapping rules

The boundary between Effect's error model and React state is exactly `outcomeFromExit`:

| Fiber outcome | Becomes | Component's job |
|---|---|---|
| Success | `{ status: "success", data }` | render it |
| Typed failure (workflow's `E` channel) | `{ status: "error", error }` | switch on `error._tag`, render a human message (localized, eventually) |
| Interruption (unmount / deps change) | nothing — last state stands, component is gone or re-querying | nothing |
| Defect (`Effect.die`, thrown bug) | **rethrown into React** (redbox in dev, error boundary in prod) | nothing — defects are bugs, never UI states |

Rules of thumb:

- Components map `error._tag` → copy. They never inspect `cause`, never stringify raw errors at users, and never see `Cause`/`Exit`/`FiberFailure` types.
- Don't "handle" a typed error by ignoring it. If an error can't happen in context, the workflow's `E` channel should say so (`Effect.catchTag` inside core, not in the component).
- Never convert a defect into a recoverable error state — silently painting a bug as "try again later" is how invariants rot.

## Reference example, end to end

1. **Core workflow** — `describeEnvironment` in `packages/core/src/domain/environment/describeEnvironment.ts`: reads the `CurrentEnvironment` service, returns a multi-line summary (profile, funds network, mint, relays, sync). Type: `Effect<string, never, CurrentEnvironment>`.
2. **Service value** — `appLayer` provides `CurrentEnvironment` from the decoded build profile.
3. **Hook + UI** — `app/(tabs)/settings.tsx` renders an "Environment" card via `useEffectQuery(describeEnvironment)`, branching on `status` with `@linky/ui` primitives.
4. **Tests** — the workflow under a test Layer in `packages/core/src/domain/environment/describeEnvironment.test.ts`; the Exit mapping in `apps/mobile/src/runtime/queryState.test.ts`.
