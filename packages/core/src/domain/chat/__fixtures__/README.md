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
