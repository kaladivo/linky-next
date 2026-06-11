/**
 * TransactionsRepository (issue #35) — phase-rich wallet history on the
 * transactions lane: outcome records incl. errors and intermediate phases,
 * newest-first cursor paging (#25 pattern). Real Evolu on local SQLite,
 * `transports: []`.
 */
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveOwnerLane, MasterSecret } from "@linky/core";

import {
  createContactsRepository,
  createLinkyStore,
  createTransactionsRepository,
  SYNC_DOMAINS,
} from "../src/index";
import type { LaneMnemonics, LinkyStore, TransactionsRepository } from "../src/index";
import { createNodeEvoluDeps } from "./nodeEvoluDeps";

/** Fixed test master secret (16 bytes), unique per test file. Dev/test only. */
const MASTER_SECRET_HEX = "deadbeefcafef00d0123456789abcdef";

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));

const BASE_SEC = 1_750_000_000;

const originalCwd = process.cwd();
let store: LinkyStore;
let repository: TransactionsRepository;

beforeAll(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "linky-transactions-repo-test-")));

  const masterSecret = MasterSecret.make(fromHex(MASTER_SECRET_HEX));
  const entries = await Promise.all(
    SYNC_DOMAINS.map(async (domain) => {
      const lane = await Effect.runPromise(deriveOwnerLane(masterSecret, domain));
      return [domain, lane.mnemonic] as const;
    }),
  );
  const laneMnemonics = Object.fromEntries(entries) as unknown as LaneMnemonics;

  const result = createLinkyStore(createNodeEvoluDeps(), {
    name: "linky-transactions-repo-test",
    laneMnemonics,
    transports: [],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("createLinkyStore failed");
  store = result.value;
  repository = createTransactionsRepository(store);
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("record + update (tx.record)", () => {
  it("records a full outcome with mint, contact link, fees, and details", () => {
    const contacts = createContactsRepository(store);
    const contact = contacts.insert({ name: "Bob" });
    expect(contact.ok).toBe(true);
    if (!contact.ok) return;

    const result = repository.record({
      happenedAtSec: BASE_SEC,
      direction: "out",
      status: "completed",
      category: "cashu",
      method: "token",
      phase: "settle",
      amount: 1000,
      feeAmount: 2,
      unit: "sat",
      mintUrl: "https://mint.example.com/",
      contactId: contact.value.id,
      note: "lunch",
      detailsJson: JSON.stringify({ quoteId: "q-1" }),
    });
    expect(result.ok).toBe(true);
  });

  it("reads the record back with the normalized mint URL", async () => {
    const inserted = repository.record({
      happenedAtSec: BASE_SEC + 1,
      direction: "in",
      status: "completed",
      category: "lightning",
      method: "invoice",
      amount: 50,
      mintUrl: "https://mint.example.com//",
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;

    const record = await repository.getById(inserted.value.id);
    expect(record).not.toBeNull();
    expect(record!.direction).toBe("in");
    expect(record!.mintUrl).toBe("https://mint.example.com");
    expect(record!.phase).toBeNull();
    expect(record!.error).toBeNull();
  });

  it("tracks phases and errors across a failing flow", async () => {
    const started = repository.record({
      happenedAtSec: BASE_SEC + 2,
      direction: "out",
      status: "pending",
      category: "lightning",
      method: "invoice",
      phase: "quote",
      amount: 777,
      unit: "sat",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.value.id;

    // Flow progresses…
    const melting = repository.update(id, { phase: "melt" });
    expect(melting.ok).toBe(true);

    // …and fails: the error record is kept for support (tx.record contract).
    const failed = repository.update(id, {
      status: "failed",
      error: "mint melt rejected: quote expired",
      detailsJson: JSON.stringify({ quoteId: "q-2", httpStatus: 400 }),
    });
    expect(failed.ok).toBe(true);

    const record = await repository.getById(id);
    expect(record!.status).toBe("failed");
    expect(record!.phase).toBe("melt"); // last reached phase survives the failure
    expect(record!.error).toBe("mint melt rejected: quote expired");
    expect(JSON.parse(record!.detailsJson!)).toEqual({ quoteId: "q-2", httpStatus: 400 });
  });

  it("returns typed errors for malformed ids and contact ids", () => {
    const badId = repository.update("nope", { status: "completed" });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error._tag).toBe("InvalidTransactionIdError");

    const badContact = repository.record({
      happenedAtSec: BASE_SEC,
      direction: "in",
      status: "completed",
      category: "cashu",
      contactId: "not-a-contact-id",
    });
    expect(badContact.ok).toBe(false);
    if (!badContact.ok) expect(badContact.error._tag).toBe("TransactionValidationError");
  });
});

describe("listPage (tx.list)", () => {
  it("pages newest-first with a strictly-older (happenedAtSec, id) cursor", async () => {
    // A dedicated store so paging math is exact.
    const masterSecret = MasterSecret.make(fromHex("00ff00ff00ff00ff00ff00ff00ff00ff"));
    const entries = await Promise.all(
      SYNC_DOMAINS.map(async (domain) => {
        const lane = await Effect.runPromise(deriveOwnerLane(masterSecret, domain));
        return [domain, lane.mnemonic] as const;
      }),
    );
    const fresh = createLinkyStore(createNodeEvoluDeps(), {
      name: "linky-transactions-paging-test",
      laneMnemonics: Object.fromEntries(entries) as unknown as LaneMnemonics,
      transports: [],
    });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    const pagingRepo = createTransactionsRepository(fresh.value);

    for (let index = 0; index < 5; index += 1) {
      const result = pagingRepo.record({
        happenedAtSec: BASE_SEC + index,
        direction: index % 2 === 0 ? "in" : "out",
        status: "completed",
        category: "cashu",
        amount: index + 1,
      });
      expect(result.ok).toBe(true);
    }

    const firstPage = await pagingRepo.listPage({ limit: 2 });
    expect(firstPage.items.map((item) => item.happenedAtSec)).toEqual([
      BASE_SEC + 4,
      BASE_SEC + 3,
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await pagingRepo.listPage({ limit: 2, cursor: firstPage.nextCursor! });
    expect(secondPage.items.map((item) => item.happenedAtSec)).toEqual([
      BASE_SEC + 2,
      BASE_SEC + 1,
    ]);
    expect(secondPage.nextCursor).not.toBeNull();

    const lastPage = await pagingRepo.listPage({ limit: 2, cursor: secondPage.nextCursor! });
    expect(lastPage.items.map((item) => item.happenedAtSec)).toEqual([BASE_SEC]);
    expect(lastPage.nextCursor).toBeNull();
  });
});

describe("lane routing", () => {
  it("lands every transaction row on the transactions lane", async () => {
    const rows = await store.evolu.loadQuery(
      store.evolu.createQuery((db) => db.selectFrom("transaction").selectAll()),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect((row as { ownerId?: unknown }).ownerId).toBe(store.owners.transactions.id);
    }
  });
});
