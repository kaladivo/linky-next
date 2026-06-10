# Chat Payments

Scope: Cashu payments and payment requests sent through chat.

This is where the two pillars meet: money moves as messages. Cashu tokens travel inside the same private Nostr conversations as text, and incoming tokens land directly in the wallet. This area is the core of what makes Linky more than a messenger next to a wallet.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `chat-pay.send-cashu` | Send Cashu | Sends a Cashu token as a private chat message. | Chat, contact pay | Requires the recipient's npub. |
| `chat-pay.receive-cashu` | Receive Cashu | Detects token messages and accepts them into the wallet. | Chat, inbox sync | Incoming tokens are auto-accepted. |
| `chat-pay.notice` | Payment notice | Sends a separate notify-only event so the recipient gets alerted. | Payment send | The actual token message stays separate. |
| `chat-pay.request` | Request payment | Sends a Cashu payment request. | Chat, contact pay | First-release behavior. PoC uses NUT-18 payment requests. |
| `chat-pay.pay-request` | Pay request | Pays an incoming request. | Chat request card | The reply marks the request paid. |
| `chat-pay.decline-request` | Decline request | Sends a decline reply. | Chat request card | The reply marks the request declined. |
| `chat-pay.contact-method` | Contact pay method | Chooses Lightning or Cashu when a contact supports both. | Contact pay | Requests require the recipient's Nostr identity. |
| `chat-pay.queue` | Pending payment queue | Retries queued contact payments after coming back online. | Background | Avoids losing attempted payments. |

## Flows

- `chat-pay.send-cashu`: select mint, create token, store issued token, send chat message, send payment notice.
- `chat-pay.receive-cashu`: parse token message, ignore duplicates, accept token, keep notifications quiet for the token message itself.
- `chat-pay.request`: send request, track the latest paid/declined response tied to it.

## Contracts

- Incoming Cashu chat tokens are auto-accepted.
- Token chat messages and notification-trigger notice events are separate things.
- One outgoing Cashu payment does not split across multiple mints.
- Contact pay never silently switches between Lightning and Cashu when both are available.
- Payment requests show requested/paid/declined state.
- Queued payment expiry follows the relevant protocol standards; when a queued payment expires, the funds are returned rather than lost, with a visible UX indication.

## Open Questions

- None.
