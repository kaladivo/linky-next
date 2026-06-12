/**
 * useLnurlWithdraw — drives the LNURL-withdraw screen (#40): load the offer
 * for a target, confirm it (mint quote + callback via core's
 * `withdrawViaLnurl`), then wait for the service's asynchronous payment
 * with the shared top-up poll/claim loop (#37 machinery).
 *
 * The claim leg is byte-identical to a top-up: the pending row recorded on
 * confirm is a standard pending top-up, so an abandoned withdraw is still
 * resumable from the receive screen (existing #37 affordance).
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { CashuSeed, LnurlWithdrawOffer } from "@linky/core";
import type { LinkyStore } from "@linky/evolu-store";

import { confirmLnurlWithdraw, loadLnurlWithdrawOffer } from "./lnurlWithdrawActions";
import type { PendingTopup } from "./topupActions";
import { useTopupClaimLoop } from "./useTopupClaimLoop";

export type LnurlWithdrawState =
  /** No target submitted yet (manual-entry form). */
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | {
      readonly status: "load-failed";
      readonly errorTag: string;
      readonly reason: string | null;
    }
  /** Offer preview on screen; confirm errors keep the preview visible. */
  | {
      readonly status: "offer";
      readonly offer: LnurlWithdrawOffer;
      readonly confirming: boolean;
      readonly confirmErrorTag: string | null;
      readonly confirmErrorReason: string | null;
    }
  /** Callback accepted; waiting for the service to pay the quote. */
  | {
      readonly status: "waiting";
      readonly offer: LnurlWithdrawOffer;
      readonly pending: PendingTopup;
      readonly claiming: boolean;
    }
  | { readonly status: "claimed"; readonly amount: number }
  | { readonly status: "expired" }
  | { readonly status: "claim-failed"; readonly errorTag: string };

export interface LnurlWithdrawController {
  readonly state: LnurlWithdrawState;
  readonly confirm: () => void;
  readonly retryLoad: () => void;
  readonly retryClaim: () => void;
}

type Phase =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "load-failed"; readonly errorTag: string; readonly reason: string | null }
  | {
      readonly status: "offer";
      readonly offer: LnurlWithdrawOffer;
      readonly confirming: boolean;
      readonly confirmErrorTag: string | null;
      readonly confirmErrorReason: string | null;
    }
  | {
      readonly status: "waiting";
      readonly offer: LnurlWithdrawOffer;
      readonly pending: PendingTopup;
    };

export const useLnurlWithdraw = (
  store: LinkyStore | null,
  seed: CashuSeed | null,
  target: string | null,
): LnurlWithdrawController => {
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [claimAttempt, setClaimAttempt] = useState(0);

  // Offer load (per target / retry). Resets the whole flow on target change.
  useEffect(() => {
    if (target === null || target.trim() === "") {
      setPhase({ status: "idle" });
      return;
    }
    let stale = false;
    setPhase({ status: "loading" });
    void loadLnurlWithdrawOffer(target).then(
      (outcome) => {
        if (stale) return;
        setPhase(
          outcome.kind === "ready"
            ? {
                status: "offer",
                offer: outcome.offer,
                confirming: false,
                confirmErrorTag: null,
                confirmErrorReason: null,
              }
            : { status: "load-failed", errorTag: outcome.errorTag, reason: outcome.reason },
        );
      },
      () => {
        if (!stale) setPhase({ status: "load-failed", errorTag: "UNKNOWN", reason: null });
      },
    );
    return () => {
      stale = true;
    };
  }, [target, loadAttempt]);

  const confirm = useCallback(() => {
    if (store === null || phase.status !== "offer" || phase.confirming) return;
    const offer = phase.offer;
    setPhase({
      status: "offer",
      offer,
      confirming: true,
      confirmErrorTag: null,
      confirmErrorReason: null,
    });
    const settle = (next: (current: Phase) => Phase) =>
      // Ignore the result if the flow was reset (new target) meanwhile.
      setPhase((current) =>
        current.status === "offer" && current.confirming && current.offer === offer
          ? next(current)
          : current,
      );
    void confirmLnurlWithdraw(store, offer).then(
      (outcome) =>
        settle(() =>
          outcome.kind === "submitted"
            ? { status: "waiting", offer, pending: outcome.pending }
            : {
                status: "offer",
                offer,
                confirming: false,
                confirmErrorTag: outcome.errorTag,
                confirmErrorReason: outcome.reason,
              },
        ),
      () =>
        settle(() => ({
          status: "offer",
          offer,
          confirming: false,
          confirmErrorTag: "UNKNOWN",
          confirmErrorReason: null,
        })),
    );
  }, [store, phase]);

  // Receive leg: the shared top-up poll/claim loop over the pending quote.
  const pending = phase.status === "waiting" ? phase.pending : null;
  const loop = useTopupClaimLoop(store, seed, pending, claimAttempt);

  const state: LnurlWithdrawState = useMemo(() => {
    if (phase.status !== "waiting") return phase;
    switch (loop.status) {
      case "waiting":
        return {
          status: "waiting",
          offer: phase.offer,
          pending: phase.pending,
          claiming: loop.claiming,
        };
      case "claimed":
        return { status: "claimed", amount: loop.amount };
      case "expired":
        return { status: "expired" };
      case "failed":
        return { status: "claim-failed", errorTag: loop.errorTag };
    }
  }, [phase, loop]);

  const retryLoad = useCallback(() => setLoadAttempt((value) => value + 1), []);
  const retryClaim = useCallback(() => setClaimAttempt((value) => value + 1), []);

  return { state, confirm, retryLoad, retryClaim };
};
