/**
 * ContactsRepository — the reference repository implementation (issue #15).
 * Verifies the repository conventions: plain data in/out (no Evolu types),
 * tagged errors instead of throws, and internal lane routing (every contact
 * row lands on the `contacts` domain lane). Local SQLite, sync disabled.
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
  SYNC_DOMAINS,
} from "../src/index";
import type { ContactsRepository, LaneMnemonics, LinkyStore } from "../src/index";
import { createNodeEvoluDeps } from "./nodeEvoluDeps";

/** Fixed test master secret (16 bytes), distinct from the store test's. Dev/test only. */
const MASTER_SECRET_HEX = "f0e1d2c3b4a5968778695a4b3c2d1e0f";

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));

const originalCwd = process.cwd();
let store: LinkyStore;
let repository: ContactsRepository;

beforeAll(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "linky-contacts-repo-test-")));

  const masterSecret = MasterSecret.make(fromHex(MASTER_SECRET_HEX));
  const entries = await Promise.all(
    SYNC_DOMAINS.map(async (domain) => {
      const lane = await Effect.runPromise(deriveOwnerLane(masterSecret, domain));
      return [domain, lane.mnemonic] as const;
    }),
  );
  const laneMnemonics = Object.fromEntries(entries) as unknown as LaneMnemonics;

  const result = createLinkyStore(createNodeEvoluDeps(), {
    name: "linky-contacts-repo-test",
    laneMnemonics,
    transports: [],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("createLinkyStore failed");
  store = result.value;
  repository = createContactsRepository(store);
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("ContactsRepository", () => {
  it("inserts and lists contacts as plain records", async () => {
    const inserted = repository.insert({
      name: "Alice",
      lnAddress: "alice@wallet.example",
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(typeof inserted.value.id).toBe("string");

    const contacts = await repository.list();
    expect(contacts).toHaveLength(1);
    const alice = contacts[0]!;
    expect(alice.id).toBe(inserted.value.id);
    expect(alice.name).toBe("Alice");
    expect(alice.lnAddress).toBe("alice@wallet.example");
    expect(alice.npub).toBeNull();
    expect(alice.groupName).toBeNull();
    expect(alice.archivedAtSec).toBeNull();
    // Storage-maintained timestamps: createdAt at insert, updatedAt on first update.
    expect(alice.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(alice.updatedAt).toBeNull();
  });

  it("routes contact rows to the contacts owner lane internally", async () => {
    const query = store.evolu.createQuery((db) => db.selectFrom("contact").selectAll());
    const rows = await store.evolu.loadQuery(query);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect((row as { ownerId: OwnerId }).ownerId).toBe(store.owners.contacts.id);
    }
  });

  it("updates fields and clears them with null", async () => {
    const inserted = repository.insert({ name: "Bob", groupName: "friends" });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;

    const updated = repository.update(inserted.value.id, {
      name: "Bobby",
      groupName: null,
      archivedAtSec: 1_718_000_000,
    });
    expect(updated.ok).toBe(true);

    const contacts = await repository.list();
    const bobby = contacts.find((contact) => contact.id === inserted.value.id);
    expect(bobby?.name).toBe("Bobby");
    expect(bobby?.groupName).toBeNull();
    expect(bobby?.archivedAtSec).toBe(1_718_000_000);
    expect(bobby?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("soft-deletes via remove", async () => {
    const inserted = repository.insert({ name: "Carol" });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;

    const removed = repository.remove(inserted.value.id);
    expect(removed.ok).toBe(true);

    const contacts = await repository.list();
    expect(contacts.find((contact) => contact.id === inserted.value.id)).toBeUndefined();
  });

  it("returns a tagged validation error instead of throwing", () => {
    const result = repository.insert({ name: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("ContactValidationError");
    expect(result.error.reason.length).toBeGreaterThan(0);
  });

  it("filters by archived state", async () => {
    const active = await repository.list({ archived: false });
    const archived = await repository.list({ archived: true });
    expect(archived.some((contact) => contact.name === "Bobby")).toBe(true);
    expect(active.some((contact) => contact.name === "Bobby")).toBe(false);
    expect(active.some((contact) => contact.name === "Alice")).toBe(true);
    // Archiving never deletes: the contact is still in the unfiltered list.
    expect((await repository.list()).some((contact) => contact.name === "Bobby")).toBe(true);
  });

  it("returns a tagged error for an invalid contact id", () => {
    const updated = repository.update("definitely-not-an-id", { name: "X" });
    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect(updated.error).toEqual({
      _tag: "InvalidContactIdError",
      id: "definitely-not-an-id",
    });

    const removed = repository.remove("");
    expect(removed.ok).toBe(false);
    if (removed.ok) return;
    expect(removed.error._tag).toBe("InvalidContactIdError");
  });
});

describe("contact list queries (search, groups, previews)", () => {
  const DANA_NPUB = "npub1danadanadanadanadanadanadanadanadanadanadanadanadana";
  const EVE_NPUB = "npub1eveeveeveeveeveeveeveeveeveeveeveeveeveeveeveeveeveeve";

  beforeAll(() => {
    expect(repository.insert({ name: "Dana", npub: DANA_NPUB, groupName: "family" }).ok).toBe(true);
    expect(repository.insert({ name: "Eve", npub: EVE_NPUB, groupName: "work" }).ok).toBe(true);
    expect(repository.insert({ name: "Frank", groupName: "work" }).ok).toBe(true);
  });

  it("searches by name and npub, case-insensitively (contacts.search)", async () => {
    expect((await repository.list({ search: "dAn" })).map((c) => c.name)).toEqual(["Dana"]);
    expect((await repository.list({ search: "npub1eve" })).map((c) => c.name)).toEqual(["Eve"]);
    expect(await repository.list({ search: "no-such-contact" })).toEqual([]);
    // LIKE wildcards in user input match literally, not as wildcards.
    expect(await repository.list({ search: "%a%" })).toEqual([]);
  });

  it("filters by group, by no-group, and combines with search (contacts.filter-group)", async () => {
    const work = await repository.list({ group: "work" });
    expect(work.map((c) => c.name).sort()).toEqual(["Eve", "Frank"]);

    const ungrouped = await repository.list({ group: null });
    expect(ungrouped.some((c) => c.name === "Alice")).toBe(true);
    expect(ungrouped.some((c) => c.name === "Dana")).toBe(false);

    const combined = await repository.list({ group: "work", search: "eve" });
    expect(combined.map((c) => c.name)).toEqual(["Eve"]);
  });

  it("lists the distinct group names in use", async () => {
    expect(await repository.listGroups()).toEqual(["family", "work"]);
  });

  it("finds an active contact by npub (duplicate detection)", async () => {
    expect((await repository.findByNpub(DANA_NPUB))?.name).toBe("Dana");
    expect(await repository.findByNpub("npub1nobodynobodynobodynobody")).toBeNull();
  });

  it("finds a contact by id, including archived ones; invalid ids resolve null (#27)", async () => {
    const inserted = repository.insert({ name: "Grace" });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;

    expect((await repository.findById(inserted.value.id))?.name).toBe("Grace");

    // Archived contacts stay findable (the contact detail screen shows them).
    expect(repository.update(inserted.value.id, { archivedAtSec: 1_718_000_000 }).ok).toBe(true);
    expect((await repository.findById(inserted.value.id))?.archivedAtSec).toBe(1_718_000_000);

    // Soft-deleted contacts do not.
    expect(repository.remove(inserted.value.id).ok).toBe(true);
    expect(await repository.findById(inserted.value.id)).toBeNull();

    expect(await repository.findById("definitely-not-an-id")).toBeNull();
  });

  it("pairs contacts with last-message previews, latest conversation first (contacts.list)", async () => {
    const messages = createMessagesRepository(store);
    const send = (rumorId: string, peerNpub: string, content: string, sentAtSec: number) =>
      messages.applyChatEvent({
        kind: "message",
        rumorId,
        peerNpub,
        senderNpub: peerNpub,
        direction: "in",
        content,
        sentAtSec,
      });
    expect((await send("rumor-dana-1", DANA_NPUB, "older from Dana", 1_718_100_000)).ok).toBe(true);
    expect((await send("rumor-eve-1", EVE_NPUB, "newer from Eve", 1_718_100_100)).ok).toBe(true);

    const items = await repository.listWithPreviews({ archived: false });
    expect(items[0]?.contact.name).toBe("Eve");
    expect(items[0]?.preview).toEqual({
      kind: "message",
      rumorId: "rumor-eve-1",
      direction: "in",
      content: "newer from Eve",
      sentAtSec: 1_718_100_100,
    });
    expect(items[1]?.contact.name).toBe("Dana");
    // Contacts without a conversation follow, without previews.
    const frank = items.find((item) => item.contact.name === "Frank");
    expect(frank?.preview).toBeNull();
    expect(items.indexOf(frank!)).toBeGreaterThan(1);
  });
});
