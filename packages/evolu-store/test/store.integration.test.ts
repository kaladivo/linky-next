/**
 * Integration tests for the six-domain base schema and owner-lane separation
 * (issue #15). Evolu 7.4.1 on real local SQLite (better-sqlite3) in Node;
 * `transports: []` everywhere — every write and read here happens with sync
 * fully disabled, which IS the local-first guarantee (`sync.local-data`).
 *
 * Covered:
 *
 * 1. `createLinkyStore` boots from core-derived lane mnemonics; typed errors
 *    for invalid names/mnemonics.
 * 2. The schema creates cleanly: all six domain tables exist in the SQLite
 *    file with their domain columns and Evolu's system columns.
 * 3. Every domain's mutations land on that domain's derived owner lane
 *    (asserted via the per-row `ownerId` system column and the encrypted
 *    `evolu_history` sync payload).
 * 4. Restore-reconnect: a second derivation from the same master identity
 *    yields byte-identical owners, and a fresh store instance booted from
 *    those owners over a copy of instance A's SQLite file reads A's rows.
 *    Live two-device sync through a real relay is deliberately NOT tested
 *    here — that verification belongs to issues #53/#58 (sync servers /
 *    cross-device sync).
 */
import BetterSqlite from "better-sqlite3";
import { Effect } from "effect";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ownerIdToOwnerIdBytes } from "@evolu/common";
import type { OwnerId } from "@evolu/common";
import { deriveOwnerLane, MasterSecret } from "@linky/core";

import { createLinkyStore, SYNC_DOMAINS, tableSyncDomain } from "../src/index";
import type { ContactId, LinkyStore, LaneMnemonics, LinkyTableName } from "../src/index";
import { createNodeEvoluDeps } from "./nodeEvoluDeps";

const DB_NAME_A = "linky-store-test-a";
const DB_NAME_B = "linky-store-test-b";

/** Fixed test master secret (16 bytes). Dev/test only. */
const MASTER_SECRET_HEX = "000102030405060708090a0b0c0d0e0f";

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));

/** Derives the six lane mnemonics exactly like the app will (issue #13). */
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

const originalCwd = process.cwd();
let tempDir: string;
let laneMnemonics: LaneMnemonics;
let storeA: LinkyStore;
let contactId: ContactId;

/** Creates one representative row per domain through the lane-routed mutations. */
const writeOneRowPerDomain = (store: LinkyStore) => {
  const contact = store.insert("contact", {
    name: "Alice",
    npub: "npub1exampleexampleexampleexampleexampleexampleexampleexample",
  });
  expect(contact.ok).toBe(true);
  if (!contact.ok) throw new Error("contact insert failed");
  contactId = contact.value.id;

  const inserts = {
    cashuToken: store.insert("cashuToken", {
      token: "cashuAeyJ0b2tlbiI6W119",
      mint: "https://mint.example.com",
      unit: "sat",
      amount: 21,
      state: "accepted",
    }),
    message: store.insert("message", {
      contactId,
      direction: "in",
      content: "hello from the integration test",
      wrapId: "wrap-event-id-1",
      sentAtSec: 1_718_000_000,
    }),
    transaction: store.insert("transaction", {
      happenedAtSec: 1_718_000_100,
      direction: "in",
      status: "completed",
      category: "cashu",
      amount: 21,
      unit: "sat",
      contactId,
    }),
    nostrIdentity: store.insert("nostrIdentity", {
      nsec: "nsec1exampleexampleexampleexampleexampleexampleexampleexample",
      npub: "npub1exampleexampleexampleexampleexampleexampleexampleexample",
      source: "derived",
    }),
    metaEntry: store.insert("metaEntry", { key: "schemaVersion", value: "1" }),
  };
  for (const [table, result] of Object.entries(inserts)) {
    expect(result.ok, `insert into ${table}`).toBe(true);
  }
};

/** Loads all rows of a table including the ownerId system column. */
const loadRows = async (store: LinkyStore, table: LinkyTableName) => {
  const query = store.evolu.createQuery((db) =>
    db.selectFrom(table).selectAll().where("isDeleted", "is not", 1),
  );
  return store.evolu.loadQuery(query);
};

beforeAll(async () => {
  // createBetterSqliteDriver writes `${name}.db` into the cwd.
  tempDir = mkdtempSync(join(tmpdir(), "linky-store-test-"));
  process.chdir(tempDir);

  laneMnemonics = await deriveLaneMnemonics();
  const store = createLinkyStore(createNodeEvoluDeps(), {
    name: DB_NAME_A,
    laneMnemonics,
    transports: [], // local-only: every test below runs with sync disabled
  });
  expect(store.ok).toBe(true);
  if (!store.ok) throw new Error("createLinkyStore failed");
  storeA = store.value;
  writeOneRowPerDomain(storeA);
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("createLinkyStore", () => {
  it("returns a typed error for an invalid database name", () => {
    const result = createLinkyStore(createNodeEvoluDeps(), {
      name: "not a valid simple name!",
      laneMnemonics,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("InvalidStoreNameError");
  });

  it("returns a typed error naming the domain with an invalid lane mnemonic", () => {
    const result = createLinkyStore(createNodeEvoluDeps(), {
      name: "linky-store-test-invalid",
      laneMnemonics: { ...laneMnemonics, transactions: "garbage" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      _tag: "InvalidLaneMnemonicError",
      domain: "transactions",
    });
  });

  it("boots with the meta lane owner as the Evolu AppOwner", async () => {
    const appOwner = await storeA.evolu.appOwner;
    expect(appOwner.id).toBe(storeA.owners.meta.id);
  });
});

describe("six-domain schema on local SQLite", () => {
  it("creates all six domain tables with domain + system columns", async () => {
    // Force a full round-trip so the worker has definitely initialized.
    await loadRows(storeA, "metaEntry");

    const db = new BetterSqlite(join(tempDir, `${DB_NAME_A}.db`), { readonly: true });
    try {
      const tables = db
        .prepare(`select name from sqlite_master where type = 'table'`)
        .all()
        .map((row) => (row as { name: string }).name);
      for (const table of Object.keys(tableSyncDomain)) {
        expect(tables, `table ${table}`).toContain(table);
      }

      const contactColumns = db
        .prepare(`select name from pragma_table_info('contact')`)
        .all()
        .map((row) => (row as { name: string }).name);
      for (const column of ["id", "name", "npub", "lnAddress", "groupName", "archivedAtSec"]) {
        expect(contactColumns).toContain(column);
      }
      // System columns are added by Evolu, never declared in the schema.
      for (const column of ["ownerId", "createdAt", "updatedAt", "isDeleted"]) {
        expect(contactColumns).toContain(column);
      }
    } finally {
      db.close();
    }
  });

  it("reads every domain's rows back with sync disabled (local-first)", async () => {
    const contact = await loadRows(storeA, "contact");
    expect(contact).toHaveLength(1);
    expect(contact[0]?.name).toBe("Alice");

    const message = await loadRows(storeA, "message");
    expect(message).toHaveLength(1);
    expect(message[0]?.contactId).toBe(contactId);

    expect(await loadRows(storeA, "cashuToken")).toHaveLength(1);
    expect(await loadRows(storeA, "transaction")).toHaveLength(1);
    expect(await loadRows(storeA, "nostrIdentity")).toHaveLength(1);
    expect(await loadRows(storeA, "metaEntry")).toHaveLength(1);
  });

  it("lands every table's rows on its domain's derived owner lane", async () => {
    for (const [table, domain] of Object.entries(tableSyncDomain)) {
      const rows = await loadRows(storeA, table as LinkyTableName);
      expect(rows.length, `rows in ${table}`).toBeGreaterThan(0);
      for (const row of rows) {
        expect(
          (row as { ownerId: OwnerId }).ownerId,
          `ownerId of ${table} row (domain ${domain})`,
        ).toBe(storeA.owners[domain].id);
      }
      expect(storeA.laneOwnerId(table as LinkyTableName)).toBe(storeA.owners[domain].id);
    }
  });

  it("separates the lanes: distinct owners per domain (identity = messages 0, PoC fallthrough)", () => {
    const ids = SYNC_DOMAINS.map((domain) => storeA.owners[domain].id);
    // identity intentionally shares the messages-0 owner (production
    // derivation fallthrough, see @linky/core derivationPaths.ts), so six
    // domains map onto five distinct sync lanes.
    expect(new Set(ids).size).toBe(5);
    expect(storeA.owners.identity.id).toBe(storeA.owners.messages.id);
    const rotating = ["meta", "contacts", "wallet", "messages", "transactions"] as const;
    expect(new Set(rotating.map((domain) => storeA.owners[domain].id)).size).toBe(5);
  });

  it("keys the encrypted sync payload (evolu_history) by the derived lane owners", () => {
    const db = new BetterSqlite(join(tempDir, `${DB_NAME_A}.db`), { readonly: true });
    try {
      const countFor = (ownerId: OwnerId): number => {
        const row = db
          .prepare(`select count(*) as count from evolu_history where ownerId = ?`)
          .get(Buffer.from(ownerIdToOwnerIdBytes(ownerId))) as { count: number };
        return row.count;
      };
      for (const [table, domain] of Object.entries(tableSyncDomain)) {
        expect(
          countFor(storeA.owners[domain].id),
          `history entries for ${domain} lane (${table})`,
        ).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });
});

describe("restore-reconnect (same master identity, second instance)", () => {
  it("derives byte-identical owners from a fresh derivation of the same master secret", async () => {
    // Simulates restore on another device: derive the lane mnemonics again
    // from the same master secret and rebuild the owners from scratch.
    const restoredStore = createLinkyStore(createNodeEvoluDeps(), {
      name: "linky-store-test-derivation-check",
      laneMnemonics: await deriveLaneMnemonics(),
      transports: [],
    });
    expect(restoredStore.ok).toBe(true);
    if (!restoredStore.ok) return;
    for (const domain of SYNC_DOMAINS) {
      expect(restoredStore.value.owners[domain].id).toBe(storeA.owners[domain].id);
      expect(restoredStore.value.owners[domain].encryptionKey).toEqual(
        storeA.owners[domain].encryptionKey,
      );
      expect(restoredStore.value.owners[domain].writeKey).toEqual(storeA.owners[domain].writeKey);
    }
  });

  it("reads instance A's rows from a fresh instance with the same owners and SQLite file", async () => {
    // Approximation of two-device sync without a live relay (see module doc;
    // live relay verification belongs to #53/#58): instance B = same lane
    // mnemonics + a byte copy of A's database, i.e. exactly what B would
    // hold after a full sync of every lane.
    await loadRows(storeA, "metaEntry"); // ensure A's writes are committed
    for (const suffix of [".db", ".db-wal", ".db-shm"]) {
      const source = join(tempDir, `${DB_NAME_A}${suffix}`);
      if (existsSync(source)) {
        copyFileSync(source, join(tempDir, `${DB_NAME_B}${suffix}`));
      }
    }

    const storeB = createLinkyStore(createNodeEvoluDeps(), {
      name: DB_NAME_B,
      laneMnemonics: await deriveLaneMnemonics(),
      transports: [],
    });
    expect(storeB.ok).toBe(true);
    if (!storeB.ok) return;

    const appOwnerB = await storeB.value.evolu.appOwner;
    expect(appOwnerB.id).toBe(storeA.owners.meta.id);

    // B sees A's data in every domain, scoped to the owners B derived itself.
    for (const [table, domain] of Object.entries(tableSyncDomain)) {
      const rows = await loadRows(storeB.value, table as LinkyTableName);
      expect(rows.length, `B's rows in ${table}`).toBeGreaterThan(0);
      for (const row of rows) {
        expect((row as { ownerId: OwnerId }).ownerId).toBe(storeB.value.owners[domain].id);
      }
    }
    const contacts = await loadRows(storeB.value, "contact");
    expect(contacts[0]?.name).toBe("Alice");
  });
});
