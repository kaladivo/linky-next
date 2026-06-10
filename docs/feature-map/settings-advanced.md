# Settings & Advanced

Scope: User preferences, support controls, diagnostics entry points, and destructive actions.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `settings.language` | Language | Changes Czech/English. | Menu/settings | Shared with onboarding/site. |
| `settings.units` | Display units | Enables allowed units and hidden amount mode. | Settings | At least one unit remains enabled. |
| `settings.backup` | Backup/export/import | Copies recovery material and exports/imports app data. | Advanced | Exports contacts/Cashu tokens; import merges by npub/LN and dedupes tokens. |
| `settings.pay-with-cashu` | Cashu payment toggle | Enables/disables Cashu contact payments. | Advanced | Affects contact/chat pay UI. |
| `settings.cashu-autoswap` | Autoswap toggle | Enables automatic foreign-mint consolidation. | Advanced | Interacts with mint selection. |
| `settings.autopay-limit` | Lightning auto-pay limit | Sets invoice auto-pay threshold. | Advanced | Funds-risk setting. |
| `settings.relays` | Relay settings | Opens relay list/status. | Advanced | User-facing candidate. |
| `settings.evolu-servers` | Sync server settings | Opens Evolu server list/status. | Advanced | User-facing candidate. |
| `settings.mints` | Mint settings | Opens main mint controls. | Advanced | User-facing. |
| `settings.notifications` | Notifications | Enables push registration. | Advanced | Push-dependent. |
| `advanced.nostr-keys` | Nostr key controls | Copy/paste/derive keys. | Advanced | Funds/identity/privacy sensitive. |
| `advanced.dedupe-contacts` | Dedupe contacts | Repairs duplicate contacts. | Advanced | Support action. |
| `advanced.reload` | Reload app | Reloads app and checks SW update in PoC. | Advanced | Web-specific in PoC. |
| `advanced.version` | Version | Shows app/build version. | Advanced | Useful for support. |

## Contracts

- Settings that can risk funds, keys, or sync need explicit user intent.
- Debug/support features should not be mixed into normal product flows.
- Data import should not overwrite existing contact fields with blanks or duplicate token rows.
- Logout/reload/clear actions should be armed or otherwise explicit when they can disrupt keys, sync, or local state.

## Open Questions

- Which advanced controls are visible in production mobile?
- Should app data import/export exist before legacy backup import?
