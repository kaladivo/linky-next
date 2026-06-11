/**
 * Integration tests: Evolu 7.4.1 against real local SQLite (better-sqlite3)
 * in a Node vitest environment. No network — transports are empty.
 *
 * Covers the storage-spike questions from issue #9:
 *
 * 1. Create table / insert / query through the Linky schema module.
 * 2. Rows are persisted in a real SQLite file (verified out-of-band by
 *    opening the file with better-sqlite3 directly).
 * 3. Owners are deterministically derived from external entropy/mnemonics
 *    (the derived-identity scheme from issues #13), pinned with golden values.
 * 4. Owner lanes: mutations can target a derived ShardOwner lane.
 */
import BetterSqlite from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SimpleName } from "@evolu/common";
import {
  appOwnerFromEntropy,
  appOwnerFromMnemonic,
  createLinkyEvolu,
  deriveShardOwner,
  shardOwnerFromEntropy,
} from "../src/index";
import { createNodeEvoluDeps } from "./nodeEvoluDeps";

/**
 * Standard BIP-39 test vector. Dev/test only — never associated with real
 * funds or identities.
 */
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const DB_NAME = "linky-evolu-spike-test";

const originalCwd = process.cwd();
let tempDir: string;

beforeAll(() => {
  // createBetterSqliteDriver writes `${name}.db` into the cwd.
  tempDir = mkdtempSync(join(tmpdir(), "linky-evolu-spike-"));
  process.chdir(tempDir);
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("owner derivation from external entropy (derived-identity scheme)", () => {
  it("derives the same AppOwner from the same mnemonic (deterministic)", () => {
    const a = appOwnerFromMnemonic(TEST_MNEMONIC);
    const b = appOwnerFromMnemonic(TEST_MNEMONIC);
    expect(a).not.toBeNull();
    expect(a?.id).toBe(b?.id);
    expect(a?.encryptionKey).toEqual(b?.encryptionKey);
    expect(a?.writeKey).toEqual(b?.writeKey);
  });

  it("rejects an invalid mnemonic", () => {
    expect(appOwnerFromMnemonic("definitely not a mnemonic")).toBeNull();
  });

  it("derives an AppOwner from raw 32-byte entropy", () => {
    const entropy = new Uint8Array(32).fill(7);
    const a = appOwnerFromEntropy(entropy);
    const b = appOwnerFromEntropy(new Uint8Array(32).fill(7));
    expect(a).not.toBeNull();
    expect(a?.id).toBe(b?.id);
    expect(appOwnerFromEntropy(new Uint8Array(16))).toBeNull();
  });

  it("derives distinct ShardOwner lanes from distinct entropy", () => {
    const laneA = shardOwnerFromEntropy(new Uint8Array(32).fill(1));
    const laneB = shardOwnerFromEntropy(new Uint8Array(32).fill(2));
    expect(laneA?.id).not.toBe(laneB?.id);
  });

  it("derives deterministic ShardOwner lanes from an AppOwner path", () => {
    const appOwner = appOwnerFromMnemonic(TEST_MNEMONIC);
    expect(appOwner).not.toBeNull();
    if (!appOwner) return;
    const contacts0 = deriveShardOwner(appOwner, ["contacts", 0]);
    const contacts0Again = deriveShardOwner(appOwner, ["contacts", 0]);
    const contacts1 = deriveShardOwner(appOwner, ["contacts", 1]);
    expect(contacts0.id).toBe(contacts0Again.id);
    expect(contacts0.id).not.toBe(contacts1.id);
    expect(contacts0.id).not.toBe(appOwner.id);
  });

  it("matches golden owner ids (compatibility invariant)", () => {
    // Golden values produced by @evolu/common 7.4.1 (same version as the
    // PoC). If these change, restore of existing identities breaks.
    const appOwner = appOwnerFromMnemonic(TEST_MNEMONIC);
    expect(appOwner?.id).toMatchInlineSnapshot(`"F0xh0HpiAx5shgCgtGENww"`);
    const entropyOwner = appOwnerFromEntropy(new Uint8Array(32).fill(7));
    expect(entropyOwner?.id).toMatchInlineSnapshot(`"LQwtOZjsb8gqxPd38MJrqQ"`);
  });
});

describe("Evolu against local SQLite", () => {
  it("creates a table, inserts a row, and reads it back", async () => {
    const appOwner = appOwnerFromMnemonic(TEST_MNEMONIC);
    expect(appOwner).not.toBeNull();
    if (!appOwner) return;

    const evolu = createLinkyEvolu(createNodeEvoluDeps(), {
      name: SimpleName.orThrow(DB_NAME),
      // Local-only: no sync in integration tests.
      transports: [],
      externalAppOwner: appOwner,
    });

    const inserted = evolu.insert("spikeNote", {
      content: "hello from vitest",
    });
    expect(inserted.ok).toBe(true);

    const notes = evolu.createQuery((db) =>
      db.selectFrom("spikeNote").selectAll().where("isDeleted", "is not", 1),
    );
    const rows = await evolu.loadQuery(notes);
    expect(rows.length).toBe(1);
    expect(rows[0]?.content).toBe("hello from vitest");

    const resolvedOwner = await evolu.appOwner;
    expect(resolvedOwner.id).toBe(appOwner.id);
  });

  it("supports mutations on a derived owner lane", async () => {
    const appOwner = appOwnerFromMnemonic(TEST_MNEMONIC);
    if (!appOwner) throw new Error("unreachable");
    const lane = deriveShardOwner(appOwner, ["spike-lane", 0]);

    // Same instance (createEvolu caches by name).
    const evolu = createLinkyEvolu(createNodeEvoluDeps(), {
      name: SimpleName.orThrow(DB_NAME),
      transports: [],
      externalAppOwner: appOwner,
    });

    const inserted = evolu.insert("spikeNote", { content: "lane note" }, { ownerId: lane.id });
    expect(inserted.ok).toBe(true);

    const notes = evolu.createQuery((db) =>
      db
        .selectFrom("spikeNote")
        .selectAll()
        .where("isDeleted", "is not", 1)
        .orderBy("createdAt", "asc"),
    );
    const rows = await evolu.loadQuery(notes);
    expect(rows.map((r) => r.content)).toContain("lane note");
  });

  it("persists rows in the SQLite file on disk", () => {
    // Open the database file Evolu wrote, independently of Evolu, and check
    // the row is physically there (local persistence, not an in-memory cache).
    const db = new BetterSqlite(join(tempDir, `${DB_NAME}.db`), {
      readonly: true,
    });
    try {
      const rows = db.prepare(`select "content" from "spikeNote"`).all() as Array<{
        content: string;
      }>;
      expect(rows.map((r) => r.content)).toContain("hello from vitest");
    } finally {
      db.close();
    }
  });
});
