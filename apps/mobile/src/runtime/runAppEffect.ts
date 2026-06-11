/**
 * runAppEffect — the imperative half of the Effect ↔ React bridge.
 *
 * For one-shot workflows triggered by user actions (button handlers,
 * session create/logout): runs the Effect on the app's single
 * ManagedRuntime and returns a Promise. Components that *read* data render
 * through `useEffectQuery`; this is only for fire-on-press mutations whose
 * result is handled imperatively (navigation, store invalidation, toasts).
 *
 * Typed errors and defects both reject the Promise (as FiberFailure) —
 * callers `.catch` and decide what to surface. Keeps the one-runtime rule:
 * nothing outside src/runtime/ touches `appRuntime` directly.
 */
import type { Effect } from "effect";

import type { AppServices } from "./appLayer";
import { appRuntime } from "./runtime";

export const runAppEffect = <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> =>
  appRuntime.runPromise(effect);
