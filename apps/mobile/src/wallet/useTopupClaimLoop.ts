/**
 * useTopupClaimLoop — the poll→claim half of the top-up flow (#37),
 * extracted so LNURL-withdraw (#40) can reuse it verbatim: while a pending
 * top-up quote is on screen, recheck it at the mint every 5s (PoC parity),
 * claim once paid/issued, surface expiry/failure.
 *
 * The loop is agnostic to how the quote came to be — top-up shows its
 * invoice to the user, LNURL-withdraw hands it to the withdraw service —
 * the waiting/claiming/claimed semantics are identical.
 */
import { useEffect, useState } from "react";

import type { CashuSeed } from "@linky/core";
import type { LinkyStore } from "@linky/evolu-store";

import { checkPendingTopup, claimPendingTopup, expirePendingTopup } from "./topupActions";
import type { PendingTopup } from "./topupActions";
import { TOPUP_POLL_INTERVAL_MS } from "./topupQuote";

export type TopupClaimLoopState =
  /** Polling; `claiming` while a claim is in flight. */
  | { readonly status: "waiting"; readonly claiming: boolean }
  | { readonly status: "claimed"; readonly amount: number }
  | { readonly status: "expired" }
  | { readonly status: "failed"; readonly errorTag: string };

/**
 * Runs one poll/claim loop per `pending` quote (and per `attempt` bump — a
 * caller's claim-retry). Resets to waiting whenever the loop restarts; the
 * returned state is only meaningful while `pending` is non-null.
 */
export const useTopupClaimLoop = (
  store: LinkyStore | null,
  seed: CashuSeed | null,
  pending: PendingTopup | null,
  attempt = 0,
): TopupClaimLoopState => {
  const [state, setState] = useState<TopupClaimLoopState>({
    status: "waiting",
    claiming: false,
  });

  useEffect(() => {
    if (store === null || seed === null || pending === null) return;
    let stale = false;
    let busy = false;
    setState({ status: "waiting", claiming: false });

    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const action = await checkPendingTopup(pending);
        if (stale || action === "wait") return;

        if (action === "expired") {
          clearInterval(interval);
          await expirePendingTopup(store, pending);
          if (!stale) setState({ status: "expired" });
          return;
        }

        // action === "claim"
        setState({ status: "waiting", claiming: true });
        const outcome = await claimPendingTopup(store, seed, pending);
        if (stale) return;
        switch (outcome.kind) {
          case "claimed":
            clearInterval(interval);
            setState({ status: "claimed", amount: outcome.amount });
            break;
          case "unpaid":
            // Race: claimable at check time, not at claim time — back to
            // polling (the interval is still running).
            setState({ status: "waiting", claiming: false });
            break;
          case "expired":
            clearInterval(interval);
            setState({ status: "expired" });
            break;
          case "failed":
            clearInterval(interval);
            setState({ status: "failed", errorTag: outcome.errorTag });
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
  }, [store, seed, pending, attempt]);

  return state;
};
