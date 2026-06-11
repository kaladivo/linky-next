/**
 * useEffectMutation — the write-side counterpart of useEffectQuery
 * (docs/effect-react-bridge.md "When to add a hook": the first real
 * mutation lands with onboarding #17).
 *
 * Runs a core workflow on the app's single ManagedRuntime when the caller
 * invokes `mutate(...)` (a user action), exposing
 * `{ status: "idle" | "pending" | "success", data? | "error", error? }`.
 * The Exit mapping follows the same rules as queries: typed failures
 * become the `error` state (components switch on `error._tag`), defects
 * are rethrown into React, interruption renders nothing.
 *
 * Only the latest invocation can settle state: re-mutating bumps an
 * invocation counter, so a slow earlier run can never overwrite a newer
 * one. Unmount stops all state updates.
 */
import type { Effect } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AppServices } from "./appLayer";
import { outcomeFromExit } from "./queryState";
import { appRuntime } from "./runtime";

export type EffectMutationState<A, E> =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | { readonly status: "success"; readonly data: A }
  | { readonly status: "error"; readonly error: E };

export interface EffectMutation<A, E, Args extends readonly unknown[]> {
  readonly state: EffectMutationState<A, E>;
  /** Fire the workflow. No promise is returned — react to `state`. */
  readonly mutate: (...args: Args) => void;
  /** Back to `idle` (e.g. dismissing an error before a retry). */
  readonly reset: () => void;
}

export function useEffectMutation<A, E, Args extends readonly unknown[]>(
  makeEffect: (...args: Args) => Effect.Effect<A, E, AppServices>,
): EffectMutation<A, E, Args> {
  const [state, setState] = useState<EffectMutationState<A, E>>({ status: "idle" });
  const invocationRef = useRef(0);
  const mountedRef = useRef(true);
  // Latest factory without making `mutate` identity depend on it (callers
  // routinely rebuild Effect-producing closures every render).
  const makeEffectRef = useRef(makeEffect);
  makeEffectRef.current = makeEffect;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mutate = useCallback((...args: Args) => {
    invocationRef.current += 1;
    const invocation = invocationRef.current;
    setState({ status: "pending" });

    void appRuntime.runPromiseExit(makeEffectRef.current(...args)).then((exit) => {
      if (!mountedRef.current || invocation !== invocationRef.current) return;
      const outcome = outcomeFromExit(exit);
      switch (outcome.type) {
        case "state":
          // "loading" never comes out of outcomeFromExit; success/error map 1:1.
          if (outcome.state.status !== "loading") setState(outcome.state);
          break;
        case "interrupted":
          break;
        case "defect":
          // Bugs crash loudly through React, never as a recoverable state.
          setState(() => {
            throw outcome.defect;
          });
          break;
      }
    });
  }, []);

  const reset = useCallback(() => {
    invocationRef.current += 1; // in-flight runs can no longer settle state
    setState({ status: "idle" });
  }, []);

  return { state, mutate, reset };
}
