/**
 * runCashuEffect — runAppEffect for Cashu workflows that need the
 * `CounterStore` port (#32 deterministic counters), whose production
 * backend is the SESSION-SCOPED Evolu store (#35
 * `createCashuCounterStoreLayer`), not a Layer in `appLayer`.
 *
 * Why not appLayer: the one app runtime is built once per JS context, but
 * counters live in the per-identity store (created on session load, torn
 * down on logout). So the CounterStore service is built per store and
 * provided per call, on top of the app runtime's other services.
 *
 * ONE service instance per store (WeakMap-memoized): the #32 contract
 * serializes counter-consuming mint operations through an in-memory
 * per-keyset FIFO lock that lives INSIDE the service. Rebuilding the Layer
 * per call would give every call its own lock map and void the contract.
 *
 * See docs/effect-react-bridge.md, "Cashu workflows and the session-scoped
 * CounterStore".
 */
// MUST stay before any @evolu import (pulled in via @linky/evolu-store):
// installs crypto.getRandomValues — same rule as storeManager.ts.
import "../../lib/cryptoPolyfill";

import type { CounterStoreService } from "@linky/core";
import { CounterStore } from "@linky/core";
import type { LinkyStore } from "@linky/evolu-store";
import { createCashuCounterStoreLayer } from "@linky/evolu-store";
import { Effect } from "effect";

import type { AppServices } from "./appLayer";
import { runAppEffect } from "./runAppEffect";

const counterStores = new WeakMap<LinkyStore, Promise<CounterStoreService>>();

/** The memoized CounterStore service for a session store. */
const counterStoreFor = (store: LinkyStore): Promise<CounterStoreService> => {
  const cached = counterStores.get(store);
  if (cached !== undefined) return cached;
  // The Layer holds no scoped resources (it closes over the store's
  // `_cashuCounter` table), so extracting the built service once is safe —
  // and exactly what guarantees the single shared lock map.
  const built = runAppEffect(
    CounterStore.pipe(Effect.provide(createCashuCounterStoreLayer(store))),
  );
  counterStores.set(store, built);
  return built;
};

/**
 * Runs a workflow that may require `AppServices` plus `CounterStore`,
 * providing the CounterStore of the given session store. Same promise
 * semantics as `runAppEffect` (rejects on typed failures and defects).
 */
export const runCashuEffect = async <A, E>(
  store: LinkyStore,
  effect: Effect.Effect<A, E, AppServices | CounterStore>,
): Promise<A> => {
  const counters = await counterStoreFor(store);
  return runAppEffect(Effect.provideService(effect, CounterStore, counters));
};
