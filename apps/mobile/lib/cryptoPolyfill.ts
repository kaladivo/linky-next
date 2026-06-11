/**
 * crypto.getRandomValues polyfill for Hermes.
 *
 * Evolu (via @noble/hashes) needs a CSPRNG; Hermes does not provide
 * `crypto.getRandomValues`. Evolu's own Expo example installs
 * react-native-quick-crypto for this — `expo-crypto` is the lighter,
 * Expo-native equivalent for the only API we need.
 *
 * Import this module BEFORE any `@evolu/*` import.
 */
import { getRandomValues } from "expo-crypto";

type GetRandomValues = <T extends ArrayBufferView | null>(array: T) => T;

interface MutableCryptoLike {
  getRandomValues?: GetRandomValues;
}

const globalWithCrypto = globalThis as { crypto?: MutableCryptoLike };

globalWithCrypto.crypto ??= {};
globalWithCrypto.crypto.getRandomValues ??= getRandomValues as GetRandomValues;
