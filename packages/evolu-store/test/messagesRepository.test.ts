/**
 * MessagesRepository integration tests (issue #25). Real Evolu 7.4.1 on
 * better-sqlite3, `transports: []` (local-first, sync disabled).
 *
 * Covers the #22 chat-event contract: dedup by rumor id, pending-ack,
 * edit history preservation (original kept locally), edit/delete idempotency,
 * reaction latest-per-person, newest-first cursor paging, and lane routing
 * of `message`/`reaction` rows onto the messages owner lane.
 */
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OwnerId } from "@evolu/common";
import { deriveOwnerLane, MasterSecret } from "@linky/core";

import {
  createContactsRepository,
  createLinkyStore,
  createMessagesRepository,
  loadActiveReactions,
  loadKnownRumorIds,
  SYNC_DOMAINS,
} from "../src/index";
import type { ChatMessageEvent, LaneMnemonics, LinkyStore, MessagesRepository } from "../src/index";
import { createNodeEvoluDeps } from "./nodeEvoluDeps";

/** Fixed test master secret (16 bytes), distinct per test file. Dev/test only. */
const MASTER_SECRET_HEX = "11223344556677889900aabbccddeeff";

const ALICE_NPUB = "npub1alicealicealicealicealicealicealicealicealicealicealice";
const MY_NPUB = "npub1memememememememememememememememememememememememememe";

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));

const originalCwd = process.cwd();
let store: LinkyStore;
let repository: MessagesRepository;

const inboundMessage = (overrides: Partial<ChatMessageEvent> & { rumorId: string }): ChatMessageEvent => ({
  kind: "message",
  peerNpub: ALICE_NPUB,
  senderNpub: ALICE_NPUB,
  direction: "in",
  content: "hello",
  sentAtSec: 1_718_000_000,
  ...overrides,
});

beforeAll(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "linky-messages-repo-test-")));

  const masterSecret = MasterSecret.make(fromHex(MASTER_SECRET_HEX));
  const entries = await Promise.all(
    SYNC_DOMAINS.map(async (domain) => {
      const lane = await Effect.runPromise(deriveOwnerLane(masterSecret, domain));
      return [domain, lane.mnemonic] as const;
    }),
  );
  const laneMnemonics = Object.fromEntries(entries) as unknown as LaneMnemonics;

  const result = createLinkyStore(createNodeEvoluDeps(), {
    name: "linky-messages-repo-test",
    laneMnemonics,
    transports: [],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("createLinkyStore failed");
  store = result.value;
  repository = createMessagesRepository(store);

  // Alice is a saved contact, so message tests don't create unknown threads
  // (unknown-thread behavior has its own test file).
  const contacts = createContactsRepository(store);
  const inserted = contacts.insert({ name: "Alice", npub: ALICE_NPUB });
  expect(inserted.ok).toBe(true);
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("message events", () => {
  it("stores an inbound message and reads it back as a plain record", async () => {
    const applied = await repository.applyChatEvent(
      inboundMessage({
        rumorId: "rumor-m1",
        content: "hi there",
        wrapId: "wrap-m1",
        sentAtSec: 1_718_000_010,
      }),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.outcome).toBe("applied");
    expect(applied.value.unknownThreadCreated).toBe(false);

    const record = await repository.getByRumorId("rumor-m1");
    expect(record).not.toBeNull();
    expect(record?.peerNpub).toBe(ALICE_NPUB);
    expect(record?.direction).toBe("in");
    expect(record?.content).toBe("hi there");
    expect(record?.senderNpub).toBe(ALICE_NPUB);
    expect(record?.wrapId).toBe("wrap-m1");
    expect(record?.sentAtSec).toBe(1_718_000_010);
    expect(record?.status).toBe("sent");
    expect(record?.editHistory).toEqual([]);
  });

  it("dedups by rumor id: re-applying the same message is a no-op duplicate", async () => {
    const again = await repository.applyChatEvent(
      inboundMessage({ rumorId: "rumor-m1", content: "DIFFERENT CONTENT" }),
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.outcome).toBe("duplicate");

    const record = await repository.getByRumorId("rumor-m1");
    expect(record?.content).toBe("hi there"); // first write wins, no double-apply
  });

  it("stores reply references", async () => {
    const applied = await repository.applyChatEvent(
      inboundMessage({
        rumorId: "rumor-m2",
        content: "replying to you",
        replyToRumorId: "rumor-m1",
        sentAtSec: 1_718_000_020,
      }),
    );
    expect(applied.ok).toBe(true);
    const record = await repository.getByRumorId("rumor-m2");
    expect(record?.replyToRumorId).toBe("rumor-m1");
  });

  it("acknowledges a pending optimistic send when the delivered copy arrives (chat.pending-ack)", async () => {
    const optimistic = await repository.applyChatEvent(
      inboundMessage({
        rumorId: "rumor-out1",
        senderNpub: MY_NPUB,
        direction: "out",
        content: "my optimistic message",
        status: "pending",
        sentAtSec: 1_718_000_030,
      }),
    );
    expect(optimistic.ok && optimistic.value.outcome === "applied").toBe(true);
    expect((await repository.getByRumorId("rumor-out1"))?.status).toBe("pending");

    // The delivered copy observed via sync: same rumor id, now with a wrap.
    const delivered = await repository.applyChatEvent(
      inboundMessage({
        rumorId: "rumor-out1",
        senderNpub: MY_NPUB,
        direction: "out",
        content: "my optimistic message",
        wrapId: "wrap-out1",
        sentAtSec: 1_718_000_030,
      }),
    );
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;
    expect(delivered.value.outcome).toBe("duplicate");
    expect(delivered.value.acknowledgedPending).toBe(true);

    const record = await repository.getByRumorId("rumor-out1");
    expect(record?.status).toBe("sent");
    expect(record?.wrapId).toBe("wrap-out1");
  });

  it("markSent acknowledges a pending message directly (relay ack path)", async () => {
    await repository.applyChatEvent(
      inboundMessage({
        rumorId: "rumor-out2",
        senderNpub: MY_NPUB,
        direction: "out",
        content: "second send",
        status: "pending",
        sentAtSec: 1_718_000_040,
      }),
    );
    const acked = await repository.markSent("rumor-out2", "wrap-out2");
    expect(acked.ok && acked.value.acknowledged).toBe(true);
    expect((await repository.getByRumorId("rumor-out2"))?.status).toBe("sent");

    const unknown = await repository.markSent("rumor-never-existed");
    expect(unknown.ok && unknown.value.acknowledged).toBe(false);
  });

  it("returns a tagged validation error for an invalid event", async () => {
    const result = await repository.applyChatEvent(
      inboundMessage({ rumorId: "", content: "x" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("ChatEventValidationError");
  });
});

describe("edit events (chat.edit-message)", () => {
  it("applies an edit, preserving the original content in local history", async () => {
    await repository.applyChatEvent(
      inboundMessage({ rumorId: "rumor-e1", content: "orginal tpyo", sentAtSec: 1_718_001_000 }),
    );
    const edit = await repository.applyChatEvent({
      kind: "edit",
      rumorId: "edit-1",
      targetRumorId: "rumor-e1",
      peerNpub: ALICE_NPUB,
      senderNpub: ALICE_NPUB,
      direction: "in",
      content: "original typo fixed",
      sentAtSec: 1_718_001_100,
    });
    expect(edit.ok && edit.value.outcome === "applied").toBe(true);

    const record = await repository.getByRumorId("rumor-e1");
    expect(record?.content).toBe("original typo fixed");
    expect(record?.editedAtSec).toBe(1_718_001_100);
    expect(record?.editHistory).toEqual([
      { editId: "edit-1", previousContent: "orginal tpyo", editedAtSec: 1_718_001_100 },
    ]);
  });

  it("keeps the full edit chain and never double-applies a re-arriving edit", async () => {
    const secondEdit = {
      kind: "edit" as const,
      rumorId: "edit-2",
      targetRumorId: "rumor-e1",
      peerNpub: ALICE_NPUB,
      senderNpub: ALICE_NPUB,
      direction: "in" as const,
      content: "final wording",
      sentAtSec: 1_718_001_200,
    };
    const applied = await repository.applyChatEvent(secondEdit);
    expect(applied.ok && applied.value.outcome === "applied").toBe(true);

    // Same edit event again (another sync path) — must be a no-op.
    const duplicate = await repository.applyChatEvent(secondEdit);
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) return;
    expect(duplicate.value.outcome).toBe("duplicate");

    const record = await repository.getByRumorId("rumor-e1");
    expect(record?.content).toBe("final wording");
    expect(record?.editHistory).toHaveLength(2);
    // The original is still the first entry's previousContent.
    expect(record?.editHistory[0]?.previousContent).toBe("orginal tpyo");
    expect(record?.editHistory[1]?.previousContent).toBe("original typo fixed");
  });

  it("records an out-of-order (older) edit in history without regressing content", async () => {
    const lateOldEdit = await repository.applyChatEvent({
      kind: "edit",
      rumorId: "edit-0-late",
      targetRumorId: "rumor-e1",
      peerNpub: ALICE_NPUB,
      senderNpub: ALICE_NPUB,
      direction: "in",
      content: "stale middle version",
      sentAtSec: 1_718_001_050, // older than both applied edits
    });
    expect(lateOldEdit.ok && lateOldEdit.value.outcome === "applied").toBe(true);

    const record = await repository.getByRumorId("rumor-e1");
    expect(record?.content).toBe("final wording");
    expect(record?.editedAtSec).toBe(1_718_001_200);
    expect(record?.editHistory).toHaveLength(3);
  });

  it("reports target-missing for an edit of an unknown message", async () => {
    const result = await repository.applyChatEvent({
      kind: "edit",
      rumorId: "edit-orphan",
      targetRumorId: "rumor-never-existed",
      peerNpub: ALICE_NPUB,
      senderNpub: ALICE_NPUB,
      direction: "in",
      content: "whatever",
      sentAtSec: 1_718_001_300,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("target-missing");
  });
});

describe("reaction events (chat.react)", () => {
  const react = (rumorId: string, reactorNpub: string, emoji: string, sentAtSec: number) =>
    repository.applyChatEvent({
      kind: "reaction",
      rumorId,
      targetRumorId: "rumor-m1",
      peerNpub: ALICE_NPUB,
      senderNpub: reactorNpub,
      direction: reactorNpub === MY_NPUB ? "out" : "in",
      emoji,
      sentAtSec,
    });

  it("keeps all reaction events but exposes the latest per person", async () => {
    expect((await react("react-1", ALICE_NPUB, "👍", 1_718_002_000)).ok).toBe(true);
    expect((await react("react-2", MY_NPUB, "🔥", 1_718_002_010)).ok).toBe(true);
    // Alice changes her reaction.
    expect((await react("react-3", ALICE_NPUB, "❤️", 1_718_002_020)).ok).toBe(true);

    const visible = await repository.latestReactions("rumor-m1");
    expect(visible).toHaveLength(2);
    expect(visible.find((r) => r.reactorNpub === ALICE_NPUB)?.emoji).toBe("❤️");
    expect(visible.find((r) => r.reactorNpub === MY_NPUB)?.emoji).toBe("🔥");
  });

  it("dedups reactions by rumor id", async () => {
    const duplicate = await react("react-3", ALICE_NPUB, "❤️", 1_718_002_020);
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) return;
    expect(duplicate.value.outcome).toBe("duplicate");
    expect(await repository.latestReactions("rumor-m1")).toHaveLength(2);
  });

  it("applies a delete of a reaction event and never double-applies it (chat.delete)", async () => {
    // Alice deletes her latest reaction -> her previous one becomes visible.
    const deleted = await repository.applyChatEvent({
      kind: "delete",
      rumorId: "delete-react-3",
      targetRumorIds: ["react-3"],
      peerNpub: ALICE_NPUB,
      senderNpub: ALICE_NPUB,
      direction: "in",
      sentAtSec: 1_718_002_100,
    });
    expect(deleted.ok && deleted.value.outcome === "applied").toBe(true);

    const visible = await repository.latestReactions("rumor-m1");
    expect(visible.find((r) => r.reactorNpub === ALICE_NPUB)?.emoji).toBe("👍");

    // The same delete event arriving again must not double-apply.
    const again = await repository.applyChatEvent({
      kind: "delete",
      rumorId: "delete-react-3",
      targetRumorIds: ["react-3"],
      peerNpub: ALICE_NPUB,
      senderNpub: ALICE_NPUB,
      direction: "in",
      sentAtSec: 1_718_002_100,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.outcome).toBe("duplicate");
    expect((await repository.latestReactions("rumor-m1")).find((r) => r.reactorNpub === ALICE_NPUB)?.emoji).toBe("👍");
  });
});

describe("delete events on messages (chat.delete)", () => {
  it("soft-deletes the message, keeps dedup, and reports duplicates", async () => {
    await repository.applyChatEvent(
      inboundMessage({ rumorId: "rumor-d1", content: "to be deleted", sentAtSec: 1_718_003_000 }),
    );
    const deleted = await repository.applyChatEvent({
      kind: "delete",
      rumorId: "delete-d1",
      targetRumorIds: ["rumor-d1"],
      peerNpub: ALICE_NPUB,
      senderNpub: ALICE_NPUB,
      direction: "in",
      sentAtSec: 1_718_003_100,
    });
    expect(deleted.ok && deleted.value.outcome === "applied").toBe(true);
    expect(await repository.getByRumorId("rumor-d1")).toBeNull();

    // Duplicate delete -> no double-apply.
    const again = await repository.applyChatEvent({
      kind: "delete",
      rumorId: "delete-d1",
      targetRumorIds: ["rumor-d1"],
      peerNpub: ALICE_NPUB,
      senderNpub: ALICE_NPUB,
      direction: "in",
      sentAtSec: 1_718_003_100,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.outcome).toBe("duplicate");

    // The deleted message must not resurrect when its copy re-arrives via
    // a different sync path (dedup sees tombstones).
    const resurrect = await repository.applyChatEvent(
      inboundMessage({ rumorId: "rumor-d1", content: "to be deleted", sentAtSec: 1_718_003_000 }),
    );
    expect(resurrect.ok).toBe(true);
    if (!resurrect.ok) return;
    expect(resurrect.value.outcome).toBe("duplicate");
    expect(await repository.getByRumorId("rumor-d1")).toBeNull();
  });

  it("reports target-missing when nothing matches", async () => {
    const result = await repository.applyChatEvent({
      kind: "delete",
      rumorId: "delete-orphan",
      targetRumorIds: ["rumor-never-existed"],
      peerNpub: ALICE_NPUB,
      senderNpub: ALICE_NPUB,
      direction: "in",
      sentAtSec: 1_718_003_200,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("target-missing");
  });
});

describe("conversation pages (newest-first, cursor)", () => {
  const PAGE_PEER = "npub1pagespagespagespagespagespagespagespagespagespagespage";

  it("pages a conversation newest-first with a stable cursor", async () => {
    for (let i = 1; i <= 7; i++) {
      const applied = await repository.applyChatEvent(
        inboundMessage({
          rumorId: `rumor-p${i}`,
          peerNpub: PAGE_PEER,
          senderNpub: PAGE_PEER,
          content: `message ${i}`,
          sentAtSec: 1_718_004_000 + i,
        }),
      );
      expect(applied.ok).toBe(true);
    }

    const page1 = await repository.listPage({ peerNpub: PAGE_PEER, limit: 3 });
    expect(page1.items.map((m) => m.content)).toEqual(["message 7", "message 6", "message 5"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await repository.listPage({
      peerNpub: PAGE_PEER,
      limit: 3,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((m) => m.content)).toEqual(["message 4", "message 3", "message 2"]);

    const page3 = await repository.listPage({
      peerNpub: PAGE_PEER,
      limit: 3,
      cursor: page2.nextCursor!,
    });
    expect(page3.items.map((m) => m.content)).toEqual(["message 1"]);
    expect(page3.nextCursor).toBeNull();

    // Pages are scoped per conversation.
    const alicePage = await repository.listPage({ peerNpub: ALICE_NPUB, limit: 100 });
    expect(alicePage.items.every((m) => m.peerNpub === ALICE_NPUB)).toBe(true);
  });
});

describe("conversation reaction/known-id loaders (#29)", () => {
  it("loadActiveReactions returns all active reactions for the given messages in one query", async () => {
    const reactions = await loadActiveReactions(store, ["rumor-m1"]);
    // From the reaction tests above: react-1 (Alice 👍), react-2 (me 🔥);
    // react-3 was deleted and must not appear.
    expect(reactions.map((r) => r.rumorId).sort()).toEqual(["react-1", "react-2"]);
    expect(await loadActiveReactions(store, [])).toEqual([]);
    expect(await loadActiveReactions(store, ["rumor-no-reactions"])).toEqual([]);
  });

  it("loadKnownRumorIds covers messages (incl. deleted), reactions, and edit ids", async () => {
    const known = new Set(await loadKnownRumorIds(store));
    expect(known.has("rumor-m1")).toBe(true); // plain message
    expect(known.has("rumor-d1")).toBe(true); // soft-deleted message stays known
    expect(known.has("react-1")).toBe(true); // reaction
    expect(known.has("react-3")).toBe(true); // deleted reaction stays known
    expect(known.has("edit-1")).toBe(true); // edit event id from history
    expect(known.has("edit-2")).toBe(true);
  });
});

describe("delete chat (#29 deleteConversation)", () => {
  const DEL_PEER = "npub1deletemedeletemedeletemedeletemedeletemedeletemedeleteme";

  it("soft-deletes every message and attached reaction of one conversation, idempotently", async () => {
    for (let i = 1; i <= 3; i++) {
      const applied = await repository.applyChatEvent(
        inboundMessage({
          rumorId: `rumor-dc${i}`,
          peerNpub: DEL_PEER,
          senderNpub: DEL_PEER,
          content: `bye ${i}`,
          sentAtSec: 1_718_005_000 + i,
        }),
      );
      expect(applied.ok).toBe(true);
    }
    const reacted = await repository.applyChatEvent({
      kind: "reaction",
      rumorId: "react-dc1",
      targetRumorId: "rumor-dc1",
      peerNpub: DEL_PEER,
      senderNpub: DEL_PEER,
      direction: "in",
      emoji: "👍",
      sentAtSec: 1_718_005_010,
    });
    expect(reacted.ok).toBe(true);

    const deleted = await repository.deleteConversation(DEL_PEER);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.value).toEqual({ deletedMessages: 3, deletedReactions: 1 });

    const page = await repository.listPage({ peerNpub: DEL_PEER, limit: 10 });
    expect(page.items).toEqual([]);
    expect(await repository.latestReactions("rumor-dc1")).toEqual([]);

    // Idempotent: a second delete touches nothing.
    const again = await repository.deleteConversation(DEL_PEER);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value).toEqual({ deletedMessages: 0, deletedReactions: 0 });

    // Other conversations are untouched.
    expect((await repository.listPage({ peerNpub: ALICE_NPUB, limit: 100 })).items.length)
      .toBeGreaterThan(0);
  });

  it("keeps deleted conversations deleted when the same rumors re-arrive via sync", async () => {
    const resurrect = await repository.applyChatEvent(
      inboundMessage({
        rumorId: "rumor-dc1",
        peerNpub: DEL_PEER,
        senderNpub: DEL_PEER,
        content: "bye 1",
        sentAtSec: 1_718_005_001,
      }),
    );
    expect(resurrect.ok).toBe(true);
    if (!resurrect.ok) return;
    expect(resurrect.value.outcome).toBe("duplicate");
    expect((await repository.listPage({ peerNpub: DEL_PEER, limit: 10 })).items).toEqual([]);

    // A genuinely NEW message restarts the conversation (common messenger UX).
    const fresh = await repository.applyChatEvent(
      inboundMessage({
        rumorId: "rumor-dc-new",
        peerNpub: DEL_PEER,
        senderNpub: DEL_PEER,
        content: "hello again",
        sentAtSec: 1_718_005_100,
      }),
    );
    expect(fresh.ok && fresh.value.outcome === "applied").toBe(true);
    const page = await repository.listPage({ peerNpub: DEL_PEER, limit: 10 });
    expect(page.items.map((m) => m.rumorId)).toEqual(["rumor-dc-new"]);
  });
});

describe("lane routing", () => {
  it("lands message and reaction rows on the messages owner lane", async () => {
    for (const table of ["message", "reaction"] as const) {
      const query = store.evolu.createQuery((db) => db.selectFrom(table).selectAll());
      const rows = await store.evolu.loadQuery(query);
      expect(rows.length, `rows in ${table}`).toBeGreaterThan(0);
      for (const row of rows) {
        expect((row as { ownerId: OwnerId }).ownerId).toBe(store.owners.messages.id);
      }
    }
  });
});
