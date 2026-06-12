/**
 * autoswapRunner — `mints.autoswap` (issue #42): background consolidation
 * of foreign-mint balances toward the main mint, following the PoC's
 * trigger semantics (`useAppShellComposition` autoswap effect):
 *
 * - fires on wallet-data changes (store data version), debounced;
 * - one run in flight at a time; a (mint|sum|count) signature remembers
 *   the last attempted opportunity so a failing swap is not retried in a
 *   loop — it re-arms only when the wallet content changes;
 * - threshold: source balance ≥ 128 sat (core AUTOSWAP_MIN_SOURCE_SUM);
 * - test-mint guard: with a test mint as MAIN mint the setting itself is
 *   force-disabled (PoC parity) — autoswap must never melt real foreign
 *   value into test ecash;
 * - melted-but-unclaimed quotes are resumed first, INDEPENDENT of the
 *   toggle (they are owed funds, not new consolidations).
 *
 * Lifecycle mirrors chatInboxRunner: `initAutoswapRunner` is registered as
 * a deferred startup task and subscribes to the store lifecycle + data
 * version; logout/teardown simply makes ticks no-ops (status !== ready).
 */
import { autoswapTriggerSignature, loadSession, shouldForceDisableAutoswap } from "@linky/core";
import type { Translator } from "@linky/locales";

import { runAppEffect } from "../runtime";
import { getStoreState, subscribeToStore, subscribeToStoreData } from "../store/storeManager";
import { toast } from "../toast";
import { loadCashuAutoswapEnabled, persistCashuAutoswapEnabled } from "./autoswapSetting";
import {
  loadMeltToMainAvailability,
  meltLargestToMain,
  resolveMainMintUrl,
  resumePendingConsolidations,
} from "./consolidationActions";

/** Debounce between a wallet-data change and the autoswap check. */
const TICK_DEBOUNCE_MS = 2000;

let initialized = false;
let translator: Translator | null = null;
let inFlight = false;
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let lastAttemptedSignature: string | null = null;

const scheduleTick = (): void => {
  if (tickTimer !== null) return;
  tickTimer = setTimeout(() => {
    tickTimer = null;
    void runTick();
  }, TICK_DEBOUNCE_MS);
};

const runTick = async (): Promise<void> => {
  if (inFlight) return;
  inFlight = true;
  try {
    await tick();
  } catch (defect: unknown) {
    console.warn("[autoswap] tick died:", defect);
  } finally {
    inFlight = false;
  }
};

const tick = async (): Promise<void> => {
  const storeState = getStoreState();
  if (storeState.status !== "ready") return;
  const store = storeState.store;

  const session = await runAppEffect(loadSession);
  if (session._tag !== "IdentityLoaded") return;
  const seed = session.session.cashuWallet.seed;

  // Owed funds first: finish melted-but-unclaimed quotes regardless of the
  // toggle (a crash or a slow LN settlement must not strand the value).
  // Silent — the completed claim shows up as wallet balance.
  await resumePendingConsolidations(store, seed);

  const mainMintUrl = await resolveMainMintUrl(store);
  const enabled = await runAppEffect(loadCashuAutoswapEnabled);

  // PoC parity: a test MAIN mint force-disables the setting itself.
  if (shouldForceDisableAutoswap(mainMintUrl)) {
    if (enabled) await runAppEffect(persistCashuAutoswapEnabled(false));
    return;
  }
  if (!enabled) return;

  const availability = await loadMeltToMainAvailability(store);
  const signature = autoswapTriggerSignature(
    availability === null
      ? null
      : { mintUrl: availability.sourceMintUrl, spendableSat: availability.sourceSpendableSat },
    availability?.sourceRecordCount ?? 0,
  );
  if (signature === null) {
    lastAttemptedSignature = null;
    return;
  }
  if (signature === lastAttemptedSignature) return;
  lastAttemptedSignature = signature;

  const outcome = await meltLargestToMain(store, seed);
  const t = translator;
  if (t === null) return;
  switch (outcome.kind) {
    case "consolidated":
      toast.success(
        t("cashuMeltToMainMintDone", {
          amount: outcome.amountSat,
          unit: "sat",
          mint: availability?.targetDisplayName ?? "",
        }),
      );
      return;
    case "pending-claim":
      toast.info(t("cashuMeltToMainMintPending", { amount: outcome.amountSat, unit: "sat" }));
      return;
    case "failed":
      toast.error(t("cashuMeltToMainMintFailed"));
      return;
    case "nothing":
      return;
  }
};

/**
 * Idempotent wiring; called once from the deferred startup tasks. Ticks on
 * every store lifecycle/data change from then on.
 */
export const initAutoswapRunner = (t: Translator): void => {
  translator = t;
  if (initialized) return;
  initialized = true;
  subscribeToStore(scheduleTick);
  subscribeToStoreData(scheduleTick);
  scheduleTick();
};

/** Test seam: forget the last attempted opportunity (re-arm). */
export const resetAutoswapSignature = (): void => {
  lastAttemptedSignature = null;
};
