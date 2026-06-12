/**
 * Chat domain — NIP-17/NIP-59 gift-wrapped private messaging (issue #22;
 * `chat.*` and `nostr.inbox-sync` in the feature map).
 *
 * `nip44.ts` stays internal (throwing reference-style codec); `giftWrap.ts`
 * is the typed boundary around it.
 */
export * from "./giftWrap.js";
export * from "./chatEvents.js";
export * from "./conversation.js";
export * from "./chatInbox.js";
export * from "./paymentNotice.js";
