/**
 * appLayer — the single composition point for every production Layer the
 * app provides to @linky/core.
 *
 * When new platform implementations land (issue #8: secure storage,
 * key-value storage, HTTP, randomness from packages/platform), they join
 * the `Layer.mergeAll(...)` below — nothing else in the app changes.
 * Components never see this module; they go through the hooks in
 * `useEffectQuery.ts`, which run against the one runtime built from this
 * Layer (see runtime.ts).
 */
import { CurrentEnvironment } from "@linky/core";
import { RandomnessLive, SecureStorageLive } from "@linky/platform";
import { Layer } from "effect";

import { environment } from "../environment";

/**
 * The decoded build-profile configuration as an Effect service. The value
 * comes from src/environment.ts, which already crashed at startup if the
 * profile or endpoints were invalid — by the time this Layer exists, the
 * config is trustworthy.
 */
const environmentLayer = Layer.succeed(CurrentEnvironment, environment);

export const appLayer = Layer.mergeAll(
  environmentLayer,
  // #14 session persistence: keychain-backed secrets + CSPRNG entropy.
  SecureStorageLive,
  RandomnessLive,
  // Remaining #8 platform Layers slot in here as features need them, e.g.:
  //   KeyValueStorageLive, (AsyncStorage → KeyValueStore)
  //   HttpClientLive,      (FetchHttpClient.layer)
  //   ClipboardLive / DeepLinksLive
);

/** Everything the app runtime can provide; hooks accept Effects needing at most this. */
export type AppServices = Layer.Layer.Success<typeof appLayer>;
