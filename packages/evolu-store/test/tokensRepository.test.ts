/**
 * TokensRepository (issue #35) — token persistence on the wallet lane with
 * the #33 state machine enforced at the repository boundary. Real Evolu on
 * local SQLite (better-sqlite3), `transports: []`.
 *
 * Covered: insert + schema-level state-union enforcement, legal/illegal
 * transitions (incl. error bookkeeping and the Recover special case),
 * NUT-07 reconcile batches, the purge policy, balance queries over
 * mixed-state fixtures (math delegated to core), spendable selection
 * (PoC policy: whole accepted set at the mint), and wallet-lane routing.
 */
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveOwnerLane, MasterSecret, mintBalanceFor, unitBalanceFor } from "@linky/core";
import type { ReceiveTokenResult } from "@linky/core";

import { createLinkyStore, createTokensRepository, SYNC_DOMAINS } from "../src/index";
import type { LaneMnemonics, LinkyStore, TokensRepository } from "../src/index";
import { createNodeEvoluDeps } from "./nodeEvoluDeps";

/** Fixed test master secret (16 bytes), unique per test file. Dev/test only. */
const MASTER_SECRET_HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));

const MINT = "https://mint.example.com";
const OTHER_MINT = "https://other-mint.example.com";
const NOW = 1_750_000_000_000;

const originalCwd = process.cwd();
let store: LinkyStore;
let repository: TokensRepository;

const insertToken = (
  overrides: Partial<Parameters<TokensRepository["insert"]>[0]> = {},
): string => {
  const result = repository.insert({
    mintUrl: MINT,
    unit: "sat",
    amount: 21,
    state: "accepted",
    token: "cashuAtest-token-fixture",
    ...overrides,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("token insert failed");
  return result.value.id;
};

beforeAll(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "linky-tokens-repo-test-")));

  const masterSecret = MasterSecret.make(fromHex(MASTER_SECRET_HEX));
  const entries = await Promise.all(
    SYNC_DOMAINS.map(async (domain) => {
      const lane = await Effect.runPromise(deriveOwnerLane(masterSecret, domain));
      return [domain, lane.mnemonic] as const;
    }),
  );
  const laneMnemonics = Object.fromEntries(entries) as unknown as LaneMnemonics;

  const result = createLinkyStore(createNodeEvoluDeps(), {
    name: "linky-tokens-repo-test",
    laneMnemonics,
    transports: [],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("createLinkyStore failed");
  store = result.value;
  repository = createTokensRepository(store);
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("insert", () => {
  it("persists a record and reads it back as the core TokenRecord shape", async () => {
    const id = insertToken({ mintUrl: `${MINT}/`, amount: 42 });
    const record = await repository.getById(id);
    expect(record).not.toBeNull();
    expect(record!.mintUrl).toBe(MINT); // trailing slash normalized away
    expect(record!.unit).toBe("sat");
    expect(record!.amount).toBe(42);
    expect(record!.state).toBe("accepted");
    expect(record!.token).toBe("cashuAtest-token-fixture");
    expect(record!.error).toBeNull();
    expect(record!.createdAtMillis).toBeGreaterThan(0);
    expect(record!.updatedAtMillis).toBe(record!.createdAtMillis);
  });

  it("rejects an out-of-model state at the repo boundary", () => {
    const result = repository.insert({
      mintUrl: MINT,
      amount: 1,
      state: "definitely-not-a-state" as never,
      token: "cashuAbogus",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("TokenValidationError");
  });

  it("rejects an out-of-model state at the schema level too (raw mutation)", () => {
    // Even bypassing the repository, the column union (#33's 8 states)
    // rejects unknown values.
    const result = store.insert("cashuToken", {
      token: "cashuAraw",
      mint: MINT,
      state: "half-spent" as never,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty mint URL", () => {
    const result = repository.insert({
      mintUrl: "   ",
      amount: 1,
      state: "accepted",
      token: "cashuAempty-mint",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("TokenValidationError");
  });
});

describe("transition", () => {
  it("walks a legal lifecycle: accepted -> issued -> pending -> accepted", async () => {
    const id = insertToken();

    const issued = await repository.transition(id, { _tag: "Emit" }, NOW);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.value.state).toBe("issued");
    expect(issued.value.updatedAtMillis).toBe(NOW);

    const pending = await repository.transition(id, { _tag: "MarkInFlight" }, NOW + 1);
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value.state).toBe("pending");

    const returned = await repository.transition(id, { _tag: "Return" }, NOW + 2);
    expect(returned.ok).toBe(true);
    if (!returned.ok) return;
    expect(returned.value.state).toBe("accepted");

    const persisted = await repository.getById(id);
    expect(persisted!.state).toBe("accepted");
  });

  it("rejects an illegal transition and persists nothing", async () => {
    const id = insertToken(); // accepted

    // MarkInFlight is only legal from "issued".
    const result = await repository.transition(id, { _tag: "MarkInFlight" }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      _tag: "IllegalTokenStateTransitionError",
      from: "accepted",
      transition: "MarkInFlight",
    });

    const persisted = await repository.getById(id);
    expect(persisted!.state).toBe("accepted");
  });

  it("rejects every transition out of the terminal spent state", async () => {
    const id = insertToken();
    const spent = await repository.transition(id, { _tag: "MarkSpent" }, NOW);
    expect(spent.ok).toBe(true);

    for (const tag of ["Emit", "Reserve", "Return", "MarkSpent", "MarkError"] as const) {
      const result = await repository.transition(
        id,
        (tag === "MarkError" ? { _tag: tag, message: "x" } : { _tag: tag }) as never,
        NOW + 1,
      );
      expect(result.ok, `transition ${tag} from spent`).toBe(false);
    }
  });

  it("MarkError stores the message; leaving error clears it", async () => {
    const id = insertToken();
    const errored = await repository.transition(
      id,
      { _tag: "MarkError", message: "mint unreachable" },
      NOW,
    );
    expect(errored.ok).toBe(true);
    if (!errored.ok) return;
    expect(errored.value.state).toBe("error");
    expect(errored.value.error).toBe("mint unreachable");

    let persisted = await repository.getById(id);
    expect(persisted!.error).toBe("mint unreachable");

    // error -> spent (confirmed dead) clears the message.
    const spent = await repository.transition(id, { _tag: "MarkSpent" }, NOW + 1);
    expect(spent.ok).toBe(true);
    persisted = await repository.getById(id);
    expect(persisted!.state).toBe("spent");
    expect(persisted!.error).toBeNull();
  });

  it("returns typed errors for unknown and malformed ids", async () => {
    const malformed = await repository.transition("nope", { _tag: "Emit" }, NOW);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error._tag).toBe("InvalidTokenIdError");

    const unknownId = insertToken();
    store.update("cashuToken", { id: unknownId as never, isDeleted: 1 });
    const missing = await repository.transition(unknownId, { _tag: "Emit" }, NOW);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error._tag).toBe("TokenNotFoundError");
  });
});

describe("recover", () => {
  it("error -> accepted replaces token, amount, and mint with the re-accepted result", async () => {
    const id = insertToken({ amount: 100 });
    await repository.transition(id, { _tag: "MarkError", message: "validation failed" }, NOW);

    const reaccepted: ReceiveTokenResult = {
      mintUrl: `${MINT}/`,
      unit: "sat",
      amount: 99, // recovery swap may shave fees
      proofs: [],
      token: "cashuAfresh-after-recovery",
    };
    const recovered = await repository.recover(id, reaccepted, NOW + 1);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.state).toBe("accepted");
    expect(recovered.value.error).toBeNull();

    const persisted = await repository.getById(id);
    expect(persisted!.state).toBe("accepted");
    expect(persisted!.token).toBe("cashuAfresh-after-recovery");
    expect(persisted!.amount).toBe(99);
    expect(persisted!.mintUrl).toBe(MINT);
  });

  it("rejects recover from a non-error state", async () => {
    const id = insertToken();
    const result = await repository.recover(
      id,
      { mintUrl: MINT, unit: "sat", amount: 1, proofs: [], token: "cashuAx" },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      _tag: "IllegalTokenStateTransitionError",
      from: "accepted",
      transition: "Recover",
    });
  });
});

describe("reconcile", () => {
  it("applies a NUT-07 partition: spent settles, live pending returns, unknown is untouched", async () => {
    const claimedId = insertToken();
    await repository.transition(claimedId, { _tag: "Emit" }, NOW);

    const undeliveredId = insertToken();
    await repository.transition(undeliveredId, { _tag: "Emit" }, NOW);
    await repository.transition(undeliveredId, { _tag: "MarkInFlight" }, NOW);

    const unknownId = insertToken(); // accepted

    const { updated } = await repository.reconcile(
      {
        liveGroups: [{ id: undeliveredId, proofs: [] }],
        fullySpentIds: [claimedId],
        unknownStateIds: [unknownId],
      },
      NOW + 10,
    );

    const updatedIds = updated.map((record) => record.id).sort();
    expect(updatedIds).toEqual([claimedId, undeliveredId].sort());

    expect((await repository.getById(claimedId))!.state).toBe("spent");
    // pending + provably live => the value is ours again.
    expect((await repository.getById(undeliveredId))!.state).toBe("accepted");
    // unknown proves nothing.
    expect((await repository.getById(unknownId))!.state).toBe("accepted");
  });

  it("is a no-op for an empty partition and unknown ids", async () => {
    const { updated } = await repository.reconcile(
      { liveGroups: [], fullySpentIds: [], unknownStateIds: [] },
      NOW,
    );
    expect(updated).toEqual([]);
  });
});

describe("purge", () => {
  it("purges spent/deleted rows per the #33 policy, honoring the retention window", async () => {
    const spentId = insertToken();
    await repository.transition(spentId, { _tag: "MarkSpent" }, NOW);
    const deletedId = insertToken();
    await repository.transition(deletedId, { _tag: "Delete" }, NOW);
    const liveId = insertToken();

    // A retention window far in the future purges nothing.
    const tooEarly = await repository.purge(Date.now(), { minAgeMillis: 86_400_000 });
    expect(tooEarly.purgedIds).not.toContain(spentId);
    expect(tooEarly.purgedIds).not.toContain(deletedId);

    // Default policy (no window) purges both terminal rows, never live ones.
    const { purgedIds } = await repository.purge(Date.now());
    expect(purgedIds).toContain(spentId);
    expect(purgedIds).toContain(deletedId);
    expect(purgedIds).not.toContain(liveId);

    expect(await repository.getById(spentId)).toBeNull();
    expect(await repository.getById(deletedId)).toBeNull();
    expect(await repository.getById(liveId)).not.toBeNull();
  });
});

describe("list", () => {
  it("hides deleted-state rows by default, shows them on request, filters by state and mint", async () => {
    const acceptedId = insertToken({ mintUrl: OTHER_MINT, amount: 5 });
    const deletedId = insertToken({ mintUrl: OTHER_MINT, amount: 6 });
    await repository.transition(deletedId, { _tag: "Delete" }, NOW);

    const visible = await repository.list({ mintUrl: OTHER_MINT });
    expect(visible.map((record) => record.id)).toContain(acceptedId);
    expect(visible.map((record) => record.id)).not.toContain(deletedId);

    const all = await repository.list({ mintUrl: OTHER_MINT, includeDeleted: true });
    expect(all.map((record) => record.id)).toContain(deletedId);

    const deletedOnly = await repository.list({ mintUrl: OTHER_MINT, states: ["deleted"] });
    expect(deletedOnly.map((record) => record.id)).toEqual([deletedId]);
  });
});

describe("balances and spendable selection (fresh store)", () => {
  // A dedicated store so earlier fixtures cannot disturb the math.
  let balanceRepo: TokensRepository;
  let ids: Record<string, string>;

  beforeAll(async () => {
    const masterSecret = MasterSecret.make(fromHex("0f1e2d3c4b5a69788796a5b4c3d2e1f0"));
    const entries = await Promise.all(
      SYNC_DOMAINS.map(async (domain) => {
        const lane = await Effect.runPromise(deriveOwnerLane(masterSecret, domain));
        return [domain, lane.mnemonic] as const;
      }),
    );
    const result = createLinkyStore(createNodeEvoluDeps(), {
      name: "linky-tokens-balances-test",
      laneMnemonics: Object.fromEntries(entries) as unknown as LaneMnemonics,
      transports: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("createLinkyStore failed");
    balanceRepo = createTokensRepository(result.value);

    const put = (mintUrl: string, amount: number, token: string): string => {
      const inserted = balanceRepo.insert({ mintUrl, amount, state: "accepted", token });
      if (!inserted.ok) throw new Error("fixture insert failed");
      return inserted.value.id;
    };

    // Mixed-state fixture across two mints (all "sat"):
    //   MINT:  accepted 100, accepted 30, issued 50, reserved 8, error 7, spent 99
    //   OTHER: accepted 40, externalized 5, deleted 1000
    ids = {
      a100: put(MINT, 100, "cashuA100"),
      a30: put(MINT, 30, "cashuA30"),
      issued50: put(MINT, 50, "cashuA50"),
      reserved8: put(MINT, 8, "cashuA8"),
      error7: put(MINT, 7, "cashuA7"),
      spent99: put(MINT, 99, "cashuA99"),
      b40: put(OTHER_MINT, 40, "cashuB40"),
      ext5: put(OTHER_MINT, 5, "cashuB5"),
      del1000: put(OTHER_MINT, 1000, "cashuB1000"),
    };
    await balanceRepo.transition(ids.issued50!, { _tag: "Emit" }, NOW);
    await balanceRepo.transition(ids.reserved8!, { _tag: "Reserve" }, NOW);
    await balanceRepo.transition(ids.error7!, { _tag: "MarkError", message: "boom" }, NOW);
    await balanceRepo.transition(ids.spent99!, { _tag: "MarkSpent" }, NOW);
    await balanceRepo.transition(ids.ext5!, { _tag: "Externalize" }, NOW);
    await balanceRepo.transition(ids.del1000!, { _tag: "Delete" }, NOW);
  });

  it("computes per-mint and per-unit balances via core over mixed states", async () => {
    const balances = await balanceRepo.balances();

    // MINT: total = 100+30 (accepted) + 50 (issued) + 8 (reserved); error/spent excluded.
    expect(mintBalanceFor(balances, MINT, "sat")).toEqual({ total: 188, spendable: 130 });
    // OTHER: total = 40 (accepted) + 5 (externalized); deleted excluded.
    expect(mintBalanceFor(balances, OTHER_MINT, "sat")).toEqual({ total: 45, spendable: 40 });
    // Cross-mint headline.
    expect(unitBalanceFor(balances, "sat")).toEqual({ total: 233, spendable: 170 });
  });

  it("selects the whole accepted set at the mint when it covers the amount (PoC policy)", async () => {
    const selection = await balanceRepo.selectSpendable({ mintUrl: MINT, amount: 120 });
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.value.totalAmount).toBe(130);
    expect(selection.value.records.map((record) => record.id).sort()).toEqual(
      [ids.a100!, ids.a30!].sort(),
    );
    // Deterministic funding order: oldest first, id as the tie-break.
    const ordered = [...selection.value.records].sort(
      (a, b) => a.createdAtMillis - b.createdAtMillis || (a.id < b.id ? -1 : 1),
    );
    expect(selection.value.records).toEqual(ordered);
    for (const record of selection.value.records) expect(record.state).toBe("accepted");
  });

  it("fails with the available total when the accepted sum is short", async () => {
    const selection = await balanceRepo.selectSpendable({ mintUrl: MINT, amount: 131 });
    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    expect(selection.error).toEqual({
      _tag: "InsufficientSpendableFundsError",
      mintUrl: MINT,
      unit: "sat",
      requested: 131,
      available: 130,
    });
  });

  it("never selects across mints", async () => {
    // OTHER mint has 40 accepted; MINT's 130 must not leak in.
    const selection = await balanceRepo.selectSpendable({ mintUrl: OTHER_MINT, amount: 41 });
    expect(selection.ok).toBe(false);
  });
});

describe("lane routing", () => {
  it("lands every cashuToken row on the wallet lane", async () => {
    const query = store.evolu.createQuery((db) => db.selectFrom("cashuToken").selectAll());
    const rows = await store.evolu.loadQuery(query);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect((row as { ownerId?: unknown }).ownerId).toBe(store.owners.wallet.id);
    }
  });
});
