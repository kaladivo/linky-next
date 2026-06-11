/**
 * Evolu-backed CounterStore (issue #35) — the production Layer for core's
 * #32 `CounterStore` port (NUT-13 deterministic counters + restore
 * cursors).
 *
 * ## Storage decision (PoC checked, documented per the issue)
 *
 * The PoC does NOT keep counters in Evolu: they live in localStorage
 * (`linky.cashu.detCounter.v1:*` / `linky.cashu.restoreCursor.v1:*`,
 * `apps/web-app/src/utils/cashuDeterministic.ts`), i.e. strictly
 * device-local and never synced. We match those semantics with the
 * local-only `_cashuCounter` table (leading `_`: Evolu applies mutations
 * outside the CRDT/sync pipeline; rows never reach `evolu_history`).
 *
 * Why NOT the synced wallet lane: an Evolu column is a last-writer-wins
 * register, so two devices bumping the same keyset concurrently would
 * converge to ONE of the values — the device holding the higher counter can
 * be overwritten by a lower one, and a counter moving backwards means
 * reused blinded messages (the exact failure the #32 fund-safety contract
 * forbids). Device-local counters can only ever lag, never regress, and a
 * lagging counter is safe: mint operations collide loudly ("outputs already
 * signed") and the engine's NUT-09 restore + `ensureCounterAtLeast`
 * fast-forward past the collision. Cross-device races are handled the same
 * way — by recovery, not by syncing the optimization.
 *
 * What restore looks like: same device / same database file → counters are
 * right there (this Layer reads them back, including through a re-derived
 * owner instance — local rows don't depend on lane owners). Fresh device
 * from the master secret → counters start at 0 and `cashu.restore-tokens`
 * rebuilds them, identical to the PoC's behavior after a localStorage wipe.
 *
 * ## Shape
 *
 * One `_cashuCounter` row per canonical counter key (core
 * `counterStoreKey`: versioned prefix + normalized mint + unit + keyset —
 * the `(mint, unit, keyset) -> counter` mapping is part of the funds
 * contract and stays byte-identical to the PoC). Row ids are
 * `createIdFromString(key)`, so writes are idempotent per-key upserts with
 * no read-modify race on row identity. Values are stringified non-negative
 * integers; key/value validation can never fire for them (defect, not a
 * typed error, if it somehow does).
 *
 * All counter/lock/clamping semantics come from core's `CounterStoreKeyValue`
 * (the same code the #32 contract tests pin down); this module only supplies
 * the persistence backend.
 */
import { Effect, Layer, Option } from "effect";

import { createIdFromString } from "@evolu/common";
import { CounterStoreKeyValue, KeyValueStorage } from "@linky/core";
import type { CounterStore } from "@linky/core";

import type { LinkyStore } from "./createLinkyStore";
import type { CashuCounterId } from "./schema";

/** Casts a validated plain value to a branded query-builder value. */
const asParam = (value: string | number): never => value as never;

/** Deterministic row id for a counter key (idempotent per-key upserts). */
const counterRowId = (key: string): CashuCounterId =>
  createIdFromString<"CashuCounter">(`cashuCounter:${key}`);

/**
 * A string KeyValueStore over the local-only `_cashuCounter` table. Scoped
 * to counter persistence on purpose: values must be non-empty strings of at
 * most 100 chars (the counter store only ever writes stringified integers).
 */
export const createCashuCounterKeyValueStore = (
  store: LinkyStore,
): KeyValueStorage.KeyValueStore => {
  const rowByKey = (key: string) =>
    Effect.promise(async () => {
      const query = store.evolu.createQuery((db) =>
        db.selectFrom("_cashuCounter").selectAll().where("key", "=", asParam(key)).limit(1),
      );
      const rows = await store.evolu.loadQuery(query);
      return rows[0] ?? null;
    });

  const allRows = Effect.promise(async () => {
    const query = store.evolu.createQuery((db) => db.selectFrom("_cashuCounter").selectAll());
    return store.evolu.loadQuery(query);
  });

  return KeyValueStorage.makeStringOnly({
    get: (key) =>
      Effect.map(rowByKey(key), (row) =>
        row === null ? Option.none() : Option.some(String(row.value)),
      ),
    // Writes AWAIT Evolu's onComplete: the port's read-bump sequences chain
    // a read directly after a write (under the per-keyset lock), so a write
    // must be visible to the next query before the Effect completes.
    set: (key, value) =>
      Effect.async<void>((resume) => {
        const result = store.upsert(
          "_cashuCounter",
          { id: counterRowId(key), key, value },
          { onComplete: () => resume(Effect.void) },
        );
        if (!result.ok) {
          // Unreachable for counter writes (stringified non-negative
          // integers); a malformed external write is a defect, not a
          // recoverable state.
          resume(Effect.die(new Error("cashu counter write failed validation")));
        }
      }),
    remove: (key) =>
      Effect.flatMap(rowByKey(key), (row) =>
        row === null
          ? Effect.void
          : Effect.async<void>((resume) => {
              // Local-only table: Evolu physically deletes the row on isDeleted.
              store.update(
                "_cashuCounter",
                { id: row.id, isDeleted: 1 },
                { onComplete: () => resume(Effect.void) },
              );
            }),
      ),
    clear: Effect.flatMap(allRows, (rows) =>
      Effect.forEach(
        rows,
        (row) =>
          Effect.async<void>((resume) => {
            store.update(
              "_cashuCounter",
              { id: row.id, isDeleted: 1 },
              { onComplete: () => resume(Effect.void) },
            );
          }),
        { discard: true },
      ),
    ),
    size: Effect.map(allRows, (rows) => rows.length),
  });
};

/**
 * Production `CounterStore` Layer over a Linky store. Behavior (defaults,
 * clamping, monotonic ratchet, per-keyset FIFO lock) is core's
 * `CounterStoreKeyValue` — only persistence lives here.
 */
export const createCashuCounterStoreLayer = (store: LinkyStore): Layer.Layer<CounterStore> =>
  Layer.provide(
    CounterStoreKeyValue,
    Layer.succeed(KeyValueStorage.KeyValueStore, createCashuCounterKeyValueStore(store)),
  );
