# App Shell

Scope: Navigation, shared feedback, localization, and app-level startup behavior.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `shell.navigate` | Navigation | Moves between contacts, wallet, detail, settings, and advanced screens. | Whole app | |
| `shell.contacts-wallet-tabs` | Main tabs | Keeps contacts and wallet as the two primary surfaces. | Main screen | Swipe navigation between the two is kept, as in the PoC (swipe plus bottom tabs). |
| `shell.toast` | Toasts | Shows transient status feedback. | Whole app | Important for async payment/sync outcomes. |
| `shell.paid-overlay` | Paid overlay | Shows payment success feedback. | Payments | Used after Cashu/Lightning success. |
| `shell.localization` | Localization | Supports Czech and English copy. | Whole app | Formatting follows language where relevant. |
| `shell.defer-network-work` | Deferred startup work | Renders local state before non-essential online refresh. | Startup | Preserves the local-first feel. |
| `shell.link-fallbacks` | Link fallbacks | Lands old or unknown app links on a sensible screen. | App launch, links | Avoids blank or dead-end states from outdated links. |

## Contracts

- Primary surfaces are contacts and wallet.
- Local state renders before optional network refresh.
- Async payment errors must surface visibly.
- Old shared links should keep landing somewhere useful.

## Open Questions

- None.
