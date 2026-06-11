/**
 * runAppEffect — the imperative seam of the Effect ↔ React bridge.
 *
 * For the few places that must trigger a workflow outside the render cycle
 * (the deferred-startup coordinator, fire-and-forget persistence like the
 * locale preference). Components reading data keep using `useEffectQuery`;
 * this exists so nothing outside src/runtime/ ever touches `appRuntime` or
 * calls `Effect.runPromise` directly (docs/effect-react-bridge.md).
 *
 * The returned promise rejects on typed failures and defects alike — the
 * caller decides whether that is fire-and-forget (log it) or awaited.
 */
import type { Effect } from "effect";

import type { AppServices } from "./appLayer";
import { appRuntime } from "./runtime";

export const runAppEffect = <A, E>(
  effect: Effect.Effect<A, E, AppServices>,
  options?: { readonly signal?: AbortSignal },
): Promise<A> => appRuntime.runPromise(effect, options);
