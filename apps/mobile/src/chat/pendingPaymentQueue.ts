/**
 * Pending contact-payment queue — impure half (#46, `chat-pay.queue`) over
 * ./pendingPaymentsModel.ts. See the model's module doc for WHAT an intent
 * is (unminted amount+peer; minted tokens live in the core
 * NostrPendingQueue) and for the expiry policy.
 *
 * ## Storage & ordering
 *
 * Intents persist as a JSON array under `linky.chatPay.pendingPayments.v1`
 * (KeyValueStorage port), enqueue order = retry order; mutations serialize
 * on a promise chain (single JS context). PoC counterpart:
 * `linky.local.pendingPayments.v1` + `usePaymentsDomain`.
 *
 * ## Retry triggers (PoC: `window.online` + state changes)
 *
 * - relay-pool reconnect transition (the app's "back online" signal, same
 *   wiring as core `runPendingFlushLoop`), which includes app start while
 *   online because `statusChanges` replays the current value;
 * - app foreground (AppState → "active") — catches mint-only outages and
 *   runs the expiry sweep even while relays are already connected.
 *
 * ## Fund safety on retry
 *
 * The flush REMOVES an intent from storage BEFORE attempting it and
 * re-enqueues (with the ORIGINAL id + createdAtSec — the expiry anchor)
 * only when the attempt ended "queued" again, i.e. nothing was minted.
 * A crash mid-attempt therefore loses at most the INTENT, never funds, and
 * can never double-mint; flushes are additionally single-flight.
 * (PoC divergence — the PoC removed entries only AFTER success, so a crash
 * between mint and removal could double-pay on restart.)
 *
 * Definitive failures (insufficient funds, invalid peer, mint protocol
 * errors) drop the intent and mark the row failed + toast. (PoC divergence
 * — the PoC kept ALL failures queued forever; with expiry in place,
 * keeping only connectivity failures is what makes the queue's state
 * honest.)
 *
 * ## Expiry
 *
 * Expired intents (24 h, model doc) are removed, their pending spend row
 * flips to failed with `TX_ERROR_QUEUE_EXPIRED` (history shows the
 * "expired" pill) and a toast tells the user nothing was sent — the funds
 * never left the wallet, which IS the funds-return guarantee for an
 * unminted intent.
 */
import { KeyValueStorage, RelayPool, loadSession } from "@linky/core";
import { createContactsRepository, createTransactionsRepository } from "@linky/evolu-store";
import type { Translator } from "@linky/locales";
import { Effect, Option, Stream } from "effect";
import { AppState } from "react-native";

import { runAppEffect } from "../runtime";
import { getStoreState, invalidateStoreData } from "../store/storeManager";
import { toast } from "../toast";
import {
  QUEUED_TRANSACTION_PHASE,
  TX_ERROR_QUEUE_EXPIRED,
} from "../wallet/transactionsModel";
import { makeClientTag, nowSec } from "./chatActions";
import type { ChatPayOutcome } from "./chatPayActions";
import { sendCashuInChat } from "./chatPayActions";
import type { PendingPaymentIntent } from "./pendingPaymentsModel";
import {
  PENDING_PAYMENTS_STORAGE_KEY,
  decodePendingPayments,
  encodePendingPayments,
  partitionPendingPayments,
} from "./pendingPaymentsModel";

// ---------------------------------------------------------------------------
// Storage (KeyValueStorage port, serialized mutations)
// ---------------------------------------------------------------------------

const readQueue = (): Promise<ReadonlyArray<PendingPaymentIntent>> =>
  runAppEffect(
    Effect.gen(function* () {
      const kv = yield* KeyValueStorage.KeyValueStore;
      const raw = yield* kv
        .get(PENDING_PAYMENTS_STORAGE_KEY)
        .pipe(Effect.catchAll(() => Effect.succeed(Option.none<string>())));
      return decodePendingPayments(Option.getOrNull(raw));
    }),
  ).catch(() => []);

const writeQueue = (intents: ReadonlyArray<PendingPaymentIntent>): Promise<void> =>
  runAppEffect(
    Effect.gen(function* () {
      const kv = yield* KeyValueStorage.KeyValueStore;
      yield* kv
        .set(PENDING_PAYMENTS_STORAGE_KEY, encodePendingPayments(intents))
        .pipe(Effect.catchAll(() => Effect.void));
    }),
  ).catch(() => undefined);

/** Mutations serialize here so concurrent enqueue/remove never lose writes. */
let mutationChain: Promise<unknown> = Promise.resolve();

const mutateQueue = (
  mutate: (intents: ReadonlyArray<PendingPaymentIntent>) => ReadonlyArray<PendingPaymentIntent>,
): Promise<void> => {
  const next = mutationChain.then(async () => {
    const current = await readQueue();
    const updated = mutate(current);
    if (updated !== current) await writeQueue(updated);
  });
  mutationChain = next.catch(() => undefined);
  return next;
};

/** The queued intents, oldest first (dev panel + tests + flush). */
export const listPendingPayments = (): Promise<ReadonlyArray<PendingPaymentIntent>> =>
  readQueue();

/** Adds an intent; an already-queued id is a no-op (idempotent). */
export const enqueuePendingPayment = (intent: PendingPaymentIntent): Promise<void> =>
  mutateQueue((intents) =>
    intents.some((existing) => existing.id === intent.id) ? intents : [...intents, intent],
  );

const removePendingPayment = (id: string): Promise<void> =>
  mutateQueue((intents) => {
    const next = intents.filter((intent) => intent.id !== id);
    return next.length === intents.length ? intents : next;
  });

// ---------------------------------------------------------------------------
// Send-or-queue (the chat pay sheet's Cashu path for saved contacts)
// ---------------------------------------------------------------------------

/**
 * The #44 send with the #46 queue seam armed: a `MintConnectionError`
 * before minting persists the intent (the "queued" outcome's pending row id
 * keeps history at one row per intent). Saved contacts only — PoC parity:
 * the PoC queue keyed on contact rows.
 */
export const sendCashuToContactOrQueue = async (
  store: Parameters<typeof sendCashuInChat>[0],
  args: { readonly peerNpub: string; readonly contactId: string; readonly amountSat: number },
): Promise<ChatPayOutcome> => {
  const outcome = await sendCashuInChat(store, {
    peerNpub: args.peerNpub,
    amountSat: args.amountSat,
    contactId: args.contactId,
    offlineQueue: {},
  });
  if (outcome.kind === "queued") {
    await enqueuePendingPayment({
      id: makeClientTag(),
      contactId: args.contactId,
      peerNpub: args.peerNpub,
      amountSat: outcome.amountSat,
      createdAtSec: nowSec(),
      transactionId: outcome.transactionId,
    });
  }
  return outcome;
};

// ---------------------------------------------------------------------------
// Flush (expiry sweep + retries)
// ---------------------------------------------------------------------------

let translator: Translator | null = null;
let flushInFlight: Promise<void> | null = null;

const expireIntent = (intent: PendingPaymentIntent): void => {
  const storeState = getStoreState();
  if (storeState.status === "ready") {
    createTransactionsRepository(storeState.store).update(intent.transactionId, {
      status: "failed",
      phase: QUEUED_TRANSACTION_PHASE,
      error: TX_ERROR_QUEUE_EXPIRED,
    });
    invalidateStoreData();
  }
  const t = translator;
  if (t !== null) toast.info(t("payQueuedExpired"));
};

const flushOnce = async (): Promise<void> => {
  const storeState = getStoreState();
  if (storeState.status !== "ready") return;
  const store = storeState.store;

  const intents = await listPendingPayments();
  if (intents.length === 0) return;

  // Expiry sweep first — runs regardless of connectivity (local-only).
  const { expired, due } = partitionPendingPayments(intents, nowSec());
  for (const intent of expired) {
    await removePendingPayment(intent.id);
    expireIntent(intent);
  }
  if (due.length === 0) return;

  // Retries need the active session (PoC: `if (!currentNsec) return`).
  // Bailing here keeps the intents queued — never dropped while logged out.
  try {
    const session = await runAppEffect(loadSession);
    if (session._tag !== "IdentityLoaded") return;
  } catch {
    return;
  }

  const contacts = createContactsRepository(store);
  const t = translator;

  for (const intent of due) {
    // PoC parity: an intent whose contact is gone is dropped (its row goes
    // failed so history stays honest).
    const contact = await contacts.getById(intent.contactId);
    if (contact === null) {
      await removePendingPayment(intent.id);
      createTransactionsRepository(store).update(intent.transactionId, {
        status: "failed",
        phase: QUEUED_TRANSACTION_PHASE,
        error: "contact removed",
      });
      invalidateStoreData();
      continue;
    }

    // Fund safety: drop the intent BEFORE attempting (module doc) — a crash
    // mid-attempt loses the intent, never mints twice.
    await removePendingPayment(intent.id);
    const outcome = await sendCashuInChat(store, {
      peerNpub: intent.peerNpub,
      amountSat: intent.amountSat,
      contactId: intent.contactId,
      offlineQueue: { reuseTransactionId: intent.transactionId },
    });
    if (outcome.kind === "queued") {
      // Still unreachable, nothing minted — back in line with the ORIGINAL
      // id and createdAtSec (the expiry anchor must not refresh).
      await enqueuePendingPayment(intent);
      continue;
    }
    if (outcome.kind === "failed" && t !== null) {
      toast.error(
        `${t("payFailed")}${outcome.detail === null ? "" : `: ${outcome.detail}`}`,
      );
    }
    // "sent" is silent (PoC `fromQueue` suppressed UI): the token bubble
    // appears in the chat and the history row completes visibly.
  }
};

/** Single-flight flush; safe to call from any trigger. Never throws. */
export const flushPendingPayments = (): Promise<void> => {
  if (flushInFlight !== null) return flushInFlight;
  const run = flushOnce()
    .catch((defect: unknown) => {
      if (__DEV__) console.warn("[chat-pay] pending-payment flush died:", defect);
    })
    .finally(() => {
      flushInFlight = null;
    });
  flushInFlight = run;
  return run;
};

// ---------------------------------------------------------------------------
// Trigger wiring (deferred startup task)
// ---------------------------------------------------------------------------

let initialized = false;

/**
 * Idempotent wiring; called once from the deferred startup tasks (#46).
 * Flushes on every relay-pool reconnect transition and app foreground.
 */
export const initPendingPaymentFlushRunner = (t: Translator): void => {
  translator = t;
  if (initialized) return;
  initialized = true;

  // Relay reconnect loop (mirrors core runPendingFlushLoop): "no relay" →
  // "≥ 1 connected" is the queue's back-online signal; the replayed current
  // value covers app start while online.
  void runAppEffect(
    Effect.gen(function* () {
      const pool = yield* RelayPool;
      yield* pool.statusChanges.pipe(
        Stream.map((statuses) =>
          [...statuses.values()].some((status) => status === "connected"),
        ),
        Stream.changes,
        Stream.filter((anyConnected) => anyConnected),
        Stream.runForEach(() => Effect.promise(() => flushPendingPayments())),
      );
    }),
  ).catch((defect: unknown) => {
    console.warn("[chat-pay] pending-payment flush loop died:", defect);
  });

  AppState.addEventListener("change", (state) => {
    if (state === "active") void flushPendingPayments();
  });
};

// ---------------------------------------------------------------------------
// Dev hooks (dev/pay-queue verification screen)
// ---------------------------------------------------------------------------

/** DEV: backdates every queued intent past the expiry window. */
export const devExpirePendingPayments = (): Promise<void> =>
  mutateQueue((intents) =>
    intents.map((intent) => ({ ...intent, createdAtSec: 1 })),
  );
