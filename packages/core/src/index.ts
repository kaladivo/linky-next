/**
 * @linky/core — Effect-based domain logic and protocol workflows for Linky.
 *
 * Architecture (see README.md for the full conventions contract):
 *
 * - `src/ports/`   Effect service tags through which ALL side effects enter
 *                  (secure storage, key-value storage, HTTP, randomness).
 *                  Implementations live in `packages/platform`; tests provide
 *                  in-memory Layers.
 * - `src/domain/`  Domain workflows (identity, Cashu, Lightning/LNURL,
 *                  NIP-17 messaging, contacts, mints). Empty for now; each
 *                  workflow lands in its own issue.
 *
 * Time is NOT a custom port: workflows use Effect's built-in `Clock` service
 * (`Clock.currentTimeMillis`, `Effect.sleep`, ...) and tests control it with
 * `TestClock`. Likewise, non-secret randomness uses Effect's built-in
 * `Random`; only cryptographic entropy goes through the `Randomness` port.
 *
 * This package never imports React, Expo, the Evolu runtime, or other
 * workspace packages (enforced by ESLint) — it stays publishable and runs
 * identically under the app runtime and under test Layers.
 */

// Ports
export * from "./ports/index.js";

// Domain
export * from "./domain/index.js";
