# Chat Payments

Scope: Cashu payments and payment requests sent through chat.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `chat-pay.send-cashu` | Send Cashu | Sends a Cashu token as a private chat message. | Chat, contact pay | Requires recipient npub. |
| `chat-pay.receive-cashu` | Receive Cashu | Detects token messages and accepts them into wallet. | Chat, inbox sync | Auto-accepts incoming tokens. |
| `chat-pay.notice` | Payment notice | Sends notify-only wrapped event for push. | Payment send | Actual token message stays separate. |
| `chat-pay.request` | Request payment | Sends Cashu payment request payload. | Chat, contact pay | PoC uses NUT-18 `creqA...`. |
| `chat-pay.pay-request` | Pay request | Pays an incoming request. | Chat request card | Reply marks request paid. |
| `chat-pay.decline-request` | Decline request | Sends decline reply. | Chat request card | Reply marks request declined. |
| `chat-pay.contact-method` | Contact pay method | Chooses Lightning or Cashu when a contact supports both. | Contact pay | Requests require a recipient npub/Cashu path. |
| `chat-pay.queue` | Pending payment queue | Retries queued contact payments after coming online. | Background | Avoids losing attempted payments. |

## Flows

- `chat-pay.send-cashu`: select mint, create token, store issued token, publish chat message, publish payment notice.
- `chat-pay.receive-cashu`: parse token message, ignore duplicates, accept token, suppress noisy notifications.
- `chat-pay.request`: send request, track latest paid/declined response by reply id.

## Contracts

- Incoming Cashu chat tokens are auto-accepted.
- Token chat messages and push-trigger notice events are separate.
- One outgoing Cashu payment does not split across multiple mints.
- Contact pay should not silently switch between Lightning and Cashu when both are available.
- Cashu payment requests need recipient Nostr identity and should show requested/paid/declined state.

## Open Questions

- Are payment requests first-release behavior or later?
- Should failed queued payments expire?
