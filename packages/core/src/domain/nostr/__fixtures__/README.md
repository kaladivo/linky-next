# Nostr golden fixtures

## `signedEvents.golden.json`

Pins NIP-01 event id computation and Schnorr signing compatibility with the
PoC's Nostr stack: the same event template signed with the same secret key
must produce the same event `id` as `nostr-tools`, and signatures produced by
either side must verify on the other.

Generated from the **PoC's own dependency** (`nostr-tools@2.23.5`, resolved in
`/Users/kaladivo/workspace/linky/linky-poc`) — never from code in this repo —
on 2026-06-11, with this bun script run from the PoC root:

```ts
const nt = await import("nostr-tools");
const { finalizeEvent, verifyEvent, getPublicKey, getEventHash } = nt;
const hexToBytes = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));

const secretKeyHex = "5c0c523f52a5b6fad39ed2403092df8cebc36318b39383bca6c00808626fab3a";
const sk = hexToBytes(secretKeyHex);

// for each template in events:
const ev = finalizeEvent(structuredClone(template), sk);
if (!verifyEvent(ev)) throw new Error("fixture event failed self-verification");
if (getEventHash(ev) !== ev.id) throw new Error("id mismatch");
```

The secret key is a throwaway fixture key (it appears in this repository; it
must never be used for a real identity).

Notes:

- Event `id`s are deterministic (SHA-256 of the NIP-01 serialization), so the
  golden test asserts exact id equality against our implementation.
- BIP-340 signatures use random auxiliary data in `nostr-tools`, so the
  fixture `sig` values are one valid signature among many; the golden test
  asserts that _our verifier accepts them_ (and that our own signatures
  verify), not byte equality.
- The "tricky content" event pins JSON escaping behavior (newline, tab,
  quotes, backslashes, non-ASCII, astral-plane emoji).

## `relayLists.golden.json`

Pins the relay-list event structure (issue #23) against what the PoC
publishes: `useRelayDomain.publishNostrRelayLists` in
`apps/web-app/src/app/hooks/useRelayDomain.ts` builds

- kind **10002** (NIP-65 relay metadata) with one `["r", url]` tag per relay
  — no read/write markers (unmarked `r` = read+write per NIP-65), and
- kind **10050** (NIP-17 inbox relays) with one `["relay", url]` tag per
  relay,

both with `content: ""` and `created_at = Math.floor(Date.now() / 1000)`,
signed with `finalizeEvent`.

Generated from the **PoC's own dependency** (`nostr-tools@2.23.5`, resolved
in `/Users/kaladivo/workspace/linky/linky-poc`) on 2026-06-11, with a bun
script run from the PoC root that builds exactly those two templates (same
throwaway fixture key as `signedEvents.golden.json`, fixed
`created_at = 1718001000`, relay set = the PoC's `NOSTR_RELAYS` defaults)
and `finalizeEvent`s them — the script is embedded in the `generator` field
and mirrors the snippet in the section above.

The golden test asserts our `publishRelayLists` produces byte-identical
templates and ids under a fixed TestClock; signatures verify on both sides
(not byte-equal — random aux, see above).
