# App Shell

Scope: Navigation, shared UI state, localization, feedback, and app-level runtime behavior.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `shell.navigate` | Navigation | Moves between contacts, wallet, detail, settings, and advanced screens. | Whole app | Mobile-first routing is the main client shape. |
| `shell.contacts-wallet-tabs` | Main tabs | Keeps contacts and wallet as primary surfaces. | Main screen | PoC uses swipe plus bottom tabs. |
| `shell.toast` | Toasts | Shows transient status feedback. | Whole app | Important for async payment/sync outcomes. |
| `shell.paid-overlay` | Paid overlay | Shows payment success feedback. | Payments | Used after Cashu/Lightning success. |
| `shell.localization` | Localization | Supports Czech and English copy. | Whole app | Formatting follows language where relevant. |
| `shell.defer-network-work` | Deferred startup work | Lets local state render before non-essential online refresh. | Startup | Preserves local-first feel. |
| `shell.route-defaults` | Route fallbacks | Opens wallet for empty/unknown routes and contacts for legacy `#`. | App launch, links | Avoids confusing blank/404 states from old links. |
| `shell.install-pwa` | PWA install prompt | Shows mobile web install help or native browser prompt when not already installed. | Mobile web | Suppressed in native/standalone modes and after dismissal cooldown. |
| `shell.apply-pwa-update` | PWA update | Lets the waiting service worker activate and reload when the user accepts an update. | App shell, reload | Prevents stale app versions from lingering silently. |
| `shell.persist-storage` | Persistent storage request | Requests browser persistent storage where available. | Startup | Reduces local data eviction risk. |

## Contracts

- Primary mobile surfaces are contacts and wallet.
- Local state should render before optional network refresh.
- Async payment errors must surface visibly.
- Route/link compatibility matters: old `#` links and unknown hashes should land somewhere useful.
- PWA install/update behavior must not run inside native shells.

## Open Questions

- What navigation model should replace hash routes in the Expo app?
- Does the rewrite keep swipe navigation or use tabs only?
