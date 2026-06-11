/**
 * Conversation reducer tests (issue #22): deterministic semantics for
 * messages, edits (original preserved), reactions (latest per person),
 * deletions (owner-checked, no double-apply) — including idempotence and
 * order-independence over event permutations.
 */
import { describe, expect, it } from "vitest";

import type { ChatDeletion, ChatEvent, ChatMessage, ChatMessageEdit, ChatReaction } from "./chatEvents.js";
import {
  aggregateReactions,
  applyChatEvent,
  applyChatEvents,
  conversationMessages,
  emptyConversationState,
} from "./conversation.js";
import type { ConversationState } from "./conversation.js";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const AT = 1_750_000_000;

let idCounter = 0;
const freshId = (): string => (++idCounter).toString(16).padStart(64, "0");

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  _tag: "ChatMessage",
  rumorId: freshId(),
  senderPubkey: ALICE,
  createdAtSec: AT,
  clientTag: null,
  content: "hello",
  taggedPubkeys: [BOB, ALICE],
  replyToId: null,
  rootMessageId: null,
  ...overrides,
});

const edit = (editedFromId: string, overrides: Partial<ChatMessageEdit> = {}): ChatMessageEdit => ({
  _tag: "ChatMessageEdit",
  rumorId: freshId(),
  senderPubkey: ALICE,
  createdAtSec: AT + 100,
  clientTag: null,
  content: "hello (edited)",
  editedFromId,
  taggedPubkeys: [BOB, ALICE],
  ...overrides,
});

const reaction = (messageRumorId: string, overrides: Partial<ChatReaction> = {}): ChatReaction => ({
  _tag: "ChatReaction",
  rumorId: freshId(),
  senderPubkey: BOB,
  createdAtSec: AT + 50,
  clientTag: null,
  emoji: "👍",
  messageRumorId,
  ...overrides,
});

const deletion = (
  targetRumorIds: ReadonlyArray<string>,
  overrides: Partial<ChatDeletion> = {},
): ChatDeletion => ({
  _tag: "ChatDeletion",
  rumorId: freshId(),
  senderPubkey: BOB,
  createdAtSec: AT + 60,
  clientTag: null,
  targetRumorIds,
  ...overrides,
});

const permutations = <T>(items: ReadonlyArray<T>): Array<Array<T>> => {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
};

/** Asserts every permutation of `events` converges to the same state. */
const expectOrderIndependent = (events: ReadonlyArray<ChatEvent>): ConversationState => {
  const states = permutations(events).map((order) =>
    applyChatEvents(emptyConversationState, order),
  );
  const [first, ...rest] = states;
  for (const state of rest) expect(state).toStrictEqual(first);
  return first!;
};

describe("messages", () => {
  it("stores a message once; duplicates are no-ops", () => {
    const m = message();
    const once = applyChatEvent(emptyConversationState, m);
    const twice = applyChatEvent(once, m);
    expect(twice).toStrictEqual(once);
    expect(conversationMessages(twice)).toHaveLength(1);
    expect(conversationMessages(twice)[0]).toMatchObject({
      rumorId: m.rumorId,
      content: "hello",
      isEdited: false,
      isDeleted: false,
    });
  });

  it("orders messages by time, then rumor id", () => {
    const m1 = message({ createdAtSec: AT + 10 });
    const m2 = message({ createdAtSec: AT });
    const m3 = message({ createdAtSec: AT + 10 });
    const state = expectOrderIndependent([m1, m2, m3]);
    const ordered = conversationMessages(state).map((m) => m.rumorId);
    const tieBroken = [m1.rumorId, m3.rumorId].sort();
    expect(ordered).toStrictEqual([m2.rumorId, ...tieBroken]);
  });
});

describe("edits", () => {
  it("applies an edit and preserves the original content", () => {
    const m = message({ content: "first version" });
    const e = edit(m.rumorId, { content: "second version" });
    const state = expectOrderIndependent([m, e]);
    expect(state.messages.get(m.rumorId)).toMatchObject({
      content: "second version",
      isEdited: true,
      editedAtSec: e.createdAtSec,
      originalContent: "first version",
    });
    // The edit does not create a second visible message.
    expect(conversationMessages(state)).toHaveLength(1);
  });

  it("keeps the first content as original across an edit chain", () => {
    const m = message({ content: "v1" });
    const e1 = edit(m.rumorId, { content: "v2", createdAtSec: AT + 100 });
    const e2 = edit(m.rumorId, { content: "v3", createdAtSec: AT + 200 });
    const state = expectOrderIndependent([m, e1, e2]);
    expect(state.messages.get(m.rumorId)).toMatchObject({
      content: "v3",
      originalContent: "v1",
      editedAtSec: AT + 200,
    });
  });

  it("competing edits resolve by latest timestamp regardless of arrival order", () => {
    const m = message({ content: "v1" });
    const older = edit(m.rumorId, { content: "older edit", createdAtSec: AT + 100 });
    const newer = edit(m.rumorId, { content: "newer edit", createdAtSec: AT + 300 });
    const state = expectOrderIndependent([m, older, newer]);
    expect(state.messages.get(m.rumorId)?.content).toBe("newer edit");
  });

  it("ties on timestamp break deterministically by edit rumor id", () => {
    const m = message();
    const e1 = edit(m.rumorId, { content: "tie A", createdAtSec: AT + 100 });
    const e2 = edit(m.rumorId, { content: "tie B", createdAtSec: AT + 100 });
    const winner = e1.rumorId > e2.rumorId ? "tie A" : "tie B";
    const state = expectOrderIndependent([m, e1, e2]);
    expect(state.messages.get(m.rumorId)?.content).toBe(winner);
  });

  it("an edit arriving first creates the message; the original backfills", () => {
    const m = message({ content: "original text", clientTag: "c-1", createdAtSec: AT });
    const e = edit(m.rumorId, { content: "edited text" });

    const editFirst = applyChatEvents(emptyConversationState, [e, m]);
    const stored = editFirst.messages.get(m.rumorId);
    expect(stored).toMatchObject({
      content: "edited text",
      isEdited: true,
      originalContent: "original text",
      createdAtSec: AT,
      clientTag: "c-1",
    });
    // ... and converges with the natural order.
    expectOrderIndependent([m, e]);
  });

  it("ignores edits from a different author", () => {
    const m = message({ senderPubkey: ALICE, content: "mine" });
    const forged = edit(m.rumorId, { senderPubkey: BOB, content: "hijacked" });
    const state = applyChatEvents(emptyConversationState, [m, forged]);
    expect(state.messages.get(m.rumorId)?.content).toBe("mine");
  });

  it("a forged edit-before-original is discarded when the original arrives", () => {
    const m = message({ senderPubkey: ALICE, content: "mine" });
    const forged = edit(m.rumorId, { senderPubkey: BOB, content: "hijacked" });
    const state = applyChatEvents(emptyConversationState, [forged, m]);
    expect(state.messages.get(m.rumorId)).toMatchObject({
      senderPubkey: ALICE,
      content: "mine",
      isEdited: false,
    });
  });

  it("duplicate edit application is a no-op", () => {
    const m = message();
    const e = edit(m.rumorId);
    const once = applyChatEvents(emptyConversationState, [m, e]);
    expect(applyChatEvent(once, e)).toStrictEqual(once);
  });
});

describe("reactions", () => {
  it("aggregates the latest reaction per person", () => {
    const m = message();
    const bobOld = reaction(m.rumorId, { senderPubkey: BOB, emoji: "👍", createdAtSec: AT + 10 });
    const bobNew = reaction(m.rumorId, { senderPubkey: BOB, emoji: "🔥", createdAtSec: AT + 20 });
    const aliceReaction = reaction(m.rumorId, {
      senderPubkey: ALICE,
      emoji: "🔥",
      createdAtSec: AT + 15,
    });
    const state = expectOrderIndependent([m, bobOld, bobNew, aliceReaction]);
    expect(aggregateReactions(state, m.rumorId, ALICE)).toStrictEqual([
      { emoji: "🔥", count: 2, reactedByMe: true },
    ]);
    expect(aggregateReactions(state, m.rumorId, BOB)).toStrictEqual([
      { emoji: "🔥", count: 2, reactedByMe: true },
    ]);
  });

  it("sorts chips by count, then emoji; reactedByMe only for own latest", () => {
    const m = message();
    const state = applyChatEvents(emptyConversationState, [
      m,
      reaction(m.rumorId, { senderPubkey: BOB, emoji: "👍" }),
      reaction(m.rumorId, { senderPubkey: ALICE, emoji: "🎉" }),
      reaction(m.rumorId, { senderPubkey: "c".repeat(64), emoji: "🎉" }),
    ]);
    expect(aggregateReactions(state, m.rumorId, BOB)).toStrictEqual([
      { emoji: "🎉", count: 2, reactedByMe: false },
      { emoji: "👍", count: 1, reactedByMe: true },
    ]);
  });

  it("keeps reactions that arrive before their message", () => {
    const m = message();
    const r = reaction(m.rumorId);
    const state = expectOrderIndependent([r, m]);
    expect(aggregateReactions(state, m.rumorId, null)).toStrictEqual([
      { emoji: "👍", count: 1, reactedByMe: false },
    ]);
  });

  it("duplicate reactions are no-ops", () => {
    const m = message();
    const r = reaction(m.rumorId);
    const once = applyChatEvents(emptyConversationState, [m, r]);
    expect(applyChatEvent(once, r)).toStrictEqual(once);
  });
});

describe("deletions", () => {
  it("removes a reaction deleted by its author (toggle-off), idempotently", () => {
    const m = message();
    const r = reaction(m.rumorId, { senderPubkey: BOB });
    const d = deletion([r.rumorId], { senderPubkey: BOB });
    const state = expectOrderIndependent([m, r, d]);
    expect(state.reactions.size).toBe(0);
    expect(aggregateReactions(state, m.rumorId, null)).toStrictEqual([]);

    // Applying the same deletion again must not change anything.
    expect(applyChatEvent(state, d)).toStrictEqual(state);
  });

  it("a deletion arriving before the reaction suppresses it", () => {
    const m = message();
    const r = reaction(m.rumorId, { senderPubkey: BOB });
    const d = deletion([r.rumorId], { senderPubkey: BOB });
    const state = applyChatEvents(emptyConversationState, [m, d, r]);
    expect(state.reactions.size).toBe(0);
  });

  it("ignores reaction deletions from someone other than the reactor", () => {
    const m = message();
    const r = reaction(m.rumorId, { senderPubkey: BOB });
    const d = deletion([r.rumorId], { senderPubkey: ALICE });
    const state = applyChatEvents(emptyConversationState, [m, r, d]);
    expect(state.reactions.size).toBe(1);
  });

  it("tombstones a message deleted by its author, never by others", () => {
    const mine = message({ senderPubkey: ALICE });
    const byAuthor = deletion([mine.rumorId], { senderPubkey: ALICE });
    const state = expectOrderIndependent([mine, byAuthor]);
    expect(state.messages.get(mine.rumorId)?.isDeleted).toBe(true);

    const other = message({ senderPubkey: ALICE });
    const forged = deletion([other.rumorId], { senderPubkey: BOB });
    const forgedState = applyChatEvents(emptyConversationState, [other, forged]);
    expect(forgedState.messages.get(other.rumorId)?.isDeleted).toBe(false);
  });

  it("one deletion can target several rumor ids", () => {
    const m = message({ senderPubkey: BOB });
    const r = reaction(m.rumorId, { senderPubkey: BOB });
    const d = deletion([m.rumorId, r.rumorId], { senderPubkey: BOB });
    const state = expectOrderIndependent([m, r, d]);
    expect(state.messages.get(m.rumorId)?.isDeleted).toBe(true);
    expect(state.reactions.size).toBe(0);
  });

  it("message/edit/deletion permutations converge", () => {
    const m = message({ senderPubkey: ALICE, content: "v1" });
    const e = edit(m.rumorId, { senderPubkey: ALICE, content: "v2" });
    const d = deletion([m.rumorId], { senderPubkey: ALICE });
    const state = expectOrderIndependent([m, e, d]);
    expect(state.messages.get(m.rumorId)).toMatchObject({
      isDeleted: true,
      content: "v2",
      originalContent: "v1",
    });
  });
});
