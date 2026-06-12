/**
 * Storage rotation (#54, `sync.storage-rotation`) — integration tests on
 * real Evolu 7.4.1 / local SQLite (`transports: []`, like every suite here).
 *
 * What is proven:
 *
 * 1. Rotation moves WRITES to a fresh deterministically derived lane while
 *    every older generation stays in the read set: nothing previously
 *    written ever disappears from repository reads.
 * 2. Sticky updates: mutating a pre-rotation row after rotation lands on
 *    the row's ORIGINAL lane — exactly one row exists afterwards (Evolu
 *    keys rows by `(ownerId, id)`; a cross-lane update would fork a
 *    partial duplicate; fund-safety relevant for `cashuToken.state`).
 * 3. Convergence: a second device (fresh store over a byte-copy of the
 *    database — the established two-device approximation, see
 *    store.integration.test.ts) adopts the same plan, derives the same
 *    write lane, and a concurrent same-target rotation produces the SAME
 *    meta entry (deterministic row id) and lane owner — one rotation, not
 *    two.
 * 4. Idempotence: re-adopting and re-rotating behave sanely; the trigger
 *    rotates once at the threshold and then respects the cooldown.
 * 5. The local-only NUT-13 counter rows (`_cashuCounter`) are untouched by
 *    rotation (fund safety: counters must never sync or move).
 */
import { createIdFromString } from "@evolu/common";
import { Effect } from "effect";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveOwnerLane, MasterSecret, OwnerLaneIndex } from "@linky/core";
import type { RotatingSyncDomain } from "@linky/core";

import {
  createContactsRepository,
  createLinkyStore,
  createMessagesRepository,
  createStorageRotation,
  createTokensRepository,
  createTransactionsRepository,
  SYNC_DOMAINS,
} from "../src/index";
import type { LaneMnemonics, LinkyStore, StorageRotation } from "../src/index";
import { createNodeEvoluDeps } from "./nodeEvoluDeps";

/** Fixed test master secret (16 bytes), unique per test file. Dev/test only. */
const MASTER_SECRET_HEX = "54545454545454545454545454545454";
const MASTER_SECRET = () => MasterSecret.make(fromHex(MASTER_SECRET_HEX));

const DB_NAME_A = "linky-rotation-test-a";
const DB_NAME_B = "linky-rotation-test-b";

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));

const deriveLaneMnemonics = async (): Promise<LaneMnemonics> => {
  const entries = await Promise.all(
    SYNC_DOMAINS.map(async (domain) => {
      const lane = await Effect.runPromise(deriveOwnerLane(MASTER_SECRET(), domain));
      return [domain, lane.mnemonic] as const;
    }),
  );
  return Object.fromEntries(entries) as unknown as LaneMnemonics;
};

/** Exactly what the app injects: core's deriveOwnerLane over the master secret. */
const deriveLaneMnemonic = async (domain: RotatingSyncDomain, index: number): Promise<string> => {
  const lane = await Effect.runPromise(
    deriveOwnerLane(MASTER_SECRET(), domain, OwnerLaneIndex.make(index)),
  );
  return lane.mnemonic;
};

/** Independent reference derivation of a lane's owner id. */
const laneOwnerIdOf = async (domain: RotatingSyncDomain, index: number): Promise<string> => {
  const { appOwnerFromMnemonic } = await import("../src/owner");
  const owner = appOwnerFromMnemonic(await deriveLaneMnemonic(domain, index));
  if (owner === null) throw new Error("invalid derived mnemonic");
  return String(owner.id);
};

const createRotation = (store: LinkyStore, nowSec?: () => number): StorageRotation =>
  createStorageRotation(store, {
    deriveLaneMnemonic,
    ...(nowSec === undefined ? {} : { nowSec }),
  });

const loadAllRows = async (store: LinkyStore, table: "contact" | "message" | "cashuToken") => {
  const query = store.evolu.createQuery((db) =>
    db.selectFrom(table).selectAll().where("isDeleted", "is not", 1),
  );
  return store.evolu.loadQuery(query);
};

const originalCwd = process.cwd();
let tempDir: string;
let laneMnemonics: LaneMnemonics;
let storeA: LinkyStore;
let rotationA: StorageRotation;
let contactId: string;
let tokenId: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "linky-rotation-test-"));
  process.chdir(tempDir);

  laneMnemonics = await deriveLaneMnemonics();
  const created = createLinkyStore(createNodeEvoluDeps(), {
    name: DB_NAME_A,
    laneMnemonics,
    transports: [],
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("createLinkyStore failed");
  storeA = created.value;
  rotationA = createRotation(storeA);

  // Pre-rotation data in every rotating domain.
  const contacts = createContactsRepository(storeA);
  const inserted = contacts.insert({ name: "Alice", npub: "npub1alicealicealicealice" });
  if (!inserted.ok) throw new Error("contact insert failed");
  contactId = inserted.value.id;

  const messages = createMessagesRepository(storeA);
  const applied = await messages.applyChatEvent({
    kind: "message",
    rumorId: "rotation-rumor-1",
    peerNpub: "npub1alicealicealicealice",
    senderNpub: "npub1alicealicealicealice",
    direction: "in",
    content: "before rotation",
    sentAtSec: 1_718_000_000,
  });
  if (!applied.ok) throw new Error("message apply failed");

  const token = storeA.insert("cashuToken", {
    token: "cashuAbeforeRotation",
    mint: "https://mint.example.com",
    unit: "sat",
    amount: 21,
    state: "accepted",
  });
  if (!token.ok) throw new Error("token insert failed");
  tokenId = String(token.value.id);

  const transaction = storeA.insert("transaction", {
    happenedAtSec: 1_718_000_100,
    direction: "in",
    status: "completed",
    category: "cashu",
    amount: 21,
    unit: "sat",
  });
  if (!transaction.ok) throw new Error("transaction insert failed");
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("rotation mechanics on one device", () => {
  it("starts every rotating domain at lane 0 with the base owner", async () => {
    const plan = await rotationA.adoptFromMeta();
    for (const domain of ["contacts", "wallet", "messages", "transactions"] as const) {
      expect(plan[domain].index).toBe(0);
      expect(storeA.laneGenerations(domain)).toEqual([
        { index: 0, ownerId: storeA.owners[domain].id },
      ]);
      expect(storeA.writeLaneOwnerId(domain)).toBe(storeA.owners[domain].id);
    }
  });

  it("rotates messages: new deterministic write lane, old lane stays in the read set", async () => {
    const result = await rotationA.rotate("messages");
    expect(result.index).toBe(1);
    expect(result.ownerId).toBe(await laneOwnerIdOf("messages", 1));
    expect(String(storeA.writeLaneOwnerId("messages"))).toBe(result.ownerId);
    // identity is pinned to messages lane 0 (PoC fallthrough) and must not move.
    expect(storeA.writeLaneOwnerId("identity")).toBe(storeA.owners.identity.id);

    // New writes land on the rotated lane...
    const messages = createMessagesRepository(storeA);
    const applied = await messages.applyChatEvent({
      kind: "message",
      rumorId: "rotation-rumor-2",
      peerNpub: "npub1alicealicealicealice",
      senderNpub: "npub1alicealicealicealice",
      direction: "in",
      content: "after rotation",
      sentAtSec: 1_718_000_200,
    });
    expect(applied.ok).toBe(true);

    const rows = await loadAllRows(storeA, "message");
    const byRumor = new Map(rows.map((row) => [String(row.rumorId), row]));
    expect(String((byRumor.get("rotation-rumor-2") as { ownerId: unknown }).ownerId)).toBe(
      result.ownerId,
    );
    // ...while the pre-rotation message is still on lane 0 AND still read.
    expect(String((byRumor.get("rotation-rumor-1") as { ownerId: unknown }).ownerId)).toBe(
      String(storeA.owners.messages.id),
    );
    const page = await messages.listPage({ peerNpub: "npub1alicealicealicealice", limit: 10 });
    expect(page.items.map((message) => message.rumorId).sort()).toEqual([
      "rotation-rumor-1",
      "rotation-rumor-2",
    ]);
  });

  it("keeps the full read set after rotating every domain", async () => {
    for (const domain of ["contacts", "wallet", "transactions"] as const) {
      await rotationA.rotate(domain);
    }
    const contacts = createContactsRepository(storeA);
    expect((await contacts.list()).map((contact) => contact.name)).toContain("Alice");
    const tokens = createTokensRepository(storeA);
    expect((await tokens.list()).map((token) => token.id)).toContain(tokenId);
    const transactions = createTransactionsRepository(storeA);
    expect((await transactions.listPage({ limit: 10 })).items).toHaveLength(1);
  });

  it("sticky update: editing a pre-rotation contact does NOT fork the row across lanes", async () => {
    const contacts = createContactsRepository(storeA);
    const updated = contacts.update(contactId, { name: "Alice Renamed" });
    expect(updated.ok).toBe(true);
    await storeA.flushLaneMutations();

    const rows = await loadAllRows(storeA, "contact");
    const matching = rows.filter((row) => String(row.id) === contactId);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.name).toBe("Alice Renamed");
    // The row stays on its original lane 0 — sticky routing.
    expect(String((matching[0] as { ownerId: unknown }).ownerId)).toBe(
      String(storeA.owners.contacts.id),
    );
  });

  it("sticky update: token state change after wallet rotation stays one row (fund safety)", async () => {
    const updated = storeA.update("cashuToken", { id: tokenId as never, state: "spent" });
    expect(updated.ok).toBe(true);
    await storeA.flushLaneMutations();

    const rows = await loadAllRows(storeA, "cashuToken");
    const matching = rows.filter((row) => String(row.id) === tokenId);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.state).toBe("spent");
    expect(String((matching[0] as { ownerId: unknown }).ownerId)).toBe(
      String(storeA.owners.wallet.id),
    );
  });

  it("routes inserts made after rotation to the new lane and sticky-updates them there", async () => {
    const contacts = createContactsRepository(storeA);
    const inserted = contacts.insert({ name: "Bob", npub: "npub1bobbobbobbobbob" });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const updated = contacts.update(inserted.value.id, { name: "Bob Updated" });
    expect(updated.ok).toBe(true);
    await storeA.flushLaneMutations();

    const rows = await loadAllRows(storeA, "contact");
    const matching = rows.filter((row) => String(row.id) === inserted.value.id);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.name).toBe("Bob Updated");
    expect(String((matching[0] as { ownerId: unknown }).ownerId)).toBe(
      await laneOwnerIdOf("contacts", 1),
    );
  });

  it("re-adopting is idempotent and the inspector reports the rotated state", async () => {
    const before = storeA.laneGenerations("messages");
    await rotationA.adoptFromMeta();
    expect(storeA.laneGenerations("messages")).toEqual(before);

    const statuses = await rotationA.inspect();
    const messages = statuses.find((status) => status.domain === "messages");
    expect(messages?.writeIndex).toBe(1);
    expect(messages?.rotatedAtSec).not.toBeNull();
    expect(messages?.generations.map((generation) => generation.index)).toEqual([0, 1]);
    // One message row per generation (rumor-1 on lane 0, rumor-2 on lane 1).
    expect(messages?.generations.map((generation) => generation.rowCount)).toEqual([1, 1]);
  });
});

describe("two-device convergence (byte-copy approximation, as in store.integration.test.ts)", () => {
  let storeB: LinkyStore;
  let rotationB: StorageRotation;

  beforeAll(async () => {
    // Make sure all of A's queued writes are committed before copying.
    await storeA.flushLaneMutations();
    await loadAllRows(storeA, "contact");
    for (const suffix of [".db", ".db-wal", ".db-shm"]) {
      const source = join(tempDir, `${DB_NAME_A}${suffix}`);
      if (existsSync(source)) copyFileSync(source, join(tempDir, `${DB_NAME_B}${suffix}`));
    }
    const created = createLinkyStore(createNodeEvoluDeps(), {
      name: DB_NAME_B,
      laneMnemonics: await deriveLaneMnemonics(),
      transports: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("createLinkyStore B failed");
    storeB = created.value;
    rotationB = createRotation(storeB);
  });

  it("adopts A's rotation plan and derives the identical write lanes", async () => {
    const plan = await rotationB.adoptFromMeta();
    for (const domain of ["contacts", "wallet", "messages", "transactions"] as const) {
      expect(plan[domain].index).toBe(1);
      expect(String(storeB.writeLaneOwnerId(domain))).toBe(
        String(storeA.writeLaneOwnerId(domain)),
      );
    }
    expect(storeB.laneGenerations("messages")).toEqual(storeA.laneGenerations("messages"));
  });

  it("reads every pre- and post-rotation row that A wrote", async () => {
    const contacts = createContactsRepository(storeB);
    const names = (await contacts.list()).map((contact) => contact.name);
    expect(names).toContain("Alice Renamed");
    expect(names).toContain("Bob Updated");
    const messages = createMessagesRepository(storeB);
    const page = await messages.listPage({ peerNpub: "npub1alicealicealicealice", limit: 10 });
    expect(page.items).toHaveLength(2);
    const tokens = createTokensRepository(storeB);
    expect((await tokens.list()).find((token) => token.id === tokenId)?.state).toBe("spent");
  });

  it("concurrent same-target rotations converge: same meta row id, same lane owner", async () => {
    // Both devices are at messages index 1 and rotate "concurrently" (B has
    // not seen A's rotation to 2 and vice versa).
    const [resultA, resultB] = await Promise.all([
      rotationA.rotate("messages"),
      rotationB.rotate("messages"),
    ]);
    expect(resultA.index).toBe(2);
    expect(resultB.index).toBe(2);
    // Deterministic derivation: both ended on the SAME lane.
    expect(resultA.ownerId).toBe(resultB.ownerId);
    // And both recorded the SAME deterministic meta entry — after a real
    // sync the CRDT merges them into one row; re-resolving the union of
    // both meta sets still yields index 2 (max-merge), never 3.
    const rowsA = await storeA.evolu.loadQuery(
      storeA.evolu.createQuery((db) =>
        db.selectFrom("metaEntry").selectAll().where("key", "like", "rotation.messages.%" as never),
      ),
    );
    const rowsB = await storeB.evolu.loadQuery(
      storeB.evolu.createQuery((db) =>
        db.selectFrom("metaEntry").selectAll().where("key", "like", "rotation.messages.%" as never),
      ),
    );
    const idsA = rowsA.map((row) => String(row.id)).sort();
    const idsB = rowsB.map((row) => String(row.id)).sort();
    expect(idsA).toEqual(idsB);
  });
});

describe("automatic trigger", () => {
  it("rotates once at the threshold, then respects the cooldown, and never touches counters", async () => {
    let now = 2_000_000_000;
    const rotation = createStorageRotation(storeA, {
      deriveLaneMnemonic,
      nowSec: () => now,
      thresholds: { contacts: 3, wallet: 9999, messages: 9999, transactions: 9999 },
      cooldownSec: 60,
    });

    // Local-only NUT-13 counter row — must be byte-identical after rotation.
    const counterId = createIdFromString<"CashuCounter">("rotation-counter-guard");
    const counter = storeA.upsert("_cashuCounter", {
      id: counterId,
      key: "det:https://mint.example.com|sat|009a1f",
      value: "17",
    });
    expect(counter.ok).toBe(true);

    const writeIndexOf = async () => (await rotation.adoptFromMeta()).contacts.index;
    const startIndex = await writeIndexOf();

    // Fill the contacts write lane past the threshold.
    const contacts = createContactsRepository(storeA);
    for (let i = 0; i < 3; i++) {
      const inserted = contacts.insert({ name: `Filler ${String(i)}` });
      expect(inserted.ok).toBe(true);
    }
    await loadAllRows(storeA, "contact");

    const rotated = await rotation.maybeAutoRotate();
    expect(rotated.map((result) => result.domain)).toEqual(["contacts"]);
    expect(await writeIndexOf()).toBe(startIndex + 1);

    // Threshold not reached on the fresh lane + cooldown active: no-op.
    expect(await rotation.maybeAutoRotate()).toEqual([]);

    // Even past the cooldown, an empty write lane never rotates.
    now += 3600;
    expect(await rotation.maybeAutoRotate()).toEqual([]);
    expect(await writeIndexOf()).toBe(startIndex + 1);

    // Counter row untouched: same value, still on the app-owner (local-only).
    const counters = await storeA.evolu.loadQuery(
      storeA.evolu.createQuery((db) => db.selectFrom("_cashuCounter").selectAll()),
    );
    const guard = counters.find((row) => String(row.id) === String(counterId));
    expect(guard?.value).toBe("17");
    expect(String((guard as { ownerId?: unknown } | undefined)?.ownerId)).toBe(
      String(storeA.owners.meta.id),
    );
  });
});
