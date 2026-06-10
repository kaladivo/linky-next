# Settings & Advanced

Scope: User preferences, support controls, diagnostics entry points, and destructive actions.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `settings.language` | Language | Changes Czech/English. | Menu/settings | Shared with onboarding and public site. |
| `settings.units` | Display units | Enables allowed units and hidden-amount mode. | Settings | At least one unit stays enabled. |
| `settings.backup` | Backup/export/import | Copies recovery material and exports/imports app data. | Advanced | Ships before legacy backup import. Exports contacts and Cashu tokens; import merges by npub/Lightning address and dedupes tokens. |
| `settings.pay-with-cashu` | Cashu payment toggle | Enables/disables Cashu contact payments. | Advanced | Affects contact/chat pay options. |
| `settings.cashu-autoswap` | Auto-consolidation toggle | Enables automatic foreign-mint consolidation. | Advanced | Interacts with mint selection. |
| `settings.autopay-limit` | Lightning auto-pay limit | Sets the invoice auto-pay threshold. | Advanced | Funds-risk setting. |
| `settings.relays` | Relay settings | Opens relay list and status. | Advanced | User-facing candidate. |
| `settings.sync-servers` | Sync server settings | Opens sync server list and status. | Advanced | User-facing candidate. |
| `settings.mints` | Mint settings | Opens main mint controls. | Advanced | User-facing. |
| `settings.notifications` | Notifications | Enables notification registration. | Advanced | |
| `advanced.nostr-keys` | Nostr key controls | Copy/paste/derive keys. | Advanced | Funds/identity/privacy sensitive. |
| `advanced.dedupe-contacts` | Dedupe contacts | Repairs duplicate contacts. | Advanced | Support action. |
| `advanced.reload` | Restart app | Reloads the app and picks up a pending update. | Advanced | Support action. |
| `advanced.version` | Version | Shows app/build version. | Advanced | Useful for support. |

## Contracts

- Settings that can risk funds, keys, or sync need explicit user intent.
- All advanced controls are available in production builds, but tucked away on the advanced settings screen.
- Debug/support features stay out of normal product flows.
- Data import must not overwrite existing contact fields with blanks or duplicate token entries.
- Logout/reload/clear actions are armed or otherwise explicit when they can disrupt keys, sync, or local state.

## Open Questions

- None.
