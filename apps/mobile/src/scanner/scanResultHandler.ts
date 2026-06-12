/**
 * Scan-capture handler (#48) — the impure half of the unified parser:
 * executes the pure `scanRouting.ts` decision (storage lookups, the LNURL
 * probe, navigation, toasts). The contract — outcomes, entry-point
 * semantics, who dismisses the scanner — is documented in scanContract.ts.
 *
 * `routeScannedValue` is shared with non-scanner inputs (the send screen's
 * manual/paste entry routes through it with `navigation: "push"`), so every
 * input source funnels into ONE parse+route path (feature-map contract).
 *
 * Navigation: scanner captures `replace` the scanner screen with the
 * destination (the scanner never lingers under a flow); the send screen
 * `push`es so cancel returns to it. Token import follows the pay-screen
 * convention instead: paid overlay / toast + `dismissAll()` to the tabs.
 */
import { loadSession } from "@linky/core";
import type { IdentitySession } from "@linky/core";
import { createContactsRepository } from "@linky/evolu-store";
import type { Href } from "expo-router";

import {
  insertContact,
  prefetchContactProfile,
  refreshContactFromNostr,
} from "../contacts/contactActions";
import { paidOverlay } from "../paidOverlay";
import { runAppEffect } from "../runtime";
import { getReadyLinkyStore } from "../store/storeManager";
import { toast } from "../toast";
import { loadLnurlWithdrawOffer } from "../wallet/lnurlWithdrawActions";
import { acceptScannedToken } from "../wallet/tokenActions";
import type {
  ScanCaptureHandler,
  ScanEntryPoint,
  ScanHandlerContext,
  ScanHandling,
} from "./scanContract";
import { classifyScanValue, decideScanRoute, entryRejectsPayments } from "./scanRouting";
import type { ScanDecision } from "./scanRouting";

export interface ScanRoutingContext extends ScanHandlerContext {
  /** How destinations are entered: see the module doc. */
  readonly navigation: "push" | "replace";
}

const HANDLED: ScanHandling = { kind: "handled" };

const open = (context: ScanRoutingContext, href: Href): void => {
  if (context.navigation === "push") context.router.push(href);
  else context.router.replace(href);
};

const loadIdentitySession = async (): Promise<IdentitySession | null> => {
  try {
    const session = await runAppEffect(loadSession);
    return session._tag === "IdentityLoaded" ? session.session : null;
  } catch {
    // Boot-gated screens make this unreachable; degrade to "no identity".
    return null;
  }
};

/** The entry gate's visible-rejection copy (feature map: fail visibly). */
const rejectionMessage = (entry: ScanEntryPoint, context: ScanRoutingContext): ScanHandling => ({
  kind: "unsupported",
  message: context.t(
    entry === "receive" ? "scanReceiveUnsupportedPayment" : "scanContactsUnsupportedPayment",
  ),
});

/**
 * Contact flow (#27 scan path): own npub → own profile, existing contact →
 * that contact (with a background Nostr refresh, PoC parity), fresh npub →
 * the contact is created DIRECTLY and its detail opens.
 */
const runContactFlow = async (npub: string, context: ScanRoutingContext): Promise<ScanHandling> => {
  const session = await loadIdentitySession();
  if (session !== null && session.activeNostr.identity.npub === npub) {
    toast.info(context.t("contactIsYou"));
    open(context, "/profile");
    return HANDLED;
  }

  const store = await getReadyLinkyStore();
  const existing = await createContactsRepository(store).findByNpub(npub);
  if (existing !== null) {
    toast.info(context.t("contactExists"));
    open(context, `/contact/${existing.id}`);
    // PoC parity: opening a scanned existing contact refreshes it from Nostr.
    void refreshContactFromNostr(store, { id: existing.id, npub });
    return HANDLED;
  }

  const { id } = insertContact(store, { name: null, npub, lnAddress: null, groupName: null });
  prefetchContactProfile(npub);
  toast.success(context.t("contactSaved"));
  open(context, `/contact/${id}`);
  return HANDLED;
};

/** Token import (#38 `cashu.accept-token`, scan path). */
const runTokenImport = async (
  token: string,
  context: ScanRoutingContext,
): Promise<ScanHandling> => {
  const session = await loadIdentitySession();
  if (session === null) {
    return { kind: "unsupported", message: context.t("cashuAcceptFailed") };
  }
  const store = await getReadyLinkyStore();
  const outcome = await acceptScannedToken(store, session.cashuWallet.seed, token);

  switch (outcome.kind) {
    case "accepted":
      paidOverlay.show(
        outcome.amount > 0
          ? context.t("paidReceived", { amount: outcome.amount, unit: "sat" })
          : context.t("cashuAccepted"),
      );
      context.router.dismissAll();
      return HANDLED;
    case "exists":
      toast.info(context.t("cashuExists"));
      context.router.dismissAll();
      return HANDLED;
    case "failed":
      // Bearer value was preserved as an error row — surface it so the #38
      // repair flow (re-accept) is one tap away. Mint down ≠ value lost.
      toast.error(context.t("cashuAcceptFailed"));
      if (outcome.tokenRowId === null) {
        return { kind: "unsupported", message: context.t("cashuAcceptFailed") };
      }
      open(context, `/wallet/token/${outcome.tokenRowId}`);
      return HANDLED;
  }
};

/**
 * Unknown-tag LNURL (bech32 `lnurl1…` / bare http): PoC semantics — try
 * withdraw first, fall back to pay on a tag mismatch. The pay fallback
 * re-applies the entry gate (a receive scan never pays).
 */
const probeLnurl = async (
  url: string,
  entry: ScanEntryPoint,
  context: ScanRoutingContext,
): Promise<ScanHandling> => {
  const offer = await loadLnurlWithdrawOffer(url);
  if (offer.kind === "ready") {
    open(context, { pathname: "/wallet/lnurl-withdraw", params: { target: url } });
    return HANDLED;
  }
  if (offer.errorTag === "LnurlTagMismatchError") {
    if (entryRejectsPayments(entry)) return rejectionMessage(entry, context);
    open(context, { pathname: "/wallet/pay-address", params: { target: url } });
    return HANDLED;
  }
  return { kind: "unsupported", message: context.t("lnurlWithdrawLoadFailed") };
};

const executeDecision = (
  decision: ScanDecision,
  entry: ScanEntryPoint,
  context: ScanRoutingContext,
): Promise<ScanHandling> => {
  switch (decision.kind) {
    case "import-token":
      return runTokenImport(decision.token, context);
    case "contact-flow":
      return runContactFlow(decision.npub, context);
    case "pay-invoice":
      open(context, { pathname: "/wallet/pay-invoice", params: { invoice: decision.invoice } });
      return Promise.resolve(HANDLED);
    case "pay-target":
      open(context, { pathname: "/wallet/pay-address", params: { target: decision.target } });
      return Promise.resolve(HANDLED);
    case "withdraw":
      open(context, { pathname: "/wallet/lnurl-withdraw", params: { target: decision.target } });
      return Promise.resolve(HANDLED);
    case "probe-lnurl":
      return probeLnurl(decision.url, entry, context);
    case "reject-payment":
      return Promise.resolve(rejectionMessage(entry, context));
    case "unsupported":
      return Promise.resolve({ kind: "unsupported", message: context.t("sendUnrecognized") });
  }
};

/**
 * THE one parse+route path. Every input surface — scanner captures, the
 * send screen's manual/paste entry — funnels through here.
 */
export const routeScannedValue = (
  value: string,
  entry: ScanEntryPoint,
  context: ScanRoutingContext,
): Promise<ScanHandling> =>
  executeDecision(decideScanRoute(classifyScanValue(value), entry), entry, context);

export const handleScanCapture: ScanCaptureHandler = (capture, context) =>
  routeScannedValue(capture.value, capture.entry, { ...context, navigation: "replace" });
