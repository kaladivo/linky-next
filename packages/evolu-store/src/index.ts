/**
 * @linky/evolu-store — Evolu schema, sync-domain owner lanes, and repository
 * adapters for Linky (issues #9, #13, #15).
 *
 * - `schema` — the six-domain base schema (branded ids, column conventions).
 * - `domains` — table -> sync-domain map and lane-mnemonic -> owner derivation.
 * - `createLinkyStore` — Evolu instance with all six lanes wired and
 *   lane-routed mutations.
 * - `repositories` — plain-TypeScript persistence interfaces for core:
 *   contacts, messages/reactions (incl. the #22 chat-event contract),
 *   unknown threads (local-only), blocked senders.
 * - `owner` — low-level owner helpers (mnemonic/entropy -> AppOwner/ShardOwner).
 */
export * from "./createLinkyEvolu";
export * from "./createLinkyStore";
export * from "./domains";
export * from "./owner";
export * from "./repositories/repository";
export * from "./repositories/contactsRepository";
export * from "./repositories/messagesRepository";
export * from "./repositories/unknownThreadsRepository";
export * from "./repositories/blocksRepository";
export * from "./schema";
