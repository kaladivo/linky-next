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
import { RelaySettingsStore, runPendingFlushLoop } from "@linky/core";
import type { SupportedLocale, Translator } from "@linky/locales";
import { Effect } from "effect";

import { initChatInboxRunner } from "../chat/chatInboxRunner";
import { initPendingPaymentFlushRunner } from "../chat/pendingPaymentQueue";
import { initInAppRichNotifier } from "../notifications/inAppRichNotifier";
import { initNotificationEvents } from "../notifications/notificationEvents";
import { reconcileNotificationRegistration } from "../notifications/notificationActions";
import type { AppServices } from "../runtime";
import { runAppEffect } from "../runtime";
import { toast } from "../toast";
import { initAutoswapRunner } from "../wallet/autoswapRunner";

export interface StartupTaskContext {
  /** Translator bound to the resolved locale, for any user-visible output. */
  readonly t: Translator;
  /** The resolved locale ("en"/"cs") — default-name derivation, copy. */
  readonly locale: SupportedLocale;
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

/**
 * Relay warm-up (#31): touching `RelaySettingsStore` builds its Layer,
 * which loads the persisted user relay list and reconciles the relay pool —
 * so a relay the user removed stays gone from the next cold start, not just
 * from the next settings-screen visit.
 */
const relaySettingsWarmupTask: DeferredStartupTask = {
  name: "relay-settings-apply",
  task: () =>
    Effect.gen(function* () {
      const store = yield* RelaySettingsStore;
      const settings = yield* store.settings;
      yield* Effect.log(`relay settings applied: ${settings.relayUrls.join(", ")}`);
    }),
};

/**
 * `nostr.pending-flush` (#29): the persistent outbox flush loop — replays
 * queued signed events (offline chat sends, mute lists, …) every time the
 * relay pool regains a connection. Runs forever; the promise behind
 * runAppEffect simply never settles, which is fine for a deferred task.
 */
const pendingFlushTask: DeferredStartupTask = {
  name: "nostr-pending-flush",
  task: () => runPendingFlushLoop,
};

/**
 * `chat.receive-message` (#29): starts the chat inbox runner, which follows
 * the session-scoped store lifecycle and runs the NIP-17 inbox sync loop
 * for the active identity.
 */
const chatInboxTask: DeferredStartupTask = {
  name: "chat-inbox",
  task: () => Effect.sync(initChatInboxRunner),
};

/**
 * `chat-pay.queue` (#46): starts the pending contact-payment flush runner —
 * retries queued (offline-created) payment INTENTS on relay reconnect and
 * app foreground, and expires stale ones (funds untouched, row + toast).
 */
const pendingPaymentTask: DeferredStartupTask = {
  name: "chat-pay-pending-flush",
  task: ({ t }) => Effect.sync(() => initPendingPaymentFlushRunner(t)),
};

/**
 * `mints.autoswap` (#42): starts the background consolidation runner —
 * follows the session-scoped store lifecycle, melts the largest
 * foreign-mint balance toward the main mint when the threshold and the
 * `settings.cashu-autoswap` toggle allow it.
 */
const autoswapTask: DeferredStartupTask = {
  name: "cashu-autoswap",
  task: ({ t }) => Effect.sync(() => initAutoswapRunner(t)),
};

/**
 * `notifications.*` (#52): installs the foreground-suppression handler and
 * the tap-routing listeners, arms the in-app rich notifier the chat inbox
 * runner calls into, and runs the replace-stale reconciliation — when
 * notifications are enabled, any drift between the registered credentials
 * and the current ones (rotated Expo token, reinstall, identity/service
 * change) re-registers with the push service, which replaces the stale rows
 * (no broken or duplicate registrations survive a credential change).
 */
const notificationsTask: DeferredStartupTask = {
  name: "notifications",
  task: ({ t, locale }) =>
    Effect.promise(async () => {
      initInAppRichNotifier(t, locale);
      initNotificationEvents();
      const outcome = await reconcileNotificationRegistration();
      if (__DEV__) console.log(`[notifications] startup reconcile: ${outcome}`);
    }),
};

/** Real deferred work (sync refresh, relay warm-up, …) appends here. */
export const deferredStartupTasks: readonly DeferredStartupTask[] = [
  demoStartupTask,
  relaySettingsWarmupTask,
  pendingFlushTask,
  chatInboxTask,
  pendingPaymentTask,
  autoswapTask,
  notificationsTask,
];

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
