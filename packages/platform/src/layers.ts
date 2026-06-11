/**
 * Production Layers — the Expo-backed implementations of the @linky/core
 * ports. `apps/mobile` composes these once into its ManagedRuntime.
 *
 * This module is the only place in the package that touches Expo APIs; all
 * mapping logic lives in `./adapters/` where it is unit-testable. Expo
 * native modules autolink through the app, so every module imported here is
 * also declared in `apps/mobile/package.json`.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { FetchHttpClient } from "@effect/platform";
import * as ExpoClipboard from "expo-clipboard";
import * as ExpoCrypto from "expo-crypto";
import * as ExpoLinking from "expo-linking";
import * as ExpoSecureStore from "expo-secure-store";

import { layerClipboard } from "./adapters/clipboard";
import { layerDeepLinks } from "./adapters/deepLinks";
import { layerKeyValueStorage } from "./adapters/keyValueStorage";
import { layerRandomness } from "./adapters/randomness";
import { layerSecureStorage } from "./adapters/secureStorage";

/** `SecureStorage` backed by expo-secure-store (iOS Keychain / Android Keystore). */
export const SecureStorageLive = layerSecureStorage(ExpoSecureStore);

/** `KeyValueStorage` (`@effect/platform` KeyValueStore) backed by AsyncStorage. */
export const KeyValueStorageLive = layerKeyValueStorage(AsyncStorage);

/** `Randomness` backed by expo-crypto's CSPRNG. */
export const RandomnessLive = layerRandomness(ExpoCrypto);

/** `Clipboard` backed by expo-clipboard. */
export const ClipboardLive = layerClipboard(ExpoClipboard);

/** `DeepLinks` backed by expo-linking (initial URL + "url" events). */
export const DeepLinksLive = layerDeepLinks(ExpoLinking);

/**
 * `HttpClient` backed by React Native's global `fetch` via
 * `FetchHttpClient.layer`. RN/Hermes provides `fetch`, `Headers`,
 * `AbortController` and `TextEncoder`, which is all the fetch client needs
 * for request/response bodies; response *streaming* is not supported by RN's
 * fetch and must not be relied on.
 */
export const HttpClientLive = FetchHttpClient.layer;
