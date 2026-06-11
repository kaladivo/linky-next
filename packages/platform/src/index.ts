/**
 * @linky/platform — Expo implementations (Layers) of the @linky/core ports.
 *
 * - `./layers`    Production Layers (`*Live`), the package's public API.
 * - `./adapters/*`   Native-module-injected adapters; exported for tests and
 *                    for wiring alternative native modules.
 *
 * This package never imports React or react-native UI — only Expo native
 * modules and Effect. See README.md for what is implemented vs deferred.
 */
export * from "./layers";

export * from "./adapters/secureStorage";
export * from "./adapters/keyValueStorage";
export * from "./adapters/randomness";
export * from "./adapters/clipboard";
export * from "./adapters/deepLinks";
