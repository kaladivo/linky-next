/**
 * useTopupInvoice — drives the top-up invoice screen (#37): get-or-create
 * the quote (cached quotes are reused, see topupQuote.ts), poll the mint
 * every 5s (PoC parity), claim once paid/issued.
 *
 * Plain async on purpose (the useContactsScreenData convention):
 * repositories are plain TypeScript, the core workflows run through
 * runAppEffect/runCashuEffect inside topupActions.ts; this hook guards
 * staleness with a mount ref and a single-flight claim guard.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { CashuSeed } from "@linky/core";
import type { LinkyStore } from "@linky/evolu-store";

import {
  checkPendingTopup,
  claimPendingTopup,
  expirePendingTopup,
  getOrCreateTopupQuote,
} from "./topupActions";
import type { PendingTopup } from "./topupActions";
import { TOPUP_POLL_INTERVAL_MS } from "./topupQuote";

export type TopupInvoiceState =
  /** Resolving the mint and creating/reusing the quote. */
  | { readonly status: "preparing" }
  /** Invoice on screen; `claiming` while the claim is in flight. */
  | { readonly status: "showing"; readonly pending: PendingTopup; readonly claiming: boolean }
  | { readonly status: "claimed"; readonly amount: number }
  | { readonly status: "expired" }
  /** Quote creation or claim failed; `retry` restarts from scratch. */
  | {
      readonly status: "failed";
      readonly errorTag: string;
      /** Which step failed — picks the error copy on the screen. */
      readonly stage: "create" | "claim";
    };

export interface TopupInvoice {
  readonly state: TopupInvoiceState;
  readonly retry: () => void;
}

export const useTopupInvoice = (
  store: LinkyStore | null,
  seed: CashuSeed | null,
  amountSat: number,
): TopupInvoice => {
  const [state, setState] = useState<TopupInvoiceState>({ status: "preparing" });
  const [attempt, setAttempt] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Quote acquisition (per mount / retry).
  useEffect(() => {
    if (store === null || !Number.isFinite(amountSat) || amountSat <= 0) return;
    let stale = false;
    setState({ status: "preparing" });
    void getOrCreateTopupQuote(store, amountSat).then(
      (outcome) => {
        if (stale || !mountedRef.current) return;
        setState(
          outcome.kind === "ready"
            ? { status: "showing", pending: outcome.pending, claiming: false }
            : { status: "failed", errorTag: outcome.errorTag, stage: "create" },
        );
      },
      () => {
        if (!stale && mountedRef.current) {
          setState({ status: "failed", errorTag: "UNKNOWN", stage: "create" });
        }
      },
    );
    return () => {
      stale = true;
    };
  }, [store, amountSat, attempt]);

  // The SAME object across the claiming flag flips, so the polling effect
  // below survives them; it restarts only when the quote itself changes.
  const pending = state.status === "showing" ? state.pending : null;

  // Poll + claim while the invoice is showing. One interval per quote; the
  // busy flag makes check/claim single-flight across ticks.
  useEffect(() => {
    if (store === null || seed === null || pending === null) return;
    let stale = false;
    let busy = false;

    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const action = await checkPendingTopup(pending);
        if (stale || !mountedRef.current || action === "wait") return;

        if (action === "expired") {
          clearInterval(interval);
          await expirePendingTopup(store, pending);
          if (!stale && mountedRef.current) setState({ status: "expired" });
          return;
        }

        // action === "claim"
        setState({ status: "showing", pending, claiming: true });
        const outcome = await claimPendingTopup(store, seed, pending);
        if (stale || !mountedRef.current) return;
        switch (outcome.kind) {
          case "claimed":
            clearInterval(interval);
            setState({ status: "claimed", amount: outcome.amount });
            break;
          case "unpaid":
            // Race: claimable at check time, not at claim time — back to
            // polling (the interval is still running).
            setState({ status: "showing", pending, claiming: false });
            break;
          case "expired":
            clearInterval(interval);
            setState({ status: "expired" });
            break;
          case "failed":
            clearInterval(interval);
            setState({ status: "failed", errorTag: outcome.errorTag, stage: "claim" });
            break;
        }
      } finally {
        busy = false;
      }
    };

    const interval = setInterval(() => void tick(), TOPUP_POLL_INTERVAL_MS);
    void tick(); // immediate first check (resume/already-issued claims fast)

    return () => {
      stale = true;
      clearInterval(interval);
    };
  }, [store, seed, pending]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { state, retry };
};
