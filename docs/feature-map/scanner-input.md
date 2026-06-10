# Scanner & Input Handling

Scope: Camera/paste/gallery/manual input and routing parsed values to the right flow.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `scanner.camera` | Camera scan | Reads QR values. | Contacts, receive, send | Native/web camera implementations differ. |
| `scanner.paste` | Paste | Reads clipboard value. | Scanner, receive | Fallback when camera unavailable. |
| `scanner.gallery` | Gallery QR | Reads QR from image. | Scanner | Useful on mobile. |
| `scanner.manual` | Manual input | Lets user type/paste without camera. | Scanner | Mainly support/fallback. |
| `scanner.parse-deeplink` | Parse native deeplink | Normalizes `nostr://` and `cashu://` URL variants to scan text. | Native launch, NFC, share links | Reuses the same route logic as scanner/paste. |
| `scanner.parse-nostr` | Parse Nostr | Handles `npub`, `nostr://`, and related links. | Contacts/send | Own npub opens profile. |
| `scanner.parse-cashu` | Parse Cashu | Handles tokens and `cashu://` links. | Receive/send/deeplink | Imports token into wallet. |
| `scanner.parse-lightning` | Parse Lightning | Handles Lightning addresses, BOLT11, LNURL-pay, LNURL-withdraw. | Send/receive | Receive entry rejects payment targets. |
| `scanner.route-result` | Route result | Uses entry point to decide contact add, wallet receive, or payment. | Scanner | Prevents paying from receive flow. |

## Contracts

- Entry point affects accepted scan types.
- Unsupported scans should fail visibly.
- Existing contact/own-profile detection prevents duplicate or confusing actions.
- Native deep links, NFC reads, paste, and camera scans should feed the same parser.
- Receive scans must not initiate outgoing payments.
- Camera-denied/unavailable states should keep paste/manual/gallery fallback actions available.

## Open Questions

- Should manual input remain a scanner action or separate screens per domain?
