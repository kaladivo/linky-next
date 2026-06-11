/**
 * KeyValueStorage port — non-secret preferences and small app state
 * (selected mint, relay list overrides, UI flags).
 *
 * We do not define our own tag: the port IS `@effect/platform`'s
 * `KeyValueStore`, re-exported here under the Linky port name so domain code
 * imports it from `@linky/core` like every other port.
 *
 * Usage:
 *
 * ```ts
 * import { Effect } from "effect";
 * import { KeyValueStorage } from "@linky/core";
 *
 * const program = Effect.gen(function* () {
 *   const kv = yield* KeyValueStorage.KeyValueStore;
 *   yield* kv.set("preferredMint", "https://testnut.cashu.space");
 * });
 * ```
 *
 * `packages/platform` provides the production Layer (e.g. AsyncStorage /
 * MMKV backed); tests use the built-in `KeyValueStorage.layerMemory`.
 *
 * Never put secrets here — secrets go through `SecureStorage`.
 */
export * as KeyValueStorage from "@effect/platform/KeyValueStore";
