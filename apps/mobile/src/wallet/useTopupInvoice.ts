/**
 * useTopupInvoice — drives the top-up invoice screen (#37): get-or-create
 * the quote (cached quotes are reused, see topupQuote.ts), then hand the
 * pending quote to the shared poll/claim loop (useTopupClaimLoop.ts).
 *
 * Plain async on purpose (the useContactsScreenData convention):
 * repositories are plain TypeScript, the core workflows run through
 * runAppEffect/runCashuEffect inside topupActions.ts; staleness is guarded
 * with effect-scoped flags.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { CashuSeed } from "@linky/core";
import type { LinkyStore } from "@linky/evolu-store";

import { getOrCreateTopupQuote } from "./topupActions";
import type { PendingTopup } from "./topupActions";
import { useTopupClaimLoop } from "./useTopupClaimLoop";

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

type QuoteAcquisition =
  | { readonly status: "preparing" }
  | { readonly status: "ready"; readonly pending: PendingTopup }
  | { readonly status: "failed"; readonly errorTag: string };

export const useTopupInvoice = (
  store: LinkyStore | null,
  seed: CashuSeed | null,
  amountSat: number,
): TopupInvoice => {
  const [acquisition, setAcquisition] = useState<QuoteAcquisition>({ status: "preparing" });
  const [attempt, setAttempt] = useState(0);

  // Quote acquisition (per mount / retry).
  useEffect(() => {
    if (store === null || !Number.isFinite(amountSat) || amountSat <= 0) return;
    let stale = false;
    setAcquisition({ status: "preparing" });
    void getOrCreateTopupQuote(store, amountSat).then(
      (outcome) => {
        if (stale) return;
        setAcquisition(
          outcome.kind === "ready"
            ? { status: "ready", pending: outcome.pending }
            : { status: "failed", errorTag: outcome.errorTag },
        );
      },
      () => {
        if (!stale) setAcquisition({ status: "failed", errorTag: "UNKNOWN" });
      },
    );
    return () => {
      stale = true;
    };
  }, [store, amountSat, attempt]);

  // Poll + claim while the invoice is showing (shared with LNURL-withdraw).
  const pending = acquisition.status === "ready" ? acquisition.pending : null;
  const loop = useTopupClaimLoop(store, seed, pending);

  const state: TopupInvoiceState = useMemo(() => {
    if (acquisition.status === "preparing") return { status: "preparing" };
    if (acquisition.status === "failed") {
      return { status: "failed", errorTag: acquisition.errorTag, stage: "create" };
    }
    switch (loop.status) {
      case "waiting":
        return { status: "showing", pending: acquisition.pending, claiming: loop.claiming };
      case "claimed":
        return { status: "claimed", amount: loop.amount };
      case "expired":
        return { status: "expired" };
      case "failed":
        return { status: "failed", errorTag: loop.errorTag, stage: "claim" };
    }
  }, [acquisition, loop]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { state, retry };
};
