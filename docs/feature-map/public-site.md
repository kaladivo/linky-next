# Public Site

Scope: Linky public website, Cashu landing/redeem flow, and public well-known proxying.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `site.landing` | Landing page | Presents Linky and app entry links. | `linky.fit` | Adjacent to app rewrite. |
| `site.feature-showcase` | Feature showcase | Plays four short feature videos with once-only progression. | Landing page | Mobile starts on viewport entry; desktop can start on hover. |
| `site.app-entry-links` | App entry links | Offers web app, Google Play, and APK targets. | Landing CTA | Android mobile defaults to Google Play; APK link uses latest GitHub release asset. |
| `site.preferences` | Site preferences | Persists public-site language and display currency. | Landing, Cashu page | Currency affects public Cashu amount display; `₿` still means sats in PoC copy. |
| `site.privacy` | Privacy page | Hosts policy. | Public site | Required public surface. |
| `site.cashu-page` | Cashu page | Inspects pasted/hash/query Cashu token and offers redeem options. | `linky.fit/cashu` | Query-token loads are rewritten to hash to reduce server exposure. |
| `site.open-linky` | Open in Linky | Prefers native `cashu://`, installed PWA, then browser app fallback. | Cashu page | Deeplink ordering matters. |
| `site.redeem-ln` | Redeem to Lightning address | Melts token to user-entered Lightning address. | Cashu page | Sends max allowed amount, retries lower amounts for fee/range failures, blocks fake-lightning test mints. |
| `site.forward-leftover` | Forward leftover token | Sends leftover value privately to collector. | Cashu redeem | If forwarding fails, the leftover token stays in the URL instead of being discarded. |
| `site.safe-lnurl-proxy` | LNURL fetch proxy | Fetches safe HTTPS LNURL URLs for CORS fallback. | Cashu redeem | Separate from well-known hosted-address proxy. |
| `site.well-known-lnurl` | LNURL proxy | Proxies `/.well-known/lnurlp`. | Public well-known | Compatible with npub.cash/npub.linky.fit path. |
| `site.well-known-nostr` | NIP-05 proxy | Proxies `/.well-known/nostr.json`. | Public well-known | Hosted identity surface. |

## Contracts

- Public Cashu links should not require app install.
- Cashu token launch order is native, installed PWA, browser app.
- Cashu token URLs should prefer hash fragments; query tokens can leak to servers on initial request.
- Public Cashu redemption must not lose change tokens if forwarding/telemetry fails.
- Well-known endpoints remain compatible with hosted npub.cash-style service.

## Open Questions

- Is public site work part of the mobile rewrite scope or separate?
- Should leftover-forwarding remain?
