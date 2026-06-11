/**
 * Runtime-agnostic half of the Effect ↔ React bridge: the UI state shape a
 * query hook exposes, and the mapping from an Effect `Exit` to it.
 *
 * Kept free of React and of the app runtime so it is unit-testable without
 * a device (see queryState.test.ts). The hook in useEffectQuery.ts is just
 * this mapping wired to useState + AbortController.
 */
import { Cause, Exit, Option } from "effect";

/**
 * What components see. A discriminated union — narrow on `status`, never
 * touch `data`/`error` without narrowing. `E` is the workflow's typed error
 * union (e.g. `SecureStorageError | MintConnectionError`), so error UI can
 * switch on `error._tag`.
 */
export type EffectQueryState<A, E> =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: A }
  | { readonly status: "error"; readonly error: E };

/**
 * How a finished fiber maps to the UI:
 * - "state"       → render it (success, or a typed error from the E channel).
 * - "interrupted" → the component unmounted / deps changed; render nothing.
 * - "defect"      → a bug (Effect.die or thrown exception). NOT a UI state:
 *                   the hook rethrows it so it crashes loudly (redbox in
 *                   dev, error boundary in production) instead of being
 *                   silently painted as a recoverable error.
 */
export type QueryOutcome<A, E> =
  | { readonly type: "state"; readonly state: EffectQueryState<A, E> }
  | { readonly type: "interrupted" }
  | { readonly type: "defect"; readonly defect: unknown };

export const outcomeFromExit = <A, E>(exit: Exit.Exit<A, E>): QueryOutcome<A, E> => {
  if (Exit.isSuccess(exit)) {
    return { type: "state", state: { status: "success", data: exit.value } };
  }
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    return { type: "state", state: { status: "error", error: failure.value } };
  }
  if (Cause.isInterruptedOnly(exit.cause)) {
    return { type: "interrupted" };
  }
  return { type: "defect", defect: Cause.squash(exit.cause) };
};
