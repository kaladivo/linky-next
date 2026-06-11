/**
 * useEffectQuery — the thin hook through which React reads @linky/core.
 *
 * Runs an Effect workflow on the app's single ManagedRuntime and exposes
 * the result as `{ status: "loading" | "success" | "error", data?, error? }`.
 * Typed errors from the workflow's E channel become the `error` state;
 * defects (bugs) are rethrown into React; interruption (unmount, deps
 * change) renders nothing. Components never construct Layers and never see
 * raw Effect types beyond passing the workflow in.
 *
 * Cancellation: each run gets an AbortController whose signal interrupts
 * the underlying fiber; the effect cleanup aborts on unmount and whenever
 * `deps` change, so a stale run can never overwrite a newer state.
 *
 * See docs/effect-react-bridge.md for when to add a hook and how to map
 * errors.
 */
import type { Effect } from "effect";
import { useEffect, useState } from "react";
import type { DependencyList } from "react";

import type { AppServices } from "./appLayer";
import { outcomeFromExit } from "./queryState";
import type { EffectQueryState } from "./queryState";
import { appRuntime } from "./runtime";

/**
 * Run `effect` once per change of `deps` (default: once per mount).
 *
 * `effect` may require at most the services of `appLayer` (`AppServices`);
 * anything else is a type error — the place to fix it is the Layer
 * composition in appLayer.ts, never the component.
 *
 * The `effect` argument itself is not a dependency (Effect values are
 * usually rebuilt every render); only `deps` trigger a re-run, exactly like
 * the deps of useEffect.
 */
export function useEffectQuery<A, E>(
  effect: Effect.Effect<A, E, AppServices>,
  deps: DependencyList = [],
): EffectQueryState<A, E> {
  const [state, setState] = useState<EffectQueryState<A, E>>({ status: "loading" });

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState({ status: "loading" });

    void appRuntime.runPromiseExit(effect, { signal: controller.signal }).then((exit) => {
      if (!active) return;
      const outcome = outcomeFromExit(exit);
      switch (outcome.type) {
        case "state":
          setState(outcome.state);
          break;
        case "interrupted":
          break;
        case "defect":
          // Surface bugs through React (redbox / error boundary), not as a
          // recoverable UI error state.
          setState(() => {
            throw outcome.defect;
          });
          break;
      }
    });

    return () => {
      active = false;
      controller.abort();
    };
    // Caller-provided deps; `effect` is intentionally not tracked (see doc comment).
  }, deps);

  return state;
}
