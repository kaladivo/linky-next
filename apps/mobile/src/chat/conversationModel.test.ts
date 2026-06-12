/**
 * conversationModel (#29): latest-per-person reaction chips, PoC toggle
 * semantics, reply preview truncation, missing-reply-target detection.
 */
import { describe, expect, it } from "vitest";

import type { MessageRecord, ReactionRecord } from "@linky/evolu-store";

import {
  latestReactionPerPerson,
  missingReplyTargets,
  myReactionsOnMessage,
  planReactionToggle,
  reactionChipsByMessage,
  replyPreviewText,
} from "./conversationModel";

const ME = "npub1me";
const PEER = "npub1peer";

const reaction = (overrides: Partial<ReactionRecord> & { rumorId: string }): ReactionRecord => ({
  id: `id-${overrides.rumorId}`,
  messageRumorId: "msg-1",
  reactorNpub: PEER,
  emoji: "👍",
  sentAtSec: 100,
  status: "sent",
  ...overrides,
});

const message = (overrides: Partial<MessageRecord> & { rumorId: string }): MessageRecord => ({
  id: `id-${overrides.rumorId}`,
  peerNpub: PEER,
  direction: "in",
  content: "hi",
  senderNpub: PEER,
  wrapId: null,
  sentAtSec: 100,
  status: "sent",
  replyToRumorId: null,
  editedAtSec: null,
  editHistory: [],
  ...overrides,
});

describe("latestReactionPerPerson (chat.react)", () => {
  it("keeps only the newest reaction per reactor, ties broken by rumor id", () => {
    const visible = latestReactionPerPerson([
      reaction({ rumorId: "r1", reactorNpub: PEER, emoji: "👍", sentAtSec: 100 }),
      reaction({ rumorId: "r2", reactorNpub: PEER, emoji: "❤️", sentAtSec: 200 }),
      reaction({ rumorId: "r3", reactorNpub: ME, emoji: "😂", sentAtSec: 150 }),
      // Same timestamp as r2 but lower rumor id -> r2 wins for PEER... only
      // if r2 > r0; "r2" > "r0" lexicographically.
      reaction({ rumorId: "r0", reactorNpub: PEER, emoji: "👎", sentAtSec: 200 }),
    ]);
    expect(visible).toHaveLength(2);
    expect(visible.find((r) => r.reactorNpub === PEER)?.emoji).toBe("❤️");
    expect(visible.find((r) => r.reactorNpub === ME)?.emoji).toBe("😂");
  });
});

describe("reactionChipsByMessage", () => {
  it("buckets latest-per-person reactions into chips with own highlighting", () => {
    const chips = reactionChipsByMessage(
      [
        reaction({ rumorId: "r1", reactorNpub: PEER, emoji: "❤️", sentAtSec: 100 }),
        reaction({ rumorId: "r2", reactorNpub: ME, emoji: "❤️", sentAtSec: 110 }),
        reaction({ rumorId: "r3", reactorNpub: "npub1third", emoji: "👍", sentAtSec: 120 }),
        reaction({ rumorId: "r4", messageRumorId: "msg-2", emoji: "😂", sentAtSec: 130 }),
      ],
      ME,
    );
    expect(chips.get("msg-1")).toEqual([
      { emoji: "❤️", count: 2, reactedByMe: true },
      { emoji: "👍", count: 1, reactedByMe: false },
    ]);
    expect(chips.get("msg-2")).toEqual([{ emoji: "😂", count: 1, reactedByMe: false }]);
    expect(chips.get("msg-none")).toBeUndefined();
  });

  it("counts only the LATEST reaction of a person who changed their emoji", () => {
    const chips = reactionChipsByMessage(
      [
        reaction({ rumorId: "r1", reactorNpub: PEER, emoji: "👍", sentAtSec: 100 }),
        reaction({ rumorId: "r2", reactorNpub: PEER, emoji: "❤️", sentAtSec: 200 }),
      ],
      null,
    );
    expect(chips.get("msg-1")).toEqual([{ emoji: "❤️", count: 1, reactedByMe: false }]);
  });
});

describe("planReactionToggle (PoC useSendReaction semantics)", () => {
  const mine = [
    reaction({ rumorId: "m1", reactorNpub: ME, emoji: "👍", sentAtSec: 100 }),
    reaction({ rumorId: "m2", reactorNpub: ME, emoji: "❤️", sentAtSec: 200 }),
  ];

  it("toggles off when any of my reactions carries the same emoji", () => {
    expect(planReactionToggle(mine, "👍")).toEqual({
      deleteRumorIds: ["m1", "m2"],
      sendEmoji: null,
    });
  });

  it("replaces when the emoji is new: delete all mine, then send", () => {
    expect(planReactionToggle(mine, "😂")).toEqual({
      deleteRumorIds: ["m1", "m2"],
      sendEmoji: "😂",
    });
  });

  it("plain add when I had no reaction", () => {
    expect(planReactionToggle([], "🔥")).toEqual({ deleteRumorIds: [], sendEmoji: "🔥" });
  });

  it("myReactionsOnMessage filters by message and reactor", () => {
    const all = [...mine, reaction({ rumorId: "x1", reactorNpub: PEER, emoji: "👍" })];
    expect(myReactionsOnMessage(all, "msg-1", ME).map((r) => r.rumorId)).toEqual(["m1", "m2"]);
    expect(myReactionsOnMessage(all, "msg-2", ME)).toEqual([]);
  });
});

describe("replyPreviewText", () => {
  it("collapses whitespace to one line and truncates long content", () => {
    expect(replyPreviewText("hello\nworld\t !")).toBe("hello world !");
    const long = "x".repeat(200);
    const preview = replyPreviewText(long);
    expect(preview.length).toBe(90);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("missingReplyTargets", () => {
  it("returns reply targets not present in the loaded window, deduped", () => {
    const messages = [
      message({ rumorId: "a" }),
      message({ rumorId: "b", replyToRumorId: "a" }),
      message({ rumorId: "c", replyToRumorId: "off-page" }),
      message({ rumorId: "d", replyToRumorId: "off-page" }),
    ];
    expect(missingReplyTargets(messages)).toEqual(["off-page"]);
  });
});
