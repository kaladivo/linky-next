/**
 * KeyValueStorage adapter — maps an AsyncStorage-style native module
 * (@react-native-async-storage/async-storage) onto the `@effect/platform`
 * `KeyValueStore` that core re-exports as the `KeyValueStorage` port.
 *
 * String-only by construction (`KeyValueStore.makeStringOnly`): AsyncStorage
 * stores strings, and the derived `getUint8Array`/`modifyUint8Array` come for
 * free from the constructor. Failures surface as the platform-standard
 * `SystemError` (`PlatformError`) with `module: "KeyValueStore"`.
 */
import { Error as PlatformError, KeyValueStore } from "@effect/platform";
import { Effect, Layer, Option } from "effect";

/** The subset of AsyncStorage this adapter needs. */
export interface AsyncStorageNativeModule {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
  readonly removeItem: (key: string) => Promise<void>;
  readonly clear: () => Promise<void>;
  readonly getAllKeys: () => Promise<readonly string[]>;
}

const tryStorage = <A>(method: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new PlatformError.SystemError({
        reason: "Unknown",
        module: "KeyValueStore",
        method,
        description: "AsyncStorage operation failed",
        cause,
      }),
  });

export const makeKeyValueStorage = (
  native: AsyncStorageNativeModule,
): KeyValueStore.KeyValueStore =>
  KeyValueStore.makeStringOnly({
    get: (key) => tryStorage("get", async () => Option.fromNullable(await native.getItem(key))),
    set: (key, value) => tryStorage("set", () => native.setItem(key, value)),
    remove: (key) => tryStorage("remove", () => native.removeItem(key)),
    clear: tryStorage("clear", () => native.clear()),
    size: tryStorage("size", async () => (await native.getAllKeys()).length),
  });

export const layerKeyValueStorage = (
  native: AsyncStorageNativeModule,
): Layer.Layer<KeyValueStore.KeyValueStore> =>
  Layer.succeed(KeyValueStore.KeyValueStore, makeKeyValueStorage(native));
