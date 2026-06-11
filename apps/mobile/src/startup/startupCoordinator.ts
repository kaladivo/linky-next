/**
 * Startup coordinator — the seam for deferred, non-essential work
 * (shell.defer-network-work).
 *
 * Local-first rule: the root layout renders from local state immediately;
 * anything that is not needed for the first frame (network refresh, relay
 * warm-up, mint checks…) registers here and runs once, in an idle slot
 * after the first frame (requestIdleCallback — InteractionManager is
 * deprecated as of RN 0.85).
 *
 * Tasks are Effect workflows executed on the app runtime via runAppEffect.
 * They must not throw user-facing errors: a deferred task failing is a
 * logged warning (and never blocks the UI), not a UI state. Anything a
 * user must see goes through `toast` from inside the task itself.
 *
 * There is no real network work yet — `demoStartupTask` exercises the seam
 * end to end (runtime → Effect.log → dev-only debug toast) and is the
 * template for real tasks later.
 */
import type { Translator } from "@linky/locales";
import { Effect } from "effect";

import type { AppServices } from "../runtime";
import { runAppEffect } from "../runtime";
import { toast } from "../toast";

export interface StartupTaskContext {
  /** Translator bound to the resolved locale, for any user-visible output. */
  readonly t: Translator;
}

export interface DeferredStartupTask {
  readonly name: string;
  readonly task: (ctx: StartupTaskContext) => Effect.Effect<void, never, AppServices>;
}

/**
 * Demo no-op task: proves the deferred path runs after first paint. Logs
 * through Effect and, in dev builds only, surfaces a debug toast.
 */
const demoStartupTask: DeferredStartupTask = {
  name: "startup-demo",
  task: ({ t }) =>
    Effect.log(`deferred startup: ran ${deferredStartupTasks.length} task(s)`).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (__DEV__) {
            toast.info(t("devStartupToast", { tasks: deferredStartupTasks.length }));
          }
        }),
      ),
    ),
};

/** Real deferred work (sync refresh, relay warm-up, …) appends here. */
export const deferredStartupTasks: readonly DeferredStartupTask[] = [demoStartupTask];

let hasRun = false;

/** Hermes provides requestIdleCallback; fall back to a macrotask if absent. */
const scheduleIdle = (work: () => void): void => {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(work);
  } else {
    setTimeout(work, 0);
  }
};

/**
 * Runs every registered task once per JS context, in an idle slot after the
 * first frame. Idempotent — extra calls (e.g. a re-mounted root layout in
 * Fast Refresh) are no-ops.
 */
export const runDeferredStartup = (ctx: StartupTaskContext): void => {
  if (hasRun) return;
  hasRun = true;

  scheduleIdle(() => {
    for (const { name, task } of deferredStartupTasks) {
      // E = never: a rejection here is a defect in the task, not a flow error.
      void runAppEffect(task(ctx)).catch((defect: unknown) => {
        console.warn(`[startup] deferred task "${name}" died:`, defect);
      });
    }
  });
};
