/**
 * MintsRepository (issue #35) — known mints + cached NUT-06 info on the
 * wallet lane, main-mint preference as a metaEntry on the meta lane. Real
 * Evolu on local SQLite, `transports: []`.
 */
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveOwnerLane, MasterSecret } from "@linky/core";

import {
  createLinkyStore,
  createMintsRepository,
  MAIN_MINT_META_KEY,
  SYNC_DOMAINS,
} from "../src/index";
import type { LaneMnemonics, LinkyStore, MintsRepository } from "../src/index";
import { createNodeEvoluDeps } from "./nodeEvoluDeps";

/** Fixed test master secret (16 bytes), unique per test file. Dev/test only. */
const MASTER_SECRET_HEX = "11223344556677889900aabbccddeeff";

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));

const originalCwd = process.cwd();
let store: LinkyStore;
let repository: MintsRepository;

beforeAll(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "linky-mints-repo-test-")));

  const masterSecret = MasterSecret.make(fromHex(MASTER_SECRET_HEX));
  const entries = await Promise.all(
    SYNC_DOMAINS.map(async (domain) => {
      const lane = await Effect.runPromise(deriveOwnerLane(masterSecret, domain));
      return [domain, lane.mnemonic] as const;
    }),
  );
  const laneMnemonics = Object.fromEntries(entries) as unknown as LaneMnemonics;

  const result = createLinkyStore(createNodeEvoluDeps(), {
    name: "linky-mints-repo-test",
    laneMnemonics,
    transports: [],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("createLinkyStore failed");
  store = result.value;
  repository = createMintsRepository(store);
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("ensure", () => {
  it("creates one row per normalized URL — trailing slashes and whitespace dedupe", async () => {
    const first = await repository.ensure(" https://mint.one.example// ");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await repository.ensure("https://mint.one.example");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.id).toBe(first.value.id);

    const record = await repository.getByUrl("https://mint.one.example/");
    expect(record).not.toBeNull();
    expect(record!.url).toBe("https://mint.one.example");
  });

  it("rejects an empty URL with a typed error", async () => {
    const result = await repository.ensure("   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("InvalidMintUrlError");
  });
});

describe("recordInfo", () => {
  it("caches NUT-06 info, fees, icon, and fetchedAt (mints.fetch-info)", async () => {
    const url = "https://mint.info.example";
    const result = await repository.recordInfo(url, {
      name: "Info Mint",
      iconUrl: "https://mint.info.example/icon.png",
      infoJson: JSON.stringify({ name: "Info Mint", nuts: { "15": {} } }),
      feesJson: JSON.stringify({ ppk: 1 }),
      fetchedAtSec: 1_750_000_000,
    });
    expect(result.ok).toBe(true);

    const record = await repository.getByUrl(url);
    expect(record).not.toBeNull();
    expect(record!.name).toBe("Info Mint");
    expect(record!.iconUrl).toBe("https://mint.info.example/icon.png");
    expect(JSON.parse(record!.infoJson!)).toEqual({ name: "Info Mint", nuts: { "15": {} } });
    expect(JSON.parse(record!.feesJson!)).toEqual({ ppk: 1 });
    expect(record!.infoFetchedAtSec).toBe(1_750_000_000);
  });

  it("refreshes only the provided fields, keeping the rest of the cache", async () => {
    const url = "https://mint.info.example";
    const refreshed = await repository.recordInfo(url, { fetchedAtSec: 1_750_000_100 });
    expect(refreshed.ok).toBe(true);

    const record = await repository.getByUrl(url);
    expect(record!.infoFetchedAtSec).toBe(1_750_000_100);
    expect(record!.name).toBe("Info Mint"); // untouched
  });
});

describe("remove", () => {
  it("soft-removes a mint; idempotent; tokens are out of scope", async () => {
    const url = "https://mint.removed.example";
    await repository.ensure(url);
    expect(await repository.remove(url)).toEqual({ removed: true });
    expect(await repository.getByUrl(url)).toBeNull();
    expect(await repository.remove(url)).toEqual({ removed: false });

    const urls = (await repository.list()).map((record) => record.url);
    expect(urls).not.toContain(url);
  });
});

describe("main-mint preference (metaEntry, meta lane)", () => {
  it("is null when unset (callers fall back to the env default)", async () => {
    expect(await repository.getMainMintUrl()).toBeNull();
  });

  it("stores exactly one normalized value and replaces it on change", async () => {
    const first = await repository.setMainMintUrl("https://mint.main.example/");
    expect(first.ok).toBe(true);
    expect(await repository.getMainMintUrl()).toBe("https://mint.main.example");

    const second = await repository.setMainMintUrl("https://mint.other.example");
    expect(second.ok).toBe(true);
    expect(await repository.getMainMintUrl()).toBe("https://mint.other.example");

    // Single row: the preference is ONE LWW register, not a per-mint flag.
    const query = store.evolu.createQuery((db) =>
      db
        .selectFrom("metaEntry")
        .selectAll()
        .where("isDeleted", "is not", 1)
        .where("key", "=", MAIN_MINT_META_KEY as never),
    );
    const rows = await store.evolu.loadQuery(query);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.value)).toBe("https://mint.other.example");
  });

  it("rejects an empty URL", async () => {
    const result = await repository.setMainMintUrl("");
    expect(result.ok).toBe(false);
  });
});

describe("lane routing", () => {
  it("lands cashuMint rows on the wallet lane and the preference on the meta lane", async () => {
    const mintRows = await store.evolu.loadQuery(
      store.evolu.createQuery((db) => db.selectFrom("cashuMint").selectAll()),
    );
    expect(mintRows.length).toBeGreaterThan(0);
    for (const row of mintRows) {
      expect((row as { ownerId?: unknown }).ownerId).toBe(store.owners.wallet.id);
    }

    const metaRows = await store.evolu.loadQuery(
      store.evolu.createQuery((db) =>
        db.selectFrom("metaEntry").selectAll().where("key", "=", MAIN_MINT_META_KEY as never),
      ),
    );
    expect(metaRows.length).toBeGreaterThan(0);
    for (const row of metaRows) {
      expect((row as { ownerId?: unknown }).ownerId).toBe(store.owners.meta.id);
    }
  });
});
