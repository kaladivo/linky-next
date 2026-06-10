# Scanner & Input

Scope: Camera, paste, gallery, manual, link, and NFC input, and routing parsed values to the right flow.

Supporting layer shared by both pillars: the same input surface produces contacts (npub) for the messenger and payment targets (Cashu, Lightning, LNURL) for the wallet.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `scanner.camera` | Camera scan | Reads QR values. | Contacts, receive, send | Fallback actions stay available when the camera is denied or unavailable. |
| `scanner.paste` | Paste | Reads a clipboard value. | Scanner, receive | Fallback when camera is unavailable. |
| `scanner.gallery` | Gallery QR | Reads a QR from a saved image. | Scanner | |
| `scanner.manual` | Manual input | Lets user type a value without the camera. | Scanner | Mainly support/fallback; placement follows common UX practice rather than the PoC's scanner action. |
| `scanner.links` | Incoming links | Normalizes `nostr:` and `cashu:` style links into the same parsing as scans. | App launch, shared links | One parse path for every input source. |
| `scanner.nfc-read` | NFC read | Reads contact/token tags and feeds the parser. | Tag tap | Availability depends on device support. |
| `scanner.parse-nostr` | Parse Nostr | Handles `npub` and related links. | Contacts/send | Scanning own npub opens own profile. |
| `scanner.parse-cashu` | Parse Cashu | Handles tokens and Cashu links. | Receive/send/links | Imports the token into the wallet. |
| `scanner.parse-lightning` | Parse Lightning | Handles Lightning addresses, BOLT11, LNURL-pay, LNURL-withdraw. | Send/receive | Receive entry rejects payment targets. |
| `scanner.route-result` | Route result | Uses the entry point to decide contact add, wallet receive, or payment. | Scanner | Prevents paying from a receive flow. |

## Contracts

- The entry point determines which scan types are accepted.
- Unsupported scans fail visibly.
- Camera, paste, gallery, links, and NFC reads all feed the same parser.
- Existing-contact and own-profile detection prevents duplicate or confusing actions.
- Receive scans never initiate outgoing payments.

## Open Questions

- None.
