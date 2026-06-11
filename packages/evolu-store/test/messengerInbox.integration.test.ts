/**
 * Unknown threads + blocked senders integration tests (issue #25). Real
 * Evolu 7.4.1 on better-sqlite3, `transports: []`.
 *
 * Covers the inbox safety contracts of the feature map:
 *
 * - `contacts.unknown`: an inbound message from a non-contact creates a
 *   LOCAL-ONLY `_unknownThread` row (proved local-only: zero entries in the
 *   encrypted sync payload `evolu_history`, AppOwner-stamped rows, physical
 *   delete on remove).
 * - `contacts.promote-unknown` / `contacts.delete-to-unknown`: pure metadata
 *   flips — messages stay in place because conversations are keyed by npub.
 * - `contacts.block`: synced on the contacts lane, survives a second store
 *   instance (#15-style restore simulation), and prevents thread recreation
 *   (inbound events from a blocked npub are dropped before any write).
 */
import BetterSqlite from "better-sqlite3";
import { Effect } from "effect";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OwnerId } from "@evolu/common";
import { deriveOwnerLane, MasterSecret } from "@linky/core";

import {
  createBlocksRepository,
  createContactsRepository,
  createLinkyStore,
  createMessagesRepository,
  createUnknownThreadsRepository,
  SYNC_DOMAINS,
} from "../src/index";
import type {
  BlocksRepository,
  ChatMessageEvent,
  ContactsRepository,
  LaneMnemonics,
  LinkyStore,
  MessagesRepository,
  UnknownThreadsRepository,
} from "../src/index";
import { createNodeEvoluDeps } from "./nodeEvoluDeps";

const DB_NAME_A = "linky-inbox-test-a";
const DB_NAME_B = "linky-inbox-test-b";

/** Fixed test master secret (16 bytes), distinct per test file. Dev/test only. */
const MASTER_SECRET_HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

const STRANGER_NPUB = "npub1strangerstrangerstrangerstrangerstrangerstrangerstranger";
const SPAMMER_NPUB = "npub1spamspamspamspamspamspamspamspamspamspamspamspamspamspam";
const FRIEND_NPUB = "npub1friendfriendfriendfriendfriendfriendfriendfriendfriend";

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));

const originalCwd = process.cwd();
let tempDir: string;
let laneMnemonics: LaneMnemonics;
let store: LinkyStore;
let messages: MessagesRepository;
let threads: UnknownThreadsRepository;
let blocks: BlocksRepository;
let contacts: ContactsRepository;

const inbound = (
  fromNpub: string,
  rumorId: string,
  content: string,
  sentAtSec: number,
): ChatMessageEvent => ({
  kind: "message",
  rumorId,
  peerNpub: fromNpub,
  senderNpub: fromNpub,
  direction: "in",
  content,
  sentAtSec,
});

const deriveLaneMnemonics = async (): Promise<LaneMnemonics> => {
  const masterSecret = MasterSecret.make(fromHex(MASTER_SECRET_HEX));
  const entries = await Promise.all(
    SYNC_DOMAINS.map(async (domain) => {
      const lane = await Effect.runPromise(deriveOwnerLane(masterSecret, domain));
      return [domain, lane.mnemonic] as const;
    }),
  );
  return Object.fromEntries(entries) as unknown as LaneMnemonics;
};

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "linky-inbox-test-"));
  process.chdir(tempDir);

  laneMnemonics = await deriveLaneMnemonics();
  const result = createLinkyStore(createNodeEvoluDeps(), {
    name: DB_NAME_A,
    laneMnemonics,
    transports: [],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("createLinkyStore failed");
  store = result.value;
  messages = createMessagesRepository(store);
  threads = createUnknownThreadsRepository(store);
  blocks = createBlocksRepository(store);
  contacts = createContactsRepository(store);
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("unknown threads (contacts.unknown)", () => {
  it("creates a local-only thread for an inbound message from a non-contact", async () => {
    const applied = await messages.applyChatEvent(
      inbound(STRANGER_NPUB, "rumor-s1", "hello, stranger here", 1_718_010_000),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.outcome).toBe("applied");
    expect(applied.value.unknownThreadCreated).toBe(true);

    const thread = await threads.getByNpub(STRANGER_NPUB);
    expect(thread).not.toBeNull();
    expect(thread?.firstSeenAtSec).toBe(1_718_010_000);
    expect(thread?.lastActivityAtSec).toBe(1_718_010_000);
  });

  it("bumps activity instead of duplicating the thread on further messages", async () => {
    const applied = await messages.applyChatEvent(
      inbound(STRANGER_NPUB, "rumor-s2", "me again", 1_718_010_100),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.unknownThreadCreated).toBe(false);

    const list = await threads.list();
    expect(list.filter((item) => item.thread.npub === STRANGER_NPUB)).toHaveLength(1);
    const thread = await threads.getByNpub(STRANGER_NPUB);
    expect(thread?.firstSeenAtSec).toBe(1_718_010_000);
    expect(thread?.lastActivityAtSec).toBe(1_718_010_100);
  });

  it("lists unknown threads with last-message previews", async () => {
    const list = await threads.list();
    const item = list.find((entry) => entry.thread.npub === STRANGER_NPUB);
    expect(item).toBeDefined();
    expect(item?.preview).toEqual({
      kind: "message",
      rumorId: "rumor-s2",
      direction: "in",
      content: "me again",
      sentAtSec: 1_718_010_100,
    });
  });

  it("does not create a thread for messages from a saved contact", async () => {
    const inserted = contacts.insert({ name: "Friend", npub: FRIEND_NPUB });
    expect(inserted.ok).toBe(true);

    const applied = await messages.applyChatEvent(
      inbound(FRIEND_NPUB, "rumor-f1", "hi from a saved contact", 1_718_010_200),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.unknownThreadCreated).toBe(false);
    expect(await threads.getByNpub(FRIEND_NPUB)).toBeNull();
  });

  it("stamps thread rows with the AppOwner and keeps them out of evolu_history (local-only)", async () => {
    const query = store.evolu.createQuery((db) => db.selectFrom("_unknownThread").selectAll());
    const rows = await store.evolu.loadQuery(query);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Local-only mutations are stamped with the AppOwner (= meta lane).
      expect((row as { ownerId: OwnerId }).ownerId).toBe(store.owners.meta.id);
    }

    const db = new BetterSqlite(join(tempDir, `${DB_NAME_A}.db`), { readonly: true });
    try {
      const history = db
        .prepare(`select count(*) as count from evolu_history where "table" = '_unknownThread'`)
        .get() as { count: number };
      // Nothing to sync: the thread can never be recreated by sync.
      expect(history.count).toBe(0);
      // The synced message table DOES have history entries — the thread's
      // messages sync, only the thread entity is local.
      const messageHistory = db
        .prepare(`select count(*) as count from evolu_history where "table" = 'message'`)
        .get() as { count: number };
      expect(messageHistory.count).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("promotes an unknown sender to a contact without touching message rows (contacts.promote-unknown)", async () => {
    const inserted = contacts.insert({ name: "No Longer Stranger", npub: STRANGER_NPUB });
    expect(inserted.ok).toBe(true);
    expect(await threads.remove(STRANGER_NPUB)).toEqual({ removed: true });
    expect(await threads.getByNpub(STRANGER_NPUB)).toBeNull();

    // The conversation followed the npub to the new contact.
    const list = await contacts.listWithPreviews();
    const promoted = list.find((item) => item.contact.npub === STRANGER_NPUB);
    expect(promoted?.preview?.content).toBe("me again");
    const page = await messages.listPage({ peerNpub: STRANGER_NPUB, limit: 10 });
    expect(page.items).toHaveLength(2);
  });

  it("physically deletes the thread row on remove (no tombstone)", async () => {
    await threads.create("npub1temptemptemptemptemptemptemptemptemptemptemptemptemp", 1);
    await threads.remove("npub1temptemptemptemptemptemptemptemptemptemptemptemptemp");
    // Force a worker roundtrip so the delete is committed before reading.
    await store.evolu.loadQuery(
      store.evolu.createQuery((db) => db.selectFrom("_unknownThread").selectAll()),
    );
    const db = new BetterSqlite(join(tempDir, `${DB_NAME_A}.db`), { readonly: true });
    try {
      const row = db
        .prepare(`select count(*) as count from "_unknownThread" where npub like 'npub1temp%'`)
        .get() as { count: number };
      expect(row.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("preserves history when deleting a contact back to unknown (contacts.delete-to-unknown)", async () => {
    const friend = await contacts.findByNpub(FRIEND_NPUB);
    expect(friend).not.toBeNull();
    const removed = contacts.remove(friend!.id);
    expect(removed.ok).toBe(true);
    const created = await threads.create(FRIEND_NPUB, 1_718_010_300);
    expect(created.ok).toBe(true);

    const list = await threads.list();
    const item = list.find((entry) => entry.thread.npub === FRIEND_NPUB);
    expect(item?.preview?.content).toBe("hi from a saved contact");
  });
});

describe("blocked senders (contacts.block)", () => {
  it("blocks a sender: isBlocked answers and inbound events are dropped", async () => {
    // The spammer first creates an unknown thread.
    const first = await messages.applyChatEvent(
      inbound(SPAMMER_NPUB, "rumor-spam1", "buy my coin", 1_718_020_000),
    );
    expect(first.ok && first.value.unknownThreadCreated).toBe(true);

    // Block flow: store the block, remove the local unknown thread.
    const blocked = await blocks.block(SPAMMER_NPUB, 1_718_020_100);
    expect(blocked.ok).toBe(true);
    expect(await threads.remove(SPAMMER_NPUB)).toEqual({ removed: true });
    expect(await blocks.isBlocked(SPAMMER_NPUB)).toBe(true);
    expect(await blocks.isBlocked(STRANGER_NPUB)).toBe(false);

    // Further inbound messages are no-ops and must NOT recreate the thread.
    const after = await messages.applyChatEvent(
      inbound(SPAMMER_NPUB, "rumor-spam2", "why no answer", 1_718_020_200),
    );
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.outcome).toBe("blocked");
    expect(await messages.getByRumorId("rumor-spam2")).toBeNull();
    expect(await threads.getByNpub(SPAMMER_NPUB)).toBeNull();

    // Reactions and deletes from the blocked sender are dropped too.
    const reaction = await messages.applyChatEvent({
      kind: "reaction",
      rumorId: "react-spam",
      targetRumorId: "rumor-spam1",
      peerNpub: SPAMMER_NPUB,
      senderNpub: SPAMMER_NPUB,
      direction: "in",
      emoji: "🙏",
      sentAtSec: 1_718_020_300,
    });
    expect(reaction.ok && reaction.value.outcome === "blocked").toBe(true);
  });

  it("re-blocking is idempotent and list shows active blocks", async () => {
    const again = await blocks.block(SPAMMER_NPUB);
    expect(again.ok).toBe(true);
    const list = await blocks.list();
    expect(list.filter((entry) => entry.npub === SPAMMER_NPUB)).toHaveLength(1);
  });

  it("unblock lets messages through (and create a fresh unknown thread) again", async () => {
    expect(await blocks.unblock(SPAMMER_NPUB)).toEqual({ unblocked: true });
    expect(await blocks.isBlocked(SPAMMER_NPUB)).toBe(false);

    const applied = await messages.applyChatEvent(
      inbound(SPAMMER_NPUB, "rumor-spam3", "i changed", 1_718_020_400),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.outcome).toBe("applied");
    expect(applied.value.unknownThreadCreated).toBe(true);

    // Re-block for the restore test below.
    expect((await blocks.block(SPAMMER_NPUB, 1_718_020_500)).ok).toBe(true);
    expect(await threads.remove(SPAMMER_NPUB)).toEqual({ removed: true });
  });

  it("routes blockedSender rows to the contacts owner lane", async () => {
    const query = store.evolu.createQuery((db) => db.selectFrom("blockedSender").selectAll());
    const rows = await store.evolu.loadQuery(query);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect((row as { ownerId: OwnerId }).ownerId).toBe(store.owners.contacts.id);
    }
  });

  it("survives a second store instance and still prevents thread recreation (restore simulation)", async () => {
    // #15-style sync approximation: copy the SQLite file = what instance B
    // would hold after a full sync of every synced lane.
    await store.evolu.loadQuery(
      store.evolu.createQuery((db) => db.selectFrom("blockedSender").selectAll()),
    );
    for (const suffix of [".db", ".db-wal", ".db-shm"]) {
      const source = join(tempDir, `${DB_NAME_A}${suffix}`);
      if (existsSync(source)) copyFileSync(source, join(tempDir, `${DB_NAME_B}${suffix}`));
    }

    const restored = createLinkyStore(createNodeEvoluDeps(), {
      name: DB_NAME_B,
      laneMnemonics: await deriveLaneMnemonics(),
      transports: [],
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const storeB = restored.value;
    const blocksB = createBlocksRepository(storeB);
    const messagesB = createMessagesRepository(storeB);
    const threadsB = createUnknownThreadsRepository(storeB);

    // The block synced (same contacts lane owner) ...
    expect(await blocksB.isBlocked(SPAMMER_NPUB)).toBe(true);

    // ... and B's ingestion enforces it: no message, no unknown thread.
    await threadsB.remove(SPAMMER_NPUB); // clear the copied local row first
    const applied = await messagesB.applyChatEvent(
      inbound(SPAMMER_NPUB, "rumor-spam-on-b", "hello device B", 1_718_021_000),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.outcome).toBe("blocked");
    expect(await messagesB.getByRumorId("rumor-spam-on-b")).toBeNull();
    expect(await threadsB.getByNpub(SPAMMER_NPUB)).toBeNull();
  });
});
