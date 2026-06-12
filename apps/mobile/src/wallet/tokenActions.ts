/**
 * Token list & detail actions (#38) — the impure half over
 * ./tokenListModel.ts: NUT-07 validation, the #33 repair transitions,
 * cleanup (check → reconcile → purge) and deterministic restore. Follows
 * the topupActions conventions: plain async functions taking the session
 * store, typed workflow errors mapped to plain outcome values (screens
 * render outcomes, never Effect errors), repository write failures on
 * app-controlled values thrown as defects.
 *
 * Repair-action mapping to the #33 transitions:
 *
 * - check    → `checkProofStates` + `TokensRepository.reconcile`
 *              (spent → MarkSpent, live pending → Return, unknown → no-op).
 * - reserve  → `Reserve` (accepted → reserved).
 * - return   → `Return` (issued | pending | reserved | externalized → accepted).
 * - re-accept→ `receiveToken` at the mint, then `TokensRepository.recover`
 *              (error → accepted with the fresh token); definitively-spent
 *              errors short-circuit to `MarkSpent` (core
 *              `tokenRecordErrorRecovery`).
 * - delete   → `Delete` (soft delete; tombstone hidden everywhere).
 */
import type { CashuProof, CashuSeed, ReceiveTokenError, TokenRecord } from "@linky/core";
import {
  TokenStateTransition,
  canTransitionTokenState,
  checkProofStates,
  dedupeProofs,
  isDefinitivelySpentErrorMessage,
  normalizeMintUrl,
  parseCashuToken,
  partitionProofGroupsByState,
  receiveToken,
  restoreFromMint,
  tokenRecordErrorRecovery,
} from "@linky/core";
import type { AppliedTokenTransition, LinkyStore } from "@linky/evolu-store";
import { createMintsRepository, createTokensRepository } from "@linky/evolu-store";
import { Effect, Either, Option } from "effect";

import { environment } from "../environment";
import { runAppEffect, runCashuEffect } from "../runtime";
import { getReadyLinkyStore, invalidateStoreData } from "../store/storeManager";
import type { TokenListGroups } from "./tokenListModel";
import { groupTokenRecords } from "./tokenListModel";

// ---------------------------------------------------------------------------
// Reads (useEffectQuery seams, the walletData pattern)
// ---------------------------------------------------------------------------

/** Token list data: grouped/sorted records from the session store. */
export const loadTokenList: Effect.Effect<TokenListGroups> = Effect.promise(async () => {
  const store = await getReadyLinkyStore();
  const records = await createTokensRepository(store).list();
  return groupTokenRecords(records);
});

/** One record for the detail screen (null = purged/unknown id). */
export const loadTokenDetail = (id: string): Effect.Effect<TokenRecord | null> =>
  Effect.promise(async () => {
    const store = await getReadyLinkyStore();
    return createTokensRepository(store).getById(id);
  });

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Decodes the stored token text; `null` for corrupt/PoC-era rows. */
const parseStoredToken = (record: TokenRecord) => {
  const parsed = Effect.runSync(Effect.either(parseCashuToken(record.token)));
  return Either.isRight(parsed) ? parsed.right : null;
};

/** Batched NUT-07 ask, failures mapped to `null` (mint unreachable). */
const checkProofStatesOrNull = (args: {
  readonly mintUrl: string;
  readonly unit: string;
  readonly proofs: ReadonlyArray<CashuProof>;
}) =>
  runAppEffect(
    checkProofStates(args).pipe(
      Effect.map(Option.some),
      Effect.catchAll(() => Effect.succeed(Option.none())),
    ),
  ).then(Option.getOrNull);

// ---------------------------------------------------------------------------
// Single-token validation (`cashu.validate-token`)
// ---------------------------------------------------------------------------

export type CheckTokenOutcome = "ok" | "spent" | "unknown" | "invalid" | "failed";

/**
 * Validates one token's proof state with its mint and reconciles the row
 * (#33): SPENT → MarkSpent, live pending → back to accepted, PENDING/
 * unknown → untouched. Unreadable token text marks the row `error` (the
 * message matches core's definitively-spent patterns, so cleanup/re-accept
 * resolve it).
 */
export const checkToken = async (store: LinkyStore, id: string): Promise<CheckTokenOutcome> => {
  const tokens = createTokensRepository(store);
  const record = await tokens.getById(id);
  if (record === null) return "failed";

  const parsed = parseStoredToken(record);
  if (parsed === null) {
    if (canTransitionTokenState(record.state, "MarkError")) {
      await tokens.transition(id, TokenStateTransition.MarkError({ message: "invalid token" }), Date.now());
      invalidateStoreData();
    }
    return "invalid";
  }

  const proofs = dedupeProofs(parsed.proofs);
  const states = await checkProofStatesOrNull({
    mintUrl: record.mintUrl,
    unit: record.unit,
    proofs,
  });
  if (states === null) return "failed";

  const partition = partitionProofGroupsByState([{ id: record.id, proofs }], states);
  const { updated } = await tokens.reconcile(partition, Date.now());
  if (updated.length > 0) invalidateStoreData();

  if (partition.fullySpentIds.includes(record.id)) return "spent";
  if (partition.liveGroups.some((group) => group.id === record.id)) return "ok";
  return "unknown";
};

// ---------------------------------------------------------------------------
// Manual repair transitions (`cashu.reserve-token` / `cashu.return-token`)
// ---------------------------------------------------------------------------

const applyTransition = async (
  store: LinkyStore,
  id: string,
  transition: AppliedTokenTransition,
): Promise<boolean> => {
  const result = await createTokensRepository(store).transition(id, transition, Date.now());
  if (result.ok) invalidateStoreData();
  return result.ok;
};

/** `Reserve`: mark an accepted token unavailable. */
export const reserveToken = (store: LinkyStore, id: string): Promise<boolean> =>
  applyTransition(store, id, TokenStateTransition.Reserve());

/** `Return`: bring an issued/pending/reserved/externalized token back. */
export const returnTokenToWallet = (store: LinkyStore, id: string): Promise<boolean> =>
  applyTransition(store, id, TokenStateTransition.Return());

/** `Delete`: soft delete (the detail screen confirms first). */
export const deleteToken = (store: LinkyStore, id: string): Promise<boolean> =>
  applyTransition(store, id, TokenStateTransition.Delete());

// ---------------------------------------------------------------------------
// Re-accept (error recovery)
// ---------------------------------------------------------------------------

export type ReacceptOutcome =
  | { readonly kind: "recovered"; readonly amount: number }
  /** The error message / mint response proves the proofs are dead. */
  | { readonly kind: "spent" }
  | { readonly kind: "failed"; readonly errorTag: string };

/** Mint-failure detail text used for the definitively-spent test. */
const failureDetail = (error: ReceiveTokenError): string => {
  switch (error._tag) {
    case "MintProtocolError":
      return error.detail;
    case "WalletOperationError":
      return error.reason;
    default:
      return "";
  }
};

/**
 * Error-row recovery (`tokenRecordErrorRecovery`): definitively-spent
 * messages go straight to `MarkSpent`; otherwise re-accept the stored token
 * at the mint (#32 `receiveToken` under the counter lock) and `recover()`
 * the row with the fresh result. A definitively-spent mint response during
 * the re-accept also resolves to `MarkSpent`.
 */
export const reacceptToken = async (
  store: LinkyStore,
  seed: CashuSeed,
  id: string,
): Promise<ReacceptOutcome> => {
  const tokens = createTokensRepository(store);
  const record = await tokens.getById(id);
  if (record === null) return { kind: "failed", errorTag: "TokenNotFoundError" };

  const recovery = tokenRecordErrorRecovery(record);
  if (Option.isNone(recovery)) {
    return { kind: "failed", errorTag: "IllegalTokenStateTransitionError" };
  }

  const markSpent = async (): Promise<ReacceptOutcome> => {
    await tokens.transition(id, TokenStateTransition.MarkSpent(), Date.now());
    invalidateStoreData();
    return { kind: "spent" };
  };

  if (recovery.value === "mark-spent") return markSpent();

  const received = await runCashuEffect(
    store,
    receiveToken({ seed, token: record.token }).pipe(
      Effect.map((result) => ({ ok: true, result }) as const),
      Effect.catchAll((error) => Effect.succeed({ ok: false, error } as const)),
    ),
  );

  if (!received.ok) {
    if (isDefinitivelySpentErrorMessage(failureDetail(received.error))) return markSpent();
    return { kind: "failed", errorTag: received.error._tag };
  }

  const recovered = await tokens.recover(id, received.result, Date.now());
  if (!recovered.ok) return { kind: "failed", errorTag: recovered.error._tag };
  invalidateStoreData();
  return { kind: "recovered", amount: received.result.amount };
};

// ---------------------------------------------------------------------------
// Issued-entry claim detection (#44 / #43)
// ---------------------------------------------------------------------------

export interface IssuedCheckOutcome {
  /** Issued rows whose proofs were checked with their mint. */
  readonly checked: number;
  /** Issued rows newly confirmed claimed (→ `spent`). */
  readonly claimed: number;
}

/**
 * Claim detection for outgoing chat tokens: NUT-07-checks every `issued`
 * row and reconciles (#33) — a token the recipient accepted flips to
 * `spent`, which is what lets the #43 history keep showing the merged
 * emit-then-send item as settled value (the issued amount leaves the
 * total balance). Unreachable mints leave their rows untouched.
 */
export const checkIssuedTokens = async (store: LinkyStore): Promise<IssuedCheckOutcome> => {
  const tokens = createTokensRepository(store);
  const issued = await tokens.list({ states: ["issued"] });
  if (issued.length === 0) return { checked: 0, claimed: 0 };

  const groupsByMint = new Map<string, { mintUrl: string; unit: string; groups: ProofGroup[] }>();
  for (const record of issued) {
    const parsed = parseStoredToken(record);
    if (parsed === null) continue;
    const key = `${record.mintUrl}|${record.unit}`;
    const entry =
      groupsByMint.get(key) ?? { mintUrl: record.mintUrl, unit: record.unit, groups: [] };
    entry.groups.push({ id: record.id, proofs: dedupeProofs(parsed.proofs) });
    groupsByMint.set(key, entry);
  }

  let checked = 0;
  let claimed = 0;
  for (const { mintUrl, unit, groups } of groupsByMint.values()) {
    const states = await checkProofStatesOrNull({
      mintUrl,
      unit,
      proofs: groups.flatMap((group) => group.proofs),
    });
    if (states === null) continue;
    checked += groups.length;
    const partition = partitionProofGroupsByState(groups, states);
    const { updated } = await tokens.reconcile(partition, Date.now());
    claimed += updated.filter((record) => record.state === "spent").length;
  }

  if (claimed > 0) invalidateStoreData();
  return { checked, claimed };
};

/** Min interval between opportunistic issued-row checks (screen mounts). */
const ISSUED_CHECK_THROTTLE_MS = 30_000;
let lastIssuedCheckAtMs = 0;

/**
 * Throttled, fire-and-forget claim detection — called from screen mounts
 * (wallet tab, chat thread) so a claimed token is noticed without polling.
 */
export const maybeCheckIssuedTokens = (store: LinkyStore): void => {
  const now = Date.now();
  if (now - lastIssuedCheckAtMs < ISSUED_CHECK_THROTTLE_MS) return;
  lastIssuedCheckAtMs = now;
  void checkIssuedTokens(store).catch((error: unknown) => {
    if (__DEV__) console.warn("[wallet] issued-token check died:", error);
  });
};

// ---------------------------------------------------------------------------
// Cleanup spent (`cashu.cleanup-spent`)
// ---------------------------------------------------------------------------

export interface CleanupOutcome {
  /** Rows whose proofs were checked with their mint. */
  readonly checked: number;
  /** Rows newly marked spent by the reconcile. */
  readonly spent: number;
  /** Rows physically purged (spent/deleted past the policy window). */
  readonly purged: number;
  /** Mint groups that could not be checked (unreachable mint). */
  readonly failedMints: number;
}

interface ProofGroup {
  readonly id: string;
  readonly proofs: CashuProof[];
}

/**
 * Bulk cleanup per the #33 policy: batched `checkProofStates` per
 * (mint, unit) over every live row with decodable proofs → reconcile →
 * purge `spent`/`deleted` rows. Unreachable mints are skipped (their rows
 * stay untouched — unknown is never treated as spent); the purge still
 * runs so already-known-dead rows disappear.
 */
export const cleanupSpentTokens = async (store: LinkyStore): Promise<CleanupOutcome> => {
  const tokens = createTokensRepository(store);
  const records = await tokens.list();

  const groupsByMint = new Map<string, { mintUrl: string; unit: string; groups: ProofGroup[] }>();
  for (const record of records) {
    if (record.state === "spent" || record.state === "deleted") continue;
    const parsed = parseStoredToken(record);
    if (parsed === null) continue; // unreadable rows are the single-check path's job
    const key = `${record.mintUrl}|${record.unit}`;
    const entry = groupsByMint.get(key) ?? { mintUrl: record.mintUrl, unit: record.unit, groups: [] };
    entry.groups.push({ id: record.id, proofs: dedupeProofs(parsed.proofs) });
    groupsByMint.set(key, entry);
  }

  let checked = 0;
  let spent = 0;
  let failedMints = 0;

  for (const { mintUrl, unit, groups } of groupsByMint.values()) {
    const states = await checkProofStatesOrNull({
      mintUrl,
      unit,
      proofs: groups.flatMap((group) => group.proofs),
    });
    if (states === null) {
      failedMints += 1;
      continue;
    }
    checked += groups.length;
    const partition = partitionProofGroupsByState(groups, states);
    const { updated } = await tokens.reconcile(partition, Date.now());
    spent += updated.filter((record) => record.state === "spent").length;
  }

  const { purgedIds } = await tokens.purge(Date.now());
  invalidateStoreData();
  return { checked, spent, purged: purgedIds.length, failedMints };
};

// ---------------------------------------------------------------------------
// Restore (`cashu.restore-tokens`)
// ---------------------------------------------------------------------------

export interface RestoreOutcome {
  readonly restoredAmount: number;
  readonly restoredTokens: number;
  readonly restoredProofs: number;
  /** Mints whose scan failed entirely (unreachable). */
  readonly failedMints: number;
}

/**
 * Deterministic restore (#32 `restoreFromMint`, NUT-09 + gap detection)
 * across every mint the wallet knows: known mint rows, mints of stored
 * tokens, the synced main-mint preference and the env default. Secrets of
 * live stored rows are excluded (`knownSecrets`) so held value is never
 * re-reported; recovered tokens are inserted as `accepted` rows (the
 * engine already encodes them with the `"restored"` memo and the counters
 * ratchet inside the engine).
 */
export const restoreWalletTokens = async (
  store: LinkyStore,
  seed: CashuSeed,
): Promise<RestoreOutcome> => {
  const tokens = createTokensRepository(store);
  const mints = createMintsRepository(store);
  const records = await tokens.list();

  const knownSecrets = new Set<string>();
  for (const record of records) {
    if (record.state === "spent") continue; // spent secrets are dead; the mint filter drops them anyway
    const parsed = parseStoredToken(record);
    if (parsed === null) continue;
    for (const proof of parsed.proofs) {
      const secret = String(proof.secret ?? "").trim();
      if (secret !== "") knownSecrets.add(secret);
    }
  }

  const mintUrls = new Set<string>([normalizeMintUrl(environment.cashuMintUrl)]);
  const mainMint = await mints.getMainMintUrl();
  if (mainMint !== null) mintUrls.add(normalizeMintUrl(mainMint));
  for (const mint of await mints.list()) mintUrls.add(mint.url);
  for (const record of records) mintUrls.add(record.mintUrl);

  let restoredAmount = 0;
  let restoredTokens = 0;
  let restoredProofs = 0;
  let failedMints = 0;

  for (const mintUrl of mintUrls) {
    if (mintUrl === "") continue;
    const result = await runCashuEffect(
      store,
      restoreFromMint({ seed, mintUrl, knownSecrets: [...knownSecrets] }).pipe(
        Effect.map((value) => ({ ok: true, value }) as const),
        Effect.catchAll(() => Effect.succeed({ ok: false } as const)),
      ),
    );
    if (!result.ok) {
      failedMints += 1;
      continue;
    }
    for (const restored of result.value.restoredTokens) {
      const inserted = tokens.insert({
        mintUrl: restored.mintUrl,
        unit: restored.unit,
        amount: restored.amount,
        state: "accepted",
        token: restored.token,
      });
      if (!inserted.ok) throw new Error(`store restored token failed: ${inserted.error._tag}`);
      restoredAmount += restored.amount;
      restoredTokens += 1;
      restoredProofs += restored.proofCount;
    }
  }

  invalidateStoreData();
  return { restoredAmount, restoredTokens, restoredProofs, failedMints };
};
