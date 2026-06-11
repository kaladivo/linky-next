/**
 * SecureStorage adapter — maps a Keychain/Keystore-style native module
 * (expo-secure-store) onto core's `SecureStorage` port. The native module is
 * injected so the error mapping is unit-testable without a device; the Expo
 * wiring lives in `../layers.ts`.
 */
import type { SecureStorageService } from "@linky/core";
import { SecureStorage, SecureStorageError } from "@linky/core";
import { Effect, Layer, Option } from "effect";

/** The subset of `expo-secure-store` this adapter needs. */
export interface SecureStoreNativeModule {
  readonly getItemAsync: (key: string) => Promise<string | null>;
  readonly setItemAsync: (key: string, value: string) => Promise<void>;
  readonly deleteItemAsync: (key: string) => Promise<void>;
}

export const makeSecureStorage = (native: SecureStoreNativeModule): SecureStorageService => ({
  get: (key) =>
    Effect.tryPromise({
      try: async () => Option.fromNullable(await native.getItemAsync(key)),
      catch: (cause) => new SecureStorageError({ operation: "get", key, cause }),
    }),
  set: (key, value) =>
    Effect.tryPromise({
      try: () => native.setItemAsync(key, value),
      catch: (cause) => new SecureStorageError({ operation: "set", key, cause }),
    }),
  // expo-secure-store's deleteItemAsync resolves for missing keys, which
  // matches the port contract (delete is idempotent).
  delete: (key) =>
    Effect.tryPromise({
      try: () => native.deleteItemAsync(key),
      catch: (cause) => new SecureStorageError({ operation: "delete", key, cause }),
    }),
});

export const layerSecureStorage = (native: SecureStoreNativeModule): Layer.Layer<SecureStorage> =>
  Layer.succeed(SecureStorage, makeSecureStorage(native));
