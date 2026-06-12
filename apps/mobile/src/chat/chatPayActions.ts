/**
 * Chat-payment actions (#44; `chat-pay.send-cashu` / `chat-pay.receive-cashu`
 * / `chat-pay.notice`) — the impure half over ./chatPaymentsModel.ts, where
 * the pillars meet: money moves as messages.
 *
 * ## Send (`sendCashuInChat`)
 *
 * 1. mint selection — single-mint payment over the PoC comparator
 *    (payModel: sum desc, main mint last); one payment never splits mints;
 * 2. pending SPEND transaction row (`contacts`/`cashu-chat`), funding rows
 *    `Reserve`d (#33), then `createSendToken` swaps the exact amount
 *    (change kept as a fresh `accepted` row, funding rows `MarkSpent`);
 * 3. the send token is stored as an `issued` entry (the #33 state the
 *    claim detection later flips to `spent`), and the EMIT row
 *    (`cashu`/`emit`, `detailsJson.issuedTokenId`) is recorded — together
 *    with the spend row's `detailsJson.usedTokenIds` this is the #43
 *    emit-then-send history merge;
 * 4. the token chat message goes out QUIET (kind 14, content = token, NO
 *    push marker on either wrap — the push relay must not alert on bearer
 *    material), optimistic-pending exactly like a text send;
 * 5. a SEPARATE payment notice (kind 24133, golden-pinned wire shape) goes
 *    out MARKED, recipient-wrap only — that one rings the phone (#51/#52).
 *
 * ## Receive (`acceptIncomingTokenMessage`)
 *
 * Called by the chat inbox runner for newly APPLIED inbound messages whose
 * content carries a token (replays/echoes are rumor-id deduped before this
 * runs, so duplicates never double-accept). The token is auto-accepted
 * into the wallet (core `receiveToken` swap → fresh `accepted` row) and the
 * receive is logged as a completed `contacts`/`cashu-chat` "in" row; a
 * failed accept (e.g. already spent — the mint is the duplicate authority
 * across DIFFERENT messages carrying the same token) logs a failed row,
 * because error records are valuable for support.
 */
import type { CashuSeed, NostrIdentity } from "@linky/core";
import {
  createGiftWrap,
  createRumor,
  deliverNostrEvent,
  LINKY_PUSH_MARKER_TAG,
  loadSession,
  makeChatMessageTemplate,
  makePaymentNoticeTemplate,
  normalizeMintUrl,
  npubToPublicKeyHex,
  TokenStateTransition,
  createSendToken,
  receiveToken,
} from "@linky/core";
import type { LinkyStore } from "@linky/evolu-store";
import {
  createContactsRepository,
  createMessagesRepository,
  createMintsRepository,
  createTokensRepository,
  createTransactionsRepository,
} from "@linky/evolu-store";
import { Effect } from "effect";

import { environment } from "../environment";
import { runAppEffect, runCashuEffect } from "../runtime";
import { invalidateStoreData } from "../store/storeManager";
import type { PayFailure } from "../wallet/payModel";
import { buildPayMintCandidates, selectPayMintCandidate } from "../wallet/payModel";
import {
  ISSUED_TOKEN_ID_DETAIL,
  USED_TOKEN_IDS_DETAIL,
} from "../wallet/transactionsModel";
import { makeClientTag, nowSec, publishChatTemplate } from "./chatActions";
import {
  CHAT_PAY_TRANSACTION_CATEGORY,
  CHAT_PAY_TRANSACTION_METHOD,
  EMIT_TRANSACTION_CATEGORY,
  EMIT_TRANSACTION_METHOD,
  tokenMessageInfo,
} from "./chatPaymentsModel";

export type ChatPayOutcome =
  | { readonly kind: "sent"; readonly amountSat: number }
  | PayFailure;

const failed = (errorTag: string, detail: string | null = null): ChatPayOutcome => ({
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

interface ActivePaySession {
  readonly identity: NostrIdentity;
  readonly seed: CashuSeed;
}

/** The active identity + wallet seed, or null (defensive). */
const activePaySession = async (): Promise<ActivePaySession | null> => {
  try {
    const session = await runAppEffect(loadSession);
    if (session._tag !== "IdentityLoaded") return null;
    return {
      identity: session.session.activeNostr.identity,
      seed: session.session.cashuWallet.seed,
    };
  } catch {
    return null;
  }
};

/** Fire-and-forget notice publish: the alert half of a chat payment. */
const publishPaymentNotice = async (
  sender: NostrIdentity,
  recipientPublicKeyHex: string,
): Promise<void> => {
  try {
    const rumor = createRumor(
      makePaymentNoticeTemplate({
        senderPublicKeyHex: sender.publicKeyHex,
        recipientPublicKeyHex,
        createdAtSec: nowSec(),
        clientTag: makeClientTag(),
      }),
      sender.publicKeyHex,
    );
    await runAppEffect(
      Effect.gen(function* () {
        // ONE recipient-directed wrap WITH the push marker; no self wrap
        // (PoC parity — the notice exists only to ring the phone).
        const wrap = yield* createGiftWrap(rumor, sender.secretKey, recipientPublicKeyHex, [
          LINKY_PUSH_MARKER_TAG,
        ]);
        return yield* deliverNostrEvent(wrap);
      }),
    );
  } catch (error) {
    if (__DEV__) console.warn("[chat-pay] notice publish failed:", error);
  }
};

// ─── chat-pay.send-cashu ─────────────────────────────────────────────────

export interface SendCashuArgs {
  readonly peerNpub: string;
  readonly amountSat: number;
  /** Counterparty contact id, when the peer is a saved contact. */
  readonly contactId?: string | undefined;
}

/**
 * Sends `amountSat` as a Cashu token chat message (module doc). Resolves
 * after the optimistic message write + token bookkeeping; relay delivery
 * reconciles in the background like every chat send.
 */
export const sendCashuInChat = async (
  store: LinkyStore,
  args: SendCashuArgs,
): Promise<ChatPayOutcome> => {
  const amountSat = Math.trunc(args.amountSat);
  if (!Number.isFinite(args.amountSat) || amountSat <= 0) return failed("InvalidAmountError");

  const session = await activePaySession();
  if (session === null) return failed("NoSessionError");
  const sender = session.identity;
  const peerHex = npubToPublicKeyHex(args.peerNpub);
  if (peerHex === null) return failed("InvalidNpubError");

  const tokens = createTokensRepository(store);
  const transactions = createTransactionsRepository(store);

  // Mint selection: single-mint payment, PoC comparator (main mint last).
  const mints = createMintsRepository(store);
  const preferred = normalizeMintUrl(
    (await mints.getMainMintUrl()) ?? environment.cashuMintUrl,
  );
  const accepted = await tokens.list({ states: ["accepted"] });
  const candidate = selectPayMintCandidate(
    buildPayMintCandidates(accepted, preferred),
    amountSat,
  );
  if (candidate === null) return failed("InsufficientFundsError");

  // Pending spend row first — an interrupted payment leaves an honest record.
  const spendRow = transactions.record({
    happenedAtSec: Math.max(1, Math.floor(Date.now() / 1000)),
    direction: "out",
    status: "pending",
    category: CHAT_PAY_TRANSACTION_CATEGORY,
    method: CHAT_PAY_TRANSACTION_METHOD,
    phase: "emit",
    amount: amountSat,
    unit: candidate.unit,
    mintUrl: candidate.mintUrl,
    ...(args.contactId === undefined ? {} : { contactId: args.contactId }),
  });
  if (!spendRow.ok) throw new Error(`record chat-pay transaction failed: ${spendRow.error._tag}`);
  invalidateStoreData();

  const transitionOrThrow = async (
    recordId: string,
    transition: Parameters<typeof tokens.transition>[1],
  ): Promise<void> => {
    const result = await tokens.transition(recordId, transition, Date.now());
    if (!result.ok) throw new Error(`chat-pay funding transition failed: ${result.error._tag}`);
  };

  for (const record of candidate.records) {
    await transitionOrThrow(record.id, TokenStateTransition.Reserve());
  }

  const swapped = await runCashuEffect(
    store,
    createSendToken({
      seed: session.seed,
      mintUrl: candidate.mintUrl,
      amount: amountSat,
      tokens: candidate.records.map((record) => record.token),
      unit: candidate.unit,
    }).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catchAll((error) =>
        Effect.succeed({ ok: false as const, errorTag: error._tag, detail: errorDetail(error) }),
      ),
    ),
  );

  if (!swapped.ok) {
    for (const record of candidate.records) {
      await transitionOrThrow(record.id, TokenStateTransition.Return());
    }
    transactions.update(spendRow.value.id, {
      status: "failed",
      phase: "emit",
      error: `${swapped.errorTag}${swapped.detail === null ? "" : `: ${swapped.detail}`}`,
    });
    invalidateStoreData();
    return failed(swapped.errorTag, swapped.detail);
  }
  const { result } = swapped;

  // Change first, consumption second (same crash trade-off as payActions).
  if (result.keepToken._tag === "Some" && result.keepAmount > 0) {
    const kept = tokens.insert({
      mintUrl: result.mintUrl,
      unit: result.unit,
      amount: result.keepAmount,
      state: "accepted",
      token: result.keepToken.value,
    });
    if (!kept.ok) throw new Error(`store change token failed: ${kept.error._tag}`);
  }
  for (const record of candidate.records) {
    await transitionOrThrow(record.id, TokenStateTransition.MarkSpent());
  }

  // The issued entry: the outgoing token, waiting to be claimed (#33).
  const issued = tokens.insert({
    mintUrl: result.mintUrl,
    unit: result.unit,
    amount: result.sendAmount,
    state: "issued",
    token: result.sendToken,
  });
  if (!issued.ok) throw new Error(`store issued token failed: ${issued.error._tag}`);

  // Emit row — merged into the spend row by #43 (issuedTokenId key).
  const emitRow = transactions.record({
    happenedAtSec: Math.max(1, Math.floor(Date.now() / 1000)),
    direction: "out",
    status: "completed",
    category: EMIT_TRANSACTION_CATEGORY,
    method: EMIT_TRANSACTION_METHOD,
    phase: "complete",
    amount: result.sendAmount,
    unit: result.unit,
    mintUrl: result.mintUrl,
    detailsJson: JSON.stringify({ [ISSUED_TOKEN_ID_DETAIL]: issued.value.id }),
  });
  if (!emitRow.ok) throw new Error(`record emit transaction failed: ${emitRow.error._tag}`);

  // Token chat message: optimistic pending row, QUIET delivery.
  const template = makeChatMessageTemplate({
    senderPublicKeyHex: sender.publicKeyHex,
    recipientPublicKeyHex: peerHex,
    content: result.sendToken,
    createdAtSec: nowSec(),
    clientTag: makeClientTag(),
  });
  const rumor = createRumor(template, sender.publicKeyHex);
  const messages = createMessagesRepository(store);
  const applied = await messages.applyChatEvent({
    kind: "message",
    rumorId: rumor.id,
    peerNpub: args.peerNpub,
    senderNpub: sender.npub,
    direction: "out",
    content: result.sendToken,
    sentAtSec: rumor.created_at,
    status: "pending",
  });
  if (!applied.ok) {
    // The value is safe (issued row + emit row exist); surface the storage
    // failure but leave the wallet consistent.
    transactions.update(spendRow.value.id, {
      status: "failed",
      phase: "publish",
      error: `message store failed: ${applied.error.reason}`,
      detailsJson: JSON.stringify({ [USED_TOKEN_IDS_DETAIL]: [issued.value.id] }),
    });
    invalidateStoreData();
    return failed("MessageStoreError");
  }
  invalidateStoreData();

  // Delivery: token message (quiet) first, then the marked notice — only
  // after the token message actually left the device (PoC ordering).
  void publishChatTemplate(template, sender, peerHex, { pushMarker: false }).then(
    async ({ outcome, selfWrapId }) => {
      if (outcome === "accepted") {
        await messages.markSent(rumor.id, selfWrapId ?? undefined);
        invalidateStoreData();
      }
      if (outcome !== "failed") void publishPaymentNotice(sender, peerHex);
    },
  );

  transactions.update(spendRow.value.id, {
    status: "completed",
    phase: "complete",
    amount: result.sendAmount,
    detailsJson: JSON.stringify({ [USED_TOKEN_IDS_DETAIL]: [issued.value.id] }),
  });
  invalidateStoreData();

  return { kind: "sent", amountSat: result.sendAmount };
};

// ─── chat-pay.receive-cashu ──────────────────────────────────────────────

export interface IncomingTokenMessage {
  /** Conversation peer (the sender of the token). */
  readonly peerNpub: string;
  readonly content: string;
}

export type AcceptIncomingOutcome = "accepted" | "not-a-token" | "failed" | "no-session";

/**
 * Auto-accepts a token carried by a newly applied inbound chat message.
 * Caller contract (chatInboxRunner): only for `outcome: "applied"` inbound
 * messages — rumor-id dedup upstream is what makes replays no-ops.
 */
export const acceptIncomingTokenMessage = async (
  store: LinkyStore,
  message: IncomingTokenMessage,
): Promise<AcceptIncomingOutcome> => {
  const info = tokenMessageInfo(message.content);
  if (info === null) return "not-a-token";

  const session = await activePaySession();
  if (session === null) return "no-session";

  const contacts = await createContactsRepository(store).list();
  const contactId =
    contacts.find((contact) => String(contact.npub ?? "") === message.peerNpub)?.id ?? null;

  const transactions = createTransactionsRepository(store);
  const received = await runCashuEffect(
    store,
    receiveToken({ seed: session.seed, token: info.tokenText }).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catchAll((error) =>
        Effect.succeed({ ok: false as const, errorTag: error._tag, detail: errorDetail(error) }),
      ),
    ),
  );

  if (!received.ok) {
    transactions.record({
      happenedAtSec: Math.max(1, Math.floor(Date.now() / 1000)),
      direction: "in",
      status: "failed",
      category: CHAT_PAY_TRANSACTION_CATEGORY,
      method: CHAT_PAY_TRANSACTION_METHOD,
      phase: "receive",
      amount: info.amountSat,
      unit: info.unit,
      mintUrl: info.mintUrl,
      ...(contactId === null ? {} : { contactId }),
      error: `${received.errorTag}${received.detail === null ? "" : `: ${received.detail}`}`,
    });
    invalidateStoreData();
    if (__DEV__) console.warn(`[chat-pay] token accept failed: ${received.errorTag}`);
    return "failed";
  }

  const inserted = createTokensRepository(store).insert({
    mintUrl: received.result.mintUrl,
    unit: received.result.unit,
    amount: received.result.amount,
    state: "accepted",
    token: received.result.token,
  });
  if (!inserted.ok) throw new Error(`store received token failed: ${inserted.error._tag}`);

  const logged = transactions.record({
    happenedAtSec: Math.max(1, Math.floor(Date.now() / 1000)),
    direction: "in",
    status: "completed",
    category: CHAT_PAY_TRANSACTION_CATEGORY,
    method: CHAT_PAY_TRANSACTION_METHOD,
    phase: "complete",
    amount: received.result.amount,
    unit: received.result.unit,
    mintUrl: received.result.mintUrl,
    ...(contactId === null ? {} : { contactId }),
  });
  if (!logged.ok) throw new Error(`record receive transaction failed: ${logged.error._tag}`);
  invalidateStoreData();
  return "accepted";
};
