/**
 * TEMPORARY dev-only transaction-history seed (#43): demo rows inserted
 * through the REAL TransactionsRepository so the history list/detail can
 * be verified before the missing writer flows exist. Triggered from the
 * dev settings seed panel; remove once #44/#45 make it redundant.
 *
 * Row set exercises every #43 surface at once:
 *  - completed lightning pay (fee, invoice, preimage, contact link),
 *  - FAILED lightning pay with the error kept (the "error records are
 *    never discarded" path),
 *  - pending + completed top-ups (quote payload in detailsJson),
 *  - an emit row + spend row pair keyed on a token ROW id (the #44 merge
 *    contract) — must render as ONE history item,
 *  - a pending payment request and a fulfilled (paid) request pair (the
 *    #45 request-status contract; declined needs #45's chat data).
 *
 * Every row carries `devSeed: true` in detailsJson (idempotence marker;
 * also keeps the rows trivially identifiable in support dumps).
 */
import type { LinkyStore, NewTransaction } from "@linky/evolu-store";
import { createContactsRepository, createTransactionsRepository } from "@linky/evolu-store";

import {
  ISSUED_TOKEN_ID_DETAIL,
  REQUEST_ID_DETAIL,
  REQUEST_TEXT_DETAIL,
  REQUEST_TRANSACTION_METHOD,
  USED_TOKEN_IDS_DETAIL,
} from "../wallet/transactionsModel";
import { DEV_SEED_MINT_URL } from "./devWalletSeed";

/** Bob — the committed second dev identity (see DevSeedPanel). */
const BOB_NPUB = "npub1swl0lmqxtuz75j6chdq9p3lntq5ruf792458fhdty7wlm4kw7ecq47mgja";

const details = (payload: Record<string, unknown>): string =>
  JSON.stringify({ ...payload, devSeed: true });

/** True when a row's detailsJson carries the dev-seed marker. */
const isDevSeedRow = (detailsJson: string | null): boolean => {
  if (detailsJson === null) return false;
  try {
    const value: unknown = JSON.parse(detailsJson);
    return typeof value === "object" && value !== null && (value as Record<string, unknown>)["devSeed"] === true;
  } catch {
    return false;
  }
};

/** Idempotent: re-running after the rows exist is a no-op. */
export const seedDevTransactions = async (
  store: LinkyStore,
): Promise<"seeded" | "already-seeded"> => {
  const transactions = createTransactionsRepository(store);
  const page = await transactions.listPage({ limit: 200 });
  if (page.items.some((row) => isDevSeedRow(row.detailsJson))) return "already-seeded";

  const bob = await createContactsRepository(store).findByNpub(BOB_NPUB);
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();

  const rows: ReadonlyArray<NewTransaction> = [
    // Completed lightning pay with full support surface (+ contact link).
    {
      happenedAtSec: nowSec - 6 * 3600,
      direction: "out",
      status: "completed",
      category: "lightning",
      method: "lnaddress",
      phase: "complete",
      amount: 2100,
      feeAmount: 2,
      unit: "sat",
      mintUrl: DEV_SEED_MINT_URL,
      ...(bob === null ? {} : { contactId: bob.id }),
      detailsJson: details({
        lightningAddress: "bob@ln.example.org",
        lightningInvoice: `lnbc21u1devseedinvoice${"x".repeat(40)}`,
        lightningMemo: "lunch",
        lightningPreimage: `${"ab".repeat(32)}`,
        lnurlSuccessMessage: "Thanks for the lunch!",
      }),
    },
    // FAILED lightning pay — the error record stays visible forever.
    {
      happenedAtSec: nowSec - 5 * 3600,
      direction: "out",
      status: "failed",
      category: "lightning",
      method: "invoice",
      phase: "melt",
      amount: 5000,
      unit: "sat",
      mintUrl: DEV_SEED_MINT_URL,
      error: "MintProtocolError: 502 Bad Gateway",
      detailsJson: details({
        lightningInvoice: `lnbc50u1devseedfailedinvoice${"y".repeat(36)}`,
      }),
    },
    // Pending top-up (quote payload — the resume/poll machinery sees it).
    {
      happenedAtSec: nowSec - 1800,
      direction: "in",
      status: "pending",
      category: "lightning",
      method: "invoice",
      phase: "quote-created",
      amount: 10_000,
      unit: "sat",
      mintUrl: DEV_SEED_MINT_URL,
      detailsJson: details({
        mintUrl: DEV_SEED_MINT_URL,
        unit: "sat",
        amountSat: 10_000,
        quoteId: "dev-seed-quote-pending",
        invoice: `lnbc100u1devseedpendingtopup${"z".repeat(34)}`,
        expiresAtSec: nowSec + 24 * 3600,
        createdAtMs: nowMs,
      }),
    },
    // Completed top-up.
    {
      happenedAtSec: nowSec - 2 * 24 * 3600,
      direction: "in",
      status: "completed",
      category: "lightning",
      method: "invoice",
      phase: "claimed",
      amount: 50_000,
      unit: "sat",
      mintUrl: DEV_SEED_MINT_URL,
      detailsJson: details({
        mintUrl: DEV_SEED_MINT_URL,
        unit: "sat",
        amountSat: 50_000,
        quoteId: "dev-seed-quote-claimed",
        invoice: `lnbc500u1devseedclaimedtopup${"w".repeat(34)}`,
        expiresAtSec: nowSec - 2 * 24 * 3600 + 600,
        createdAtMs: nowMs - 2 * 24 * 3600 * 1000,
      }),
    },
    // Emit half of the #44 merge pair — must be HIDDEN by the spend below.
    {
      happenedAtSec: nowSec - 3 * 3600,
      direction: "out",
      status: "completed",
      category: "cashu",
      method: "token",
      phase: "issued",
      amount: 500,
      unit: "sat",
      mintUrl: DEV_SEED_MINT_URL,
      detailsJson: details({ [ISSUED_TOKEN_ID_DETAIL]: "dev-seed-token-row-1" }),
    },
    // Spend half: consumed the emitted token — renders as the ONE item.
    {
      happenedAtSec: nowSec - 2 * 3600,
      direction: "out",
      status: "completed",
      category: "contacts",
      method: "chat",
      phase: "delivered",
      amount: 500,
      unit: "sat",
      mintUrl: DEV_SEED_MINT_URL,
      ...(bob === null ? {} : { contactId: bob.id }),
      detailsJson: details({ [USED_TOKEN_IDS_DETAIL]: ["dev-seed-token-row-1"] }),
    },
    // Pending payment request (#45 shape) — pill must read "pending".
    {
      happenedAtSec: nowSec - 900,
      direction: "in",
      status: "pending",
      category: "cashu",
      method: REQUEST_TRANSACTION_METHOD,
      amount: 1500,
      unit: "sat",
      ...(bob === null ? {} : { contactId: bob.id }),
      detailsJson: details({
        [REQUEST_ID_DETAIL]: "dev-seed-request-pending",
        [REQUEST_TEXT_DETAIL]: "Split for the climbing tickets",
      }),
    },
    // Fulfilled request pair: request row + completed fulfillment → "paid".
    {
      happenedAtSec: nowSec - 24 * 3600,
      direction: "in",
      status: "pending",
      category: "cashu",
      method: REQUEST_TRANSACTION_METHOD,
      amount: 800,
      unit: "sat",
      detailsJson: details({
        [REQUEST_ID_DETAIL]: "dev-seed-request-paid",
        [REQUEST_TEXT_DETAIL]: "Coffee debt",
      }),
    },
    {
      happenedAtSec: nowSec - 23 * 3600,
      direction: "in",
      status: "completed",
      category: "cashu",
      method: "token",
      phase: "accepted",
      amount: 800,
      unit: "sat",
      mintUrl: DEV_SEED_MINT_URL,
      detailsJson: details({ [REQUEST_ID_DETAIL]: "dev-seed-request-paid" }),
    },
  ];

  for (const row of rows) {
    const recorded = transactions.record(row);
    if (!recorded.ok) throw new Error(`seed transaction failed: ${recorded.error._tag}`);
  }
  return "seeded";
};
