/**
 * Pay-flow actions (#39; `lightning.pay-invoice` / `lightning.pay-address` /
 * `lnurl.pay`) — the impure half over ./payModel.ts, following the
 * topupActions conventions: plain async functions over the session store,
 * typed workflow errors mapped to plain outcome values (screens render
 * outcomes, never Effect errors), repository write failures on
 * app-controlled values thrown as defects.
 *
 * Token bookkeeping per payment (#33 state machine):
 *
 *   select accepted records at ONE mint (payModel candidates)
 *     → `Reserve` them (melt funding, per the #33 reserved-state contract)
 *     → record a pending `transaction` row (phase breadcrumbs)
 *     → melt via core (#34 workflows; change preserved as NUT-08 change)
 *     → success: funding rows `MarkSpent`, change token inserted as a fresh
 *       `accepted` row, transaction completed (fee + support-safe details)
 *     → failure: funding rows `Return`ed to accepted, transaction failed.
 *
 * A crash mid-melt leaves the rows `reserved` — exactly what the #38 token
 * screens repair (check / return), and the proofs themselves stay safe (the
 * mint decides; core re-filters unspent proofs on the next attempt).
 *
 * Secrecy: `detailsJson` carries invoice/address/preimage strings only —
 * never serialized tokens or proofs (TransactionsRepository contract; the
 * PoC stored `usedInputTokens`/`gainedToken`, deliberately dropped here).
 */
import type { Bolt11Invoice, CashuSeed, LnurlSuccessAction } from "@linky/core";
import {
  TokenStateTransition,
  inferLightningAddressFromLnurl,
  isLightningAddress,
  normalizeMintUrl,
  parseBolt11Invoice,
  payBolt11Invoice,
  payLightningAddress,
} from "@linky/core";
import type { AppliedTokenTransition, ContactRecord, LinkyStore } from "@linky/evolu-store";
import {
  createContactsRepository,
  createMintsRepository,
  createTokensRepository,
  createTransactionsRepository,
} from "@linky/evolu-store";
import { Effect, Option } from "effect";

import { insertContact } from "../contacts/contactActions";
import { environment } from "../environment";
import { runAppEffect, runCashuEffect } from "../runtime";
import { getReadyLinkyStore, invalidateStoreData } from "../store/storeManager";
import type { PayFailure, PayMintCandidate } from "./payModel";
import { buildPayMintCandidates, selectPayMintCandidate } from "./payModel";

export const PAY_TRANSACTION_CATEGORY = "lightning";
export const PAY_INVOICE_METHOD = "invoice";
export const PAY_ADDRESS_METHOD = "lnaddress";

export type PayOutcome =
  | {
      readonly kind: "paid";
      /** Invoice amount actually paid (melt quote amount). */
      readonly amountSat: number;
      /** Actual LN fee the mint reported (0 when it reports none). */
      readonly feeSat: number;
      /** NUT-08 change preserved back into the wallet. */
      readonly changeSat: number;
      /** LUD-09 success action (address/LNURL pays only). */
      readonly successAction: LnurlSuccessAction | null;
    }
  | PayFailure;

const failed = (errorTag: string, detail: string | null = null): PayOutcome => ({
  kind: "failed",
  errorTag,
  detail,
});

/** Support-safe reason detail of a typed workflow error (never raw objects). */
const errorDetail = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  for (const field of ["reason", "detail"]) {
    const value = record[field];
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 300);
  }
  return null;
};

// ---------------------------------------------------------------------------
// Reads (screen seams)
// ---------------------------------------------------------------------------

/** Parsed invoice for the confirmation screen; null = not a bolt11 invoice. */
export const loadInvoicePreview = (invoiceText: string): Effect.Effect<Bolt11Invoice | null> =>
  parseBolt11Invoice(invoiceText).pipe(
    Effect.map((invoice): Bolt11Invoice | null => invoice),
    Effect.orElseSucceed(() => null),
  );

/** The contact already holding this Lightning address, or null. */
export const findContactByLnAddress = async (
  lnAddress: string,
): Promise<ContactRecord | null> => {
  const needle = lnAddress.trim().toLowerCase();
  if (needle === "") return null;
  const store = await getReadyLinkyStore();
  const contacts = await createContactsRepository(store).list();
  return (
    contacts.find(
      (contact) => String(contact.lnAddress ?? "").trim().toLowerCase() === needle,
    ) ?? null
  );
};

/** Saves a paid-but-unknown recipient as a contact (`lightning.pay-address`). */
export const saveRecipientAsContact = async (lnAddress: string): Promise<{ id: string }> => {
  const store = await getReadyLinkyStore();
  return insertContact(store, {
    name: null,
    npub: null,
    lnAddress: lnAddress.trim(),
    groupName: null,
  });
};

// ---------------------------------------------------------------------------
// Funding selection
// ---------------------------------------------------------------------------

/**
 * The single mint funding "amount X": PoC candidate ordering (sum desc, the
 * main-mint preference last) over the session store's accepted records.
 */
const selectFunding = async (
  store: LinkyStore,
  amountSat: number,
): Promise<PayMintCandidate | null> => {
  const mints = createMintsRepository(store);
  const preferred = normalizeMintUrl(
    (await mints.getMainMintUrl()) ?? environment.cashuMintUrl,
  );
  const records = await createTokensRepository(store).list({ states: ["accepted"] });
  return selectPayMintCandidate(buildPayMintCandidates(records, preferred), amountSat);
};

// ---------------------------------------------------------------------------
// Shared melt runner
// ---------------------------------------------------------------------------

interface MeltDetails {
  readonly lightningInvoice?: string;
  readonly lightningMemo?: string;
  readonly lightningAddress?: string;
  readonly lightningPreimage?: string;
  readonly lnurlSuccessMessage?: string;
  readonly lnurlSuccessUrl?: string;
}

interface MeltRun {
  readonly method: string;
  readonly amountSat: number;
  readonly candidate: PayMintCandidate;
  readonly contactId?: string | undefined;
  readonly details: MeltDetails;
  /** The melt workflow; returns core's PayInvoiceResult + extra details. */
  readonly melt: () => Promise<
    | {
        readonly ok: true;
        readonly payment: {
          readonly paidAmount: number;
          readonly feePaid: number;
          readonly changeAmount: number;
          readonly changeToken: Option.Option<string>;
          readonly paymentPreimage: Option.Option<string>;
          readonly unit: string;
        };
        readonly extraDetails: MeltDetails;
        readonly successAction: LnurlSuccessAction | null;
      }
    | { readonly ok: false; readonly errorTag: string; readonly detail: string | null }
  >;
}

const transitionOrThrow = async (
  store: LinkyStore,
  recordId: string,
  transition: AppliedTokenTransition,
): Promise<void> => {
  const result = await createTokensRepository(store).transition(recordId, transition, Date.now());
  if (!result.ok) {
    throw new Error(`pay funding transition failed: ${result.error._tag}`);
  }
};

/** Reserve → pending tx → melt → settle rows + tx (see module doc). */
const runMeltPayment = async (store: LinkyStore, run: MeltRun): Promise<PayOutcome> => {
  const tokens = createTokensRepository(store);
  const transactions = createTransactionsRepository(store);
  const { candidate } = run;

  for (const record of candidate.records) {
    await transitionOrThrow(store, record.id, TokenStateTransition.Reserve());
  }

  const recorded = transactions.record({
    happenedAtSec: Math.max(1, Math.floor(Date.now() / 1000)),
    direction: "out",
    status: "pending",
    category: PAY_TRANSACTION_CATEGORY,
    method: run.method,
    phase: "melt",
    amount: run.amountSat,
    unit: candidate.unit,
    mintUrl: candidate.mintUrl,
    ...(run.contactId === undefined ? {} : { contactId: run.contactId }),
    detailsJson: JSON.stringify(run.details),
  });
  if (!recorded.ok) throw new Error(`record pay transaction failed: ${recorded.error._tag}`);
  invalidateStoreData();

  const outcome = await run.melt();

  if (!outcome.ok) {
    for (const record of candidate.records) {
      await transitionOrThrow(store, record.id, TokenStateTransition.Return());
    }
    transactions.update(recorded.value.id, {
      status: "failed",
      phase: "melt",
      error: `${outcome.errorTag}${outcome.detail === null ? "" : `: ${outcome.detail}`}`,
    });
    invalidateStoreData();
    return failed(outcome.errorTag, outcome.detail);
  }

  const { payment } = outcome;

  // Change first, consumption second: a crash in between double-COUNTS
  // (visibly repairable via NUT-07 check) instead of double-SPENDS trust in
  // rows whose proofs are gone.
  const changeToken = Option.getOrNull(payment.changeToken);
  if (changeToken !== null && payment.changeAmount > 0) {
    const inserted = tokens.insert({
      mintUrl: candidate.mintUrl,
      unit: payment.unit,
      amount: payment.changeAmount,
      state: "accepted",
      token: changeToken,
    });
    if (!inserted.ok) throw new Error(`store change token failed: ${inserted.error._tag}`);
  }
  for (const record of candidate.records) {
    await transitionOrThrow(store, record.id, TokenStateTransition.MarkSpent());
  }

  const preimage = Option.getOrNull(payment.paymentPreimage);
  transactions.update(recorded.value.id, {
    status: "completed",
    phase: "complete",
    amount: payment.paidAmount,
    feeAmount: payment.feePaid,
    detailsJson: JSON.stringify({
      ...run.details,
      ...outcome.extraDetails,
      ...(preimage === null ? {} : { lightningPreimage: preimage }),
    }),
  });
  invalidateStoreData();

  return {
    kind: "paid",
    amountSat: payment.paidAmount,
    feeSat: payment.feePaid,
    changeSat: payment.changeAmount,
    successAction: outcome.successAction,
  };
};

// ---------------------------------------------------------------------------
// Pay a BOLT11 invoice (`lightning.pay-invoice`)
// ---------------------------------------------------------------------------

export const payBolt11FromWallet = async (
  store: LinkyStore,
  seed: CashuSeed,
  invoiceText: string,
): Promise<PayOutcome> => {
  const parsed = await runAppEffect(Effect.either(parseBolt11Invoice(invoiceText)));
  if (parsed._tag === "Left") return failed(parsed.left._tag, errorDetail(parsed.left));
  const invoice = parsed.right;
  if (invoice.amountSat === null) return failed("InvoiceAmountRequiredError");

  const candidate = await selectFunding(store, invoice.amountSat);
  if (candidate === null) return failed("InsufficientFundsError");

  return runMeltPayment(store, {
    method: PAY_INVOICE_METHOD,
    amountSat: invoice.amountSat,
    candidate,
    details: {
      lightningInvoice: invoice.invoice,
      ...(invoice.description === null ? {} : { lightningMemo: invoice.description }),
    },
    melt: () =>
      runCashuEffect(
        store,
        payBolt11Invoice({
          seed,
          mintUrl: candidate.mintUrl,
          tokens: candidate.records.map((record) => record.token),
          invoice: invoice.invoice,
          unit: candidate.unit,
        }).pipe(
          Effect.map((result) => ({
            ok: true as const,
            payment: result.payment,
            extraDetails: {},
            successAction: null,
          })),
          Effect.catchAll((error) =>
            Effect.succeed({
              ok: false as const,
              errorTag: error._tag,
              detail: errorDetail(error),
            }),
          ),
        ),
      ),
  });
};

// ---------------------------------------------------------------------------
// Pay a Lightning address / LNURL-pay target (`lightning.pay-address`, `lnurl.pay`)
// ---------------------------------------------------------------------------

export interface PayAddressArgs {
  /** Lightning address (`user@domain`) or any LNURL-pay target. */
  readonly target: string;
  readonly amountSat: number;
  /** Counterparty contact, when the address belongs to a known contact. */
  readonly contactId?: string | undefined;
  /** Optional LUD-12 comment. */
  readonly comment?: string | undefined;
}

/** The address-shaped display/save identity of an LNURL-pay target. */
export const lnAddressOf = (target: string): string | null => {
  const trimmed = target.trim();
  if (isLightningAddress(trimmed)) return trimmed;
  return inferLightningAddressFromLnurl(trimmed);
};

export const payLnurlTargetFromWallet = async (
  store: LinkyStore,
  seed: CashuSeed,
  args: PayAddressArgs,
): Promise<PayOutcome> => {
  if (!Number.isFinite(args.amountSat) || args.amountSat <= 0) {
    return failed("InvalidAmountError");
  }
  const candidate = await selectFunding(store, args.amountSat);
  if (candidate === null) return failed("InsufficientFundsError");

  const address = lnAddressOf(args.target);

  return runMeltPayment(store, {
    method: PAY_ADDRESS_METHOD,
    amountSat: args.amountSat,
    candidate,
    contactId: args.contactId,
    details: { lightningAddress: address ?? args.target.trim() },
    melt: () =>
      runCashuEffect(
        store,
        payLightningAddress({
          seed,
          mintUrl: candidate.mintUrl,
          tokens: candidate.records.map((record) => record.token),
          target: args.target,
          amountSat: args.amountSat,
          comment: args.comment,
          unit: candidate.unit,
        }).pipe(
          Effect.map((result) => ({
            ok: true as const,
            payment: result.payment,
            extraDetails: {
              lightningInvoice: result.invoice,
              ...(result.metadata.description === null
                ? {}
                : { lightningMemo: result.metadata.description }),
              ...(result.successAction?._tag === "message"
                ? { lnurlSuccessMessage: result.successAction.message }
                : {}),
              ...(result.successAction?._tag === "url"
                ? { lnurlSuccessUrl: result.successAction.url }
                : {}),
            },
            successAction: result.successAction,
          })),
          Effect.catchAll((error) =>
            Effect.succeed({
              ok: false as const,
              errorTag: error._tag,
              detail: errorDetail(error),
            }),
          ),
        ),
      ),
  });
};
