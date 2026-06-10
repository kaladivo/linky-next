# Native Capabilities

Scope: Platform features needed by mobile clients and future web/desktop adapters.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `native.packaged-assets` | Bundled web assets | Loads built app assets from the native bundle by default. | Native launch | Live reload must be explicit so releases do not point at localhost. |
| `native.build-identity` | Native build identity | Separates debug package/label and release versioning. | Android builds | Debug installs side-by-side; release version follows workspace version unless overridden. |
| `native.secure-storage` | Secure storage | Stores identity and wallet secrets. | Whole app | Required for mobile production. |
| `native.clipboard` | Clipboard | Copies/pastes text. | QR, tokens, addresses, scanner | Must not log sensitive values. |
| `native.share` | Share sheet | Shares token/profile/payment links. | Token/profile detail | Platform-specific. |
| `native.camera` | Camera scanner | Scans QR codes. | Scanner | Keep fallback actions when unavailable. |
| `native.deep-link` | Deep links | Handles native `nostr://` and `cashu://` app-launch/NFC links. | App launch | Pending deeplink is cached and consumed after the web app is ready. |
| `native.notifications` | Notification permission/token | Registers push capability. | Settings/startup | Android FCM is disabled when Firebase config is missing. |
| `native.background-notification` | Closed-app notification | Renders Android data-only FCM locally and forwards tap payloads. | Android push | Foreground app suppresses shell notification. |
| `native.nfc-read` | NFC read | Reads nostr/cashu tags. | App launch/native event | PoC supports Android. |
| `native.nfc-write` | NFC write | Writes profile or token tags. | Profile/token detail | Token write externalizes token. |
| `native.safe-keyboard-insets` | Safe/keyboard insets | Exposes status, navigation, and keyboard insets to CSS. | Whole app, chat | Keeps fixed bars and composer clear of system UI. |
| `native.release-signing` | Release signing guard | Fails release builds when upload signing credentials are missing. | Android release builds | Prevents unsigned Play/APK artifacts. |

## Contracts

- Core business logic should depend on platform ports, not Expo/browser APIs.
- Deep links must normalize to the same parse path as scanner input.
- NFC-written Cashu tokens are excluded from spendable balance until returned.
- Native release builds must not depend on live-reload server configuration.
- Native push availability is configuration-dependent and should fail visibly, not crash.
- iOS currently has Keychain secret storage, native QR scan, and NFC write; Android additionally handles NFC read and FCM rendering.

## Open Questions

- Does NFC write ship in first release?
- Which native capabilities need iOS parity before release?
