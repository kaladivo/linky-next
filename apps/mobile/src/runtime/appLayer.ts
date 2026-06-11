/**
 * appLayer — the single composition point for every production Layer the
 * app provides to @linky/core.
 *
 * Components never see this module; they go through the hooks in
 * `useEffectQuery.ts`, which run against the one runtime built from this
 * Layer (see runtime.ts). New platform implementations join the
 * `Layer.mergeAll(...)` below — nothing else in the app changes.
 */
import { CurrentEnvironment } from "@linky/core";
import {
  ClipboardLive,
  DeepLinksLive,
  HttpClientLive,
  KeyValueStorageLive,
  RandomnessLive,
  SecureStorageLive,
} from "@linky/platform";
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
  // Platform ports (#8), Expo-backed:
  SecureStorageLive, // expo-secure-store → SecureStorage (#14 session secrets)
  KeyValueStorageLive, // AsyncStorage → KeyValueStorage (KeyValueStore)
  RandomnessLive, // expo-crypto → Randomness
  ClipboardLive, // expo-clipboard → Clipboard
  DeepLinksLive, // expo-linking → DeepLinks
  HttpClientLive, // RN fetch → HttpClient
);

/** Everything the app runtime can provide; hooks accept Effects needing at most this. */
export type AppServices = Layer.Layer.Success<typeof appLayer>;
