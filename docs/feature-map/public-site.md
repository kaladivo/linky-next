# Public Site

Scope: The linky.fit public website, the public Cashu redeem page, and hosted address endpoints.

The public site is separate from the app rewrite scope for now; this file inventories its behavior so nothing is forgotten when it gets its own track.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `site.landing` | Landing page | Presents Linky and entry points into the app. | `linky.fit` | Adjacent to the app rewrite. |
| `site.feature-showcase` | Feature showcase | Plays four short feature videos with once-only progression. | Landing page | |
| `site.app-entry-links` | App entry links | Offers the available ways to get and open Linky. | Landing CTA | Points users to the right distribution for their device. |
| `site.preferences` | Site preferences | Persists public-site language and display currency. | Landing, Cashu page | Currency affects public Cashu amount display; `₿` still means sats in PoC copy. |
| `site.privacy` | Privacy page | Hosts the privacy policy. | Public site | Required public surface. |
| `site.cashu-page` | Cashu page | Inspects a pasted or linked Cashu token and offers redeem options. | `linky.fit/cashu` | Token links are normalized so the token does not reach the server. |
| `site.open-linky` | Open in Linky | Opens the token in the user's installed Linky app when possible, otherwise the web app. | Cashu page | Installed app is preferred over the browser. |
| `site.redeem-ln` | Redeem to Lightning address | Pays the token out to a user-entered Lightning address. | Cashu page | Sends the max allowed amount, retries lower amounts on fee/range failures, blocks fake-Lightning test mints. |
| `site.forward-leftover` | Forward leftover token | Sends leftover value privately to a collector. | Cashu redeem | Whether this remains is deferred to the public-site track. If forwarding fails, the leftover token stays in the page URL instead of being discarded. |
| `site.lnurl-fallback` | Lightning address fallback fetch | Resolves Lightning address data on the user's behalf when direct lookup fails. | Cashu redeem | Keeps redemption working for addresses the page cannot reach directly. |
| `site.well-known-lnurl` | Hosted Lightning address endpoint | Serves the public Lightning address lookups for `@linky.fit` users. | Public endpoint | Compatible with the npub.cash-style hosted service. |
| `site.well-known-nostr` | Hosted Nostr identity endpoint | Serves public Nostr identity verification (NIP-05) for hosted names. | Public endpoint | Hosted identity surface. |

## Contracts

- Public Cashu links work without installing the app.
- Opening a token prefers the installed app over the web app.
- Token links must not send the token to any server.
- Public Cashu redemption must not lose change tokens if forwarding fails.
- Hosted address and identity endpoints remain compatible with the npub.cash-style service.

## Open Questions

- Should leftover-forwarding remain? (Decision deferred to the public-site track.)
