/**
 * Top-up flow actions (`cashu.topup-quote` / `cashu.claim-topup`, #37) —
 * the impure half over ./topupQuote.ts: mint resolution, quote
 * creation/caching in the pending transaction row, polling checks and the
 * claim. Called from the receive screens via useTopupInvoice.ts.
 *
 * Error shape: every action maps typed workflow errors to plain outcome
 * values (the nostrKeyActions convention) — screens render outcomes, they
 * never see Effect errors. Repository write failures on app-controlled
 * values are bugs → thrown (defects), not outcomes.
 */
import type { CashuSeed } from "@linky/core";
import {
  checkTopupQuote,
  claimTopup,
  createTopupQuote,
  normalizeMintUrl,
} from "@linky/core";
import type { LinkyStore, TransactionRecord } from "@linky/evolu-store";
import {
  createMintsRepository,
  createTokensRepository,
  createTransactionsRepository,
} from "@linky/evolu-store";
import { Effect } from "effect";

import { environment } from "../environment";
import { runAppEffect, runCashuEffect } from "../runtime";
import { invalidateStoreData } from "../store/storeManager";
import type { PendingTopupQuote } from "./topupQuote";
import {
  TOPUP_TRANSACTION_CATEGORY,
  TOPUP_TRANSACTION_METHOD,
  canReusePendingQuote,
  isPendingQuoteStale,
  parsePendingTopupQuote,
  pendingQuoteFromTopupQuote,
  serializePendingTopupQuote,
  topupPollAction,
} from "./topupQuote";
import type { TopupPollAction } from "./topupQuote";

/** A pending top-up: the transaction row id plus its cached quote. */
export interface PendingTopup {
  readonly transactionId: string;
  readonly quote: PendingTopupQuote;
}

/**
 * The mint a top-up goes to: the synced main-mint preference, falling back
 * to the profile's env default (`mints.select-main` contract). Ensures the
 * mint row exists so the wallet knows the mint it now holds value at.
 */
export const resolveTopupMintUrl = async (store: LinkyStore): Promise<string> => {
  const mints = createMintsRepository(store);
  const preferred = await mints.getMainMintUrl();
  const mintUrl = normalizeMintUrl(preferred ?? environment.cashuMintUrl);
  const ensured = await mints.ensure(mintUrl);
  if (!ensured.ok) throw new Error(`ensure mint failed: ${ensured.error._tag}`);
  return mintUrl;
};

const isPendingTopupRow = (row: TransactionRecord): boolean =>
  row.status === "pending" &&
  row.category === TOPUP_TRANSACTION_CATEGORY &&
  row.method === TOPUP_TRANSACTION_METHOD;

/** How many newest history rows are scanned for pending top-ups. */
const PENDING_SCAN_LIMIT = 100;

/**
 * Active (fresh) pending top-ups, newest first. Stale ones (mint expiry or
 * 24h cache age passed) are marked failed/expired on the way — the resume
 * affordance must never offer a dead quote.
 */
export const loadActivePendingTopups = async (
  store: LinkyStore,
  nowMs: number,
): Promise<ReadonlyArray<PendingTopup>> => {
  const transactions = createTransactionsRepository(store);
  const page = await transactions.listPage({ limit: PENDING_SCAN_LIMIT });
  const active: PendingTopup[] = [];
  let expiredAny = false;
  for (const row of page.items) {
    if (!isPendingTopupRow(row)) continue;
    const quote = parsePendingTopupQuote(row.detailsJson);
    if (quote === null) continue;
    if (isPendingQuoteStale(quote, nowMs)) {
      transactions.update(row.id, { status: "failed", phase: "expired", error: "quote expired" });
      expiredAny = true;
      continue;
    }
    active.push({ transactionId: row.id, quote });
  }
  if (expiredAny) invalidateStoreData();
  return active;
};

export type GetQuoteOutcome =
  | { readonly kind: "ready"; readonly pending: PendingTopup }
  | { readonly kind: "failed"; readonly errorTag: string };

/**
 * The quote to display for "top up `amountSat` sat": a cached fresh quote
 * for the same mint/unit/amount when one exists (PoC reuse semantics),
 * otherwise a new mint quote, recorded as a pending transaction with the
 * quote payload in `detailsJson` (see topupQuote.ts for the decision).
 */
export const getOrCreateTopupQuote = async (
  store: LinkyStore,
  amountSat: number,
): Promise<GetQuoteOutcome> => {
  const nowMs = Date.now();
  const mintUrl = await resolveTopupMintUrl(store);

  const reusable = (await loadActivePendingTopups(store, nowMs)).find((pending) =>
    canReusePendingQuote(pending.quote, { mintUrl, amountSat }, nowMs),
  );
  if (reusable !== undefined) return { kind: "ready", pending: reusable };

  const created = await runAppEffect(
    createTopupQuote({ mintUrl, amount: amountSat }).pipe(
      Effect.map((quote) => ({ ok: true, quote }) as const),
      Effect.catchAll((error) => Effect.succeed({ ok: false, errorTag: error._tag } as const)),
    ),
  );
  if (!created.ok) return { kind: "failed", errorTag: created.errorTag };

  const quote = pendingQuoteFromTopupQuote(created.quote, nowMs);
  const recorded = createTransactionsRepository(store).record({
    happenedAtSec: Math.max(1, Math.floor(nowMs / 1000)),
    direction: "in",
    status: "pending",
    category: TOPUP_TRANSACTION_CATEGORY,
    method: TOPUP_TRANSACTION_METHOD,
    phase: "quote-created",
    amount: quote.amountSat,
    unit: quote.unit,
    mintUrl: quote.mintUrl,
    detailsJson: serializePendingTopupQuote(quote),
  });
  if (!recorded.ok) throw new Error(`record top-up transaction failed: ${recorded.error._tag}`);
  invalidateStoreData();
  return { kind: "ready", pending: { transactionId: recorded.value.id, quote } };
};

/**
 * One polling tick: recheck the quote at the mint. Network/mint failures
 * read as "wait" — polling continues, the next tick retries.
 */
export const checkPendingTopup = (pending: PendingTopup): Promise<TopupPollAction> =>
  runAppEffect(
    checkTopupQuote({
      mintUrl: pending.quote.mintUrl,
      quoteId: pending.quote.quoteId,
      unit: pending.quote.unit,
    }).pipe(
      Effect.map(topupPollAction),
      Effect.catchAll(() => Effect.succeed("wait" as const)),
    ),
  );

export type ClaimOutcome =
  | { readonly kind: "claimed"; readonly amount: number }
  /** Race: the mint reported claimable, the claim recheck says not yet. */
  | { readonly kind: "unpaid" }
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly errorTag: string };

/**
 * Claims a paid/issued quote into wallet value: core's #32 claim (counter
 * lock + NUT-09 recovery for already-issued quotes), token persisted via
 * TokensRepository (deduped on the encoded token — a crash between insert
 * and the transaction patch must not double-count on re-claim), pending
 * transaction completed.
 */
export const claimPendingTopup = async (
  store: LinkyStore,
  seed: CashuSeed,
  pending: PendingTopup,
): Promise<ClaimOutcome> => {
  const { quote } = pending;
  const claimed = await runCashuEffect(
    store,
    claimTopup({
      seed,
      mintUrl: quote.mintUrl,
      quoteId: quote.quoteId,
      amount: quote.amountSat,
      unit: quote.unit,
    }).pipe(
      Effect.map((result) => ({ ok: true, result }) as const),
      Effect.catchTag("MintQuoteNotClaimableError", (error) =>
        Effect.succeed({ ok: false, state: error.state } as const),
      ),
      Effect.catchAll((error) =>
        Effect.succeed({ ok: false, state: null, errorTag: error._tag } as const),
      ),
    ),
  );

  if (!claimed.ok) {
    if (claimed.state === "EXPIRED") {
      await expirePendingTopup(store, pending);
      return { kind: "expired" };
    }
    if (claimed.state === "UNPAID") return { kind: "unpaid" };
    return { kind: "failed", errorTag: "errorTag" in claimed ? claimed.errorTag : "UNKNOWN" };
  }

  const result = claimed.result;
  const tokens = createTokensRepository(store);
  const known = await tokens.list({ mintUrl: result.mintUrl });
  if (!known.some((record) => record.token === result.token)) {
    const inserted = tokens.insert({
      mintUrl: result.mintUrl,
      unit: result.unit,
      amount: result.amount,
      state: "accepted",
      token: result.token,
    });
    if (!inserted.ok) throw new Error(`store claimed token failed: ${inserted.error._tag}`);
  }

  createTransactionsRepository(store).update(pending.transactionId, {
    status: "completed",
    phase: result.recovered ? "claimed-recovered" : "claimed",
    amount: result.amount,
  });
  invalidateStoreData();
  return { kind: "claimed", amount: result.amount };
};

/** Marks the pending transaction failed/expired (quote dead at the mint). */
export const expirePendingTopup = async (
  store: LinkyStore,
  pending: PendingTopup,
): Promise<void> => {
  createTransactionsRepository(store).update(pending.transactionId, {
    status: "failed",
    phase: "expired",
    error: "quote expired",
  });
  invalidateStoreData();
};
