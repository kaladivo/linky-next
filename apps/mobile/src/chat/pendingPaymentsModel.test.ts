/**
 * `chat-pay.queue` policy tests (#46): the queue is LOCAL-ONLY (no wire
 * shape to golden-pin), so the policy surface is pinned here instead —
 * codec robustness, the 24 h expiry constant and the expiry partition.
 */
import { describe, expect, it } from "vitest";

import type { PendingPaymentIntent } from "./pendingPaymentsModel";
import {
  PENDING_PAYMENTS_STORAGE_KEY,
  QUEUED_PAYMENT_EXPIRY_SEC,
  decodePendingPayments,
  encodePendingPayments,
  isPendingPaymentExpired,
  partitionPendingPayments,
} from "./pendingPaymentsModel";

const intent = (overrides: Partial<PendingPaymentIntent> = {}): PendingPaymentIntent => ({
  id: "q1",
  contactId: "contact-1",
  peerNpub: "npub1example",
  amountSat: 21,
  createdAtSec: 1_000_000,
  transactionId: "tx-1",
  ...overrides,
});

describe("pending payment queue policy (#46)", () => {
  it("pins the storage key and the 24h expiry window", () => {
    // Policy pin: neither Cashu nor NUT-18 defines an intent lifetime and
    // the PoC queued forever; 24 h (the LND-default BOLT11 invoice
    // lifetime) is the documented Linky policy. Changing this is a
    // product decision, not a refactor.
    expect(PENDING_PAYMENTS_STORAGE_KEY).toBe("linky.chatPay.pendingPayments.v1");
    expect(QUEUED_PAYMENT_EXPIRY_SEC).toBe(86_400);
  });

  it("round-trips intents through the codec", () => {
    const intents = [intent(), intent({ id: "q2", amountSat: 42, transactionId: "tx-2" })];
    expect(decodePendingPayments(encodePendingPayments(intents))).toEqual(intents);
  });

  it("decodes defensively: corrupt payloads and invalid entries never wedge the queue", () => {
    expect(decodePendingPayments(null)).toEqual([]);
    expect(decodePendingPayments("")).toEqual([]);
    expect(decodePendingPayments("not json")).toEqual([]);
    expect(decodePendingPayments('{"v":1}')).toEqual([]);
    const mixed = JSON.stringify([
      intent(),
      { id: "bad", amountSat: -1 }, // invalid entry dropped
      intent({ id: "q3" }),
      { ...intent({ id: "q4" }), amountSat: 1.5 }, // non-integer amount dropped
      { ...intent({ id: "q5" }), peerNpub: " " }, // blank peer dropped
    ]);
    expect(decodePendingPayments(mixed).map((entry) => entry.id)).toEqual(["q1", "q3"]);
  });

  it("expires exactly at the window boundary (>= 24h)", () => {
    const created = 1_000_000;
    const entry = intent({ createdAtSec: created });
    expect(isPendingPaymentExpired(entry, created + QUEUED_PAYMENT_EXPIRY_SEC - 1)).toBe(false);
    expect(isPendingPaymentExpired(entry, created + QUEUED_PAYMENT_EXPIRY_SEC)).toBe(true);
  });

  it("partitions expired vs due while preserving enqueue order", () => {
    const now = 2_000_000;
    const old = intent({ id: "old", createdAtSec: now - QUEUED_PAYMENT_EXPIRY_SEC - 5 });
    const fresh1 = intent({ id: "fresh1", createdAtSec: now - 10 });
    const old2 = intent({ id: "old2", createdAtSec: now - QUEUED_PAYMENT_EXPIRY_SEC });
    const fresh2 = intent({ id: "fresh2", createdAtSec: now - 1 });
    const { expired, due } = partitionPendingPayments([old, fresh1, old2, fresh2], now);
    expect(expired.map((entry) => entry.id)).toEqual(["old", "old2"]);
    expect(due.map((entry) => entry.id)).toEqual(["fresh1", "fresh2"]);
  });
});
