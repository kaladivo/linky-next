# @linky/platform

Expo implementations (Effect Layers) of the [`@linky/core`](../core/README.md) ports. Core defines the ports; this package maps Expo native modules onto them and exports one production Layer per port. `apps/mobile` composes the Layers into its single `ManagedRuntime`.

## Implemented Layers

| Layer                      | Port (in `@linky/core`)                                | Backed by                                                              |
| -------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `SecureStorageLive`        | `SecureStorage`                                        | `expo-secure-store` (iOS Keychain / Android Keystore)                  |
| `KeyValueStorageLive`      | `KeyValueStorage` (`@effect/platform` `KeyValueStore`) | `@react-native-async-storage/async-storage`                            |
| `RandomnessLive`           | `Randomness`                                           | `expo-crypto` (`getRandomBytesAsync`, platform CSPRNG)                 |
| `ClipboardLive`            | `Clipboard`                                            | `expo-clipboard`                                                       |
| `DeepLinksLive`            | `DeepLinks`                                            | `expo-linking` (initial URL + `"url"` event stream)                    |
| `HttpClientLive`           | `HttpClient` (`@effect/platform`)                      | `FetchHttpClient.layer` over React Native's global `fetch`             |
| `WebSocketConstructorLive` | `Socket.WebSocketConstructor` (`@effect/platform`)     | `Socket.layerWebSocketConstructorGlobal` over RN's global `WebSocket`  |
| `NostrTransportLive`       | `NostrTransport`                                       | core's `layerNostrTransportSocket` wired to `WebSocketConstructorLive` |

Notes:

- **HTTP**: RN/Hermes ships `fetch`, `Headers`, `AbortController` — everything `FetchHttpClient` needs for plain request/response bodies (verified on-device via the dev smoke-test panel). RN's fetch does **not** support response streaming; don't build on `response.stream`.
- **WebSocket / Nostr**: React Native exposes a global `WebSocket`, so no Expo module is involved; the transport logic itself lives (and is unit-tested with a scripted fake WebSocket) in `@linky/core` — this package only injects the constructor, same pattern as `HttpClientLive`.
- **Structure**: `src/adapters/*` contains the native-module-injected adapters (`make*` / `layer*`) where all error mapping lives and is unit-tested with fake natives; `src/layers.ts` is the only module importing Expo APIs and wires the real modules into the `*Live` Layers.

## Rules

- This package imports **Expo native modules + Effect + `@linky/core` only** — never React or react-native UI (enforced by ESLint `no-restricted-imports`).
- Every Expo module used here is also declared in `apps/mobile/package.json` — autolinking happens through the app. Native permissions/entitlements are declared exclusively in `apps/mobile/app.config.ts` via config plugins (CNG): `expo-secure-store` has its plugin entry there; clipboard / async-storage / crypto / linking need none.
- Layers map every native failure into the port's typed error before it escapes (`SecureStorageError`, `RandomnessError`, `ClipboardError`, `DeepLinksError`, `PlatformError` for KV).

## Deferred (issue #8 allows landing incrementally)

Not implemented yet — no port definitions were added to core for these because their shapes depend on the consuming milestone's needs:

- **Camera / QR scanning** (M5, issue #47): port + `expo-camera`-based implementation land with the scanner feature.
- **Local notifications** (M6): port + `expo-notifications` implementation land with the notifications milestone.
- **NFC** (M5, issue #50): port + implementation land with the NFC issue. Reminder for the implementer: NFC hardware does not exist on simulators — the Layer must degrade gracefully (report "unavailable" as a value, not crash) so the rest of the app runs on simulators unchanged.

## Scripts

`pnpm typecheck` / `lint` / `test` (vitest; adapters are tested against in-memory fake natives — real native calls are exercised by the dev smoke-test panel in `apps/mobile`).
