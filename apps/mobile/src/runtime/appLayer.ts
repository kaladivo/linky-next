/**
 * appLayer — the single composition point for every production Layer the
 * app provides to @linky/core.
 *
 * Components never see this module; they go through the hooks in
 * `useEffectQuery.ts`, which run against the one runtime built from this
 * Layer (see runtime.ts). New platform implementations join the
 * `Layer.mergeAll(...)` below — nothing else in the app changes.
 */
import {
  CurrentEnvironment,
  layerNostrPendingQueue,
  layerProfilePublisher,
  layerRelayPool,
  layerRelaySettingsStore,
} from "@linky/core";
import {
  ClipboardLive,
  DeepLinksLive,
  HttpClientLive,
  KeyValueStorageLive,
  NostrTransportLive,
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

/**
 * Nostr relay services (#21), core domain Layers on platform ports. The
 * Layer references below are shared — Layer memoization guarantees ONE
 * relay pool (one set of connections) per runtime, no matter how many
 * services build on it.
 */
const relayPoolLayer = layerRelayPool().pipe(
  Layer.provide(NostrTransportLive), // global WebSocket → NostrTransport
  Layer.provide(environmentLayer), // relay set
);
const nostrPendingQueueLayer = layerNostrPendingQueue.pipe(
  Layer.provide(relayPoolLayer),
  Layer.provide(KeyValueStorageLive), // persistent outbox
);

/**
 * User-editable relay settings (#31): the persisted relay list
 * (KeyValueStorage, env defaults as fallback) that reconciles the relay
 * pool on load and on every edit. Building this layer applies the persisted
 * list to the pool; the deferred startup task touches it so user edits hold
 * from app start, not first screen visit.
 */
const relaySettingsLayer = layerRelaySettingsStore.pipe(
  Layer.provide(relayPoolLayer),
  Layer.provide(KeyValueStorageLive), // persisted relay list
  Layer.provide(environmentLayer), // default relay set
);

/** Real Nostr kind-0 profile publishing (#24, replaces the #17 stub). */
const profilePublisherLayer = layerProfilePublisher.pipe(
  Layer.provide(relayPoolLayer),
  Layer.provide(nostrPendingQueueLayer),
  Layer.provide(RandomnessLive), // BIP-340 aux signing entropy
  Layer.provide(SecureStorageLive), // session load (active identity)
);

export const appLayer = Layer.mergeAll(
  environmentLayer,
  // Platform ports (#8), Expo-backed:
  SecureStorageLive, // expo-secure-store → SecureStorage (#14 session secrets)
  KeyValueStorageLive, // AsyncStorage → KeyValueStorage (KeyValueStore)
  RandomnessLive, // expo-crypto → Randomness
  ClipboardLive, // expo-clipboard → Clipboard
  DeepLinksLive, // expo-linking → DeepLinks
  HttpClientLive, // RN fetch → HttpClient
  // Nostr domain services (#21/#24/#31):
  relayPoolLayer, // relay connections, publish retry, subscriptions, status
  nostrPendingQueueLayer, // persistent outbox, flushed on reconnect
  profilePublisherLayer, // kind-0 profile publishing through the relay pool
  relaySettingsLayer, // user-edited relay list (#31), reconciles the pool
);

/** Everything the app runtime can provide; hooks accept Effects needing at most this. */
export type AppServices = Layer.Layer.Success<typeof appLayer>;
