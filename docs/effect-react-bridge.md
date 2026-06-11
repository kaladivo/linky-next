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
