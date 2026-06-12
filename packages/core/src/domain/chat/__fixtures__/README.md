# Chat (NIP-17/NIP-59) golden fixtures

## `nip17.golden.json`

Pins wire compatibility of the gift-wrap engine with the PoC
(app.linky.fit) — and therefore with other NIP-17 Nostr messengers:

- **`nip44`** — the conversation key for the fixture key pair plus
  fixed-nonce encrypt vectors. NIP-44 encryption is deterministic given
  (conversation key, nonce, plaintext), so the golden test asserts exact
  payload equality in BOTH directions: our `encryptNip44` must reproduce the
  PoC payload byte for byte, and our `decryptNip44` must recover the
  plaintext.
- **`wraps`** — complete kind-1059 gift wraps produced by the PoC's own wrap
  code for every rumor shape the chat engine models: text message, reply
  (`e` root/reply tags), edit (`edited_from` tag), reaction (kind 7),
  deletion (kind 5), tricky unicode content, and a nested-encrypted spoof
  case. Wrap creation is intentionally random (ephemeral keys, fresh
  nonces, timestamp jitter), so the wraps are frozen here and the golden
  test pins the UNWRAP direction: `unwrapGiftWrap` must recover exactly the
  recorded rumor (id, pubkey, created_at, kind, tags, content) from both the
  recipient-directed wrap and the sender's self wrap, and `classifyRumor`
  must produce the expected `ChatEvent`. Our own wrap direction is covered
  by the fixed-nonce NIP-44 vectors plus round-trip tests in
  `giftWrap.test.ts`.
- `wrapForRecipient` of the `text-message` / `reply-message` /
  `tricky-content` cases carries the PoC's push-marker wrap tag
  (`["linky", "push"]`), like real PoC message sends
  (`wrapEventWithPushMarker`); all other wraps are plain `wrapEvent` shapes.

Generated from the **PoC's own dependencies** (`nostr-tools@2.23.3`, the
version resolved in `/Users/kaladivo/workspace/linky/linky-poc/bun.lock`) and
the PoC's own wrap implementation
(`apps/web-app/src/app/lib/pushWrappedEvent.ts`) — never from code in this
repo — on 2026-06-11, by running the script preserved verbatim as
[`generateNip17Fixtures.poc.ts.txt`](./generateNip17Fixtures.poc.ts.txt)
from the PoC web app root:

```sh
cd /Users/kaladivo/workspace/linky/linky-poc/apps/web-app
bun gen-nip17-fixtures.ts > .../src/domain/chat/__fixtures__/nip17.golden.json
```

The script self-verifies before emitting: every wrap passes
`nostr-tools.verifyEvent` and `nostr-tools/nip17.unwrapEvent` round-trips to
the recorded rumor; every NIP-44 vector round-trips through the PoC's
`encrypt`/`decrypt`.

The two secret keys are throwaway fixture keys (they appear in this
repository; they must never be used for a real identity).

## `chatPayments.golden.json`

Pins the chat-payment wire shapes (issue #44, `chat-pay.*`) against the
PoC's own send code (`usePayContactWithCashuMessage.ts` via
`pushWrappedEvent.ts`):

- **`tokenMessage`** — a Cashu token chat message: a plain kind-14 rumor
  whose `content` IS the serialized token (encoded with the PoC's own
  `@cashu/cashu-ts@2.9.0`, the version this repo pins), with the usual
  `p`/`p`/`client` tags. BOTH wraps are produced by the PoC's plain
  `wrapEventWithoutPushMarker` — token messages stay notification-QUIET
  (the push relay must not alert on the value-carrying message).
- **`paymentNotice`** — the notify-only companion event
  (`createLinkyPaymentNoticeEvent`): kind 24133, content
  `"payment_notice"`, tags `p` recipient / `p` sender / `client` /
  `["linky","payment_notice"]`. Wrapped ONCE for the recipient by the
  PoC's `wrapEventWithPushMarker` (wrap tags `["p", recipient]` +
  `["linky","push"]`); there is no self wrap.

Generated from the PoC's own dependencies (`nostr-tools@2.23.3`,
`@cashu/cashu-ts@2.9.0`) on 2026-06-12 by the script preserved verbatim as
[`generateChatPaymentsFixtures.poc.ts.txt`](./generateChatPaymentsFixtures.poc.ts.txt)
(same fixture key pair as `nip17.golden.json`; the script self-verifies
every wrap with nostr-tools' `verifyEvent` + `nip17.unwrapEvent` and the
token with the PoC's `parseCashuToken` before emitting):

```sh
cd /Users/kaladivo/workspace/linky/linky-poc/apps/web-app
bun gen-chat-payments-fixtures.ts > .../src/domain/chat/__fixtures__/chatPayments.golden.json
```

## `paymentRequests.golden.json`

Pins the chat payment-request wire shapes (issue #45, `chat-pay.request` /
`chat-pay.pay-request` / `chat-pay.decline-request`) against the PoC's own
wire code (`paymentRequestMessage.ts`, the kind-14 tag layout of
`useSendChatMessage.ts`):

- **`requesterNprofile`** — the NUT-18 nostr transport target: the
  REQUESTER's pubkey + the PoC relay set, encoded with nostr-tools'
  `nip19.nprofileEncode` (relay TLV entries first, pubkey last — the
  `encodeTLV` `.reverse()` order linky-next's codec must reproduce).
- **`request`** — one NUT-18 payment request (100 sat, one mint,
  `i = req-fixture-0001`, single use, NIP-17 nostr transport) in BOTH
  encodings: `encodedPoc` (the PoC's cbor-x map) with `parsedByPoc` (what
  the PoC's own parser reads back), and `encodedCashuTs` (the byte output
  of `@cashu/cashu-ts@2.9.0`'s `PaymentRequest`, linky-next's encoder, fed
  through the PoC's own parser before pinning — proving the PoC accepts
  what linky-next sends). Plus the request chat rumor: a PLAIN kind-14
  whose content IS the `creqA` string (`p`/`p`/`client` tags only).
- **`payReply`** — paying = a normal Cashu token chat message REPLYING to
  the request rumor (`["e", id, "", "root"]` + `["e", id, "", "reply"]`).
  The tie-back is the reply reference; there is no content marker.
- **`declineReply`** — declining = a chat message replying to the request
  whose content is `linky:req-decline:v1:<requestRumorId>` (the rumor id
  embedded redundantly in the content — the PoC's transactions screen
  reads it from there).

Request status is DERIVED, never on the wire: per request rumor, the
latest reply by `created_at` that is a token ("paid") or a decline marker
("declined") wins; otherwise "requested".

Generated from the PoC's own dependencies (`nostr-tools@2.23.3`,
`cbor-x@1.6.0`, `@cashu/cashu-ts@2.9.0`) on 2026-06-12 by the script
preserved verbatim as
[`generatePaymentRequestsFixtures.poc.ts.txt`](./generatePaymentRequestsFixtures.poc.ts.txt)
(same fixture key pair; the script self-verifies every encode/parse round
trip in both directions before emitting):

```sh
cd /Users/kaladivo/workspace/linky/linky-poc/apps/web-app
bun gen-payment-request-fixtures.ts > .../src/domain/chat/__fixtures__/paymentRequests.golden.json
```
