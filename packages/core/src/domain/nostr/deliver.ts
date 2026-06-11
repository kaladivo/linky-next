/**
 * deliverNostrEvent — the standard "publish with offline fallback" step for
 * signed events (`nostr.publish-retry` + `nostr.pending-flush` in the
 * feature map).
 *
 * Publishing goes through `RelayPool.publish` (per-relay retry with backoff
 * comes free). If NO relay accepts within the pool's retry policy — the
 * offline case — the signed event is enqueued to `NostrPendingQueue` and
 * goes out with the next flush (`runPendingFlushLoop` on reconnect). The
 * effect therefore never fails on a dead network: that path resolves with
 * `outcome: "queued"`. Used by relay-list publishing (#23) and profile
 * metadata / NIP-38 status publishing (#24).
 */
import { Effect } from "effect";

import type { NostrEvent } from "./NostrEvent.js";
import type { NostrPendingQueueError } from "./NostrPendingQueue.js";
import { NostrPendingQueue } from "./NostrPendingQueue.js";
import { RelayPool } from "./RelayPool.js";

/** How one signed event left the device. */
export interface NostrEventDelivery {
  readonly event: NostrEvent;
  /**
   * `"accepted"` — ≥ 1 relay ACKed (the pool keeps retrying the rest in
   * background). `"queued"` — no relay accepted within the pool's retry
   * policy (offline); the event sits in `NostrPendingQueue` and goes out on
   * the next flush.
   */
  readonly outcome: "accepted" | "queued";
}

export const deliverNostrEvent = (
  event: NostrEvent,
): Effect.Effect<NostrEventDelivery, NostrPendingQueueError, RelayPool | NostrPendingQueue> =>
  Effect.gen(function* () {
    const pool = yield* RelayPool;
    const queue = yield* NostrPendingQueue;
    const published = yield* pool.publish(event).pipe(Effect.either);
    if (published._tag === "Right") return { event, outcome: "accepted" as const };
    yield* queue.enqueue(event);
    return { event, outcome: "queued" as const };
  });
