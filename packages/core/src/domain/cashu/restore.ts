/**
 * Deterministic restore — `cashu.restore-tokens` in the feature map:
 * recover wallet value from a mint by scanning the deterministic counter
 * space (NUT-09 batch restore with gap detection). Ported from the PoC
 * (`useRestoreMissingTokens.ts`), per keyset of the wallet's unit:
 *
 * - scan window: start at `max(0, highWater - rescanWindow)` where
 *   `highWater = max(restoreCursor, counter)` — deleted-token value below
 *   the cursor stays reachable;
 * - `batchRestore(300, 100, start, keysetId)`: 100 derivations per
 *   /v1/restore request, stop after a 300-slot signature gap;
 * - cursors and counters advance to `lastCounterWithSignature + 1` (the
 *   counter only ever ratchets forward — `ensureCounterAtLeast`);
 * - restored proofs are filtered against `knownSecrets` (already-stored
 *   value) and checked UNSPENT with the mint;
 * - if the windowed scan finds nothing and the window didn't start at 0, a
 *   one-time deep scan from 0 runs (older deleted tokens);
 * - results are chunked into tokens of ≤200 proofs, memo `"restored"`.
 *
 * Each keyset scan holds the per-keyset counter lock so concurrent wallet
 * operations cannot interleave with the cursor/counter ratchet.
 */
import type { Proof } from "@cashu/cashu-ts";
import { Effect } from "effect";

import type { CounterStoreError, KeysetRef } from "../../ports/CounterStore.js";
import { CounterStore } from "../../ports/CounterStore.js";
import type { HttpClient } from "../../ports/index.js";
import type { CashuSeed } from "../identity/DerivedIdentities.js";
import type {
  CashuMintFailure,
  InvalidCashuTokenError,
  KeysetUnavailableError,
} from "./errors.js";
import { loadWallet, runMintCall, type WalletHandle } from "./internal/wallet.js";
import { filterUnspentProofs } from "./proofStates.js";
import type { CashuProof } from "./tokenCodec.js";
import { encodeCashuToken, sumProofAmounts } from "./tokenCodec.js";

/** PoC defaults — part of the restore semantics. */
export const RESTORE_RESCAN_WINDOW = 4000;
export const RESTORE_GAP_LIMIT = 300;
export const RESTORE_BATCH_SIZE = 100;
export const RESTORE_TOKEN_CHUNK_SIZE = 200;

export interface RestoreFromMintArgs {
  readonly seed: CashuSeed;
  readonly mintUrl: string;
  readonly unit?: string | undefined;
  /** Proof secrets the caller already has stored — never re-reported. */
  readonly knownSecrets?: ReadonlyArray<string> | ReadonlySet<string> | undefined;
  /** Override the rescan window (tests only). */
  readonly rescanWindow?: number | undefined;
}

export interface RestoredKeysetScan {
  readonly keysetId: string;
  /** False when the mint failed mid-scan for this keyset (skipped, PoC). */
  readonly scanned: boolean;
  readonly restoredProofCount: number;
  readonly restoredAmount: number;
  /** Where the next incremental scan will start. */
  readonly nextCursor: number;
}

export interface RestoredToken {
  readonly mintUrl: string;
  readonly unit: string;
  readonly keysetId: string;
  readonly amount: number;
  readonly proofCount: number;
  readonly token: string;
}

export interface RestoreFromMintResult {
  readonly mintUrl: string;
  readonly unit: string;
  readonly scans: ReadonlyArray<RestoredKeysetScan>;
  readonly restoredTokens: ReadonlyArray<RestoredToken>;
  readonly totalRestoredAmount: number;
  readonly totalRestoredProofs: number;
}

export type RestoreFromMintError =
  | KeysetUnavailableError
  | InvalidCashuTokenError
  | CashuMintFailure
  | CounterStoreError;

interface KeysetScanOutcome {
  readonly scan: RestoredKeysetScan;
  readonly proofs: ReadonlyArray<CashuProof>;
}

const scanKeyset = (args: {
  readonly handle: WalletHandle;
  readonly keysetId: string;
  readonly knownSecrets: Set<string>;
  readonly rescanWindow: number;
}): Effect.Effect<KeysetScanOutcome, CounterStoreError, CounterStore> =>
  Effect.gen(function* () {
    const { handle, keysetId, knownSecrets, rescanWindow } = args;
    const counters = yield* CounterStore;
    const ref: KeysetRef = { mintUrl: handle.mintUrl, unit: handle.unit, keysetId };

    const failedScan: KeysetScanOutcome = {
      scan: {
        keysetId,
        scanned: false,
        restoredProofCount: 0,
        restoredAmount: 0,
        nextCursor: 0,
      },
      proofs: [],
    };

    const savedCursor = yield* counters.getRestoreCursor(ref);
    const counter = yield* counters.getCounter(ref);
    const highWater = Math.max(savedCursor, counter);
    const start = Math.max(0, highWater - rescanWindow);

    const batchRestore = (counterStart: number) =>
      runMintCall(handle.mintUrl, () =>
        handle.wallet.batchRestore(RESTORE_GAP_LIMIT, RESTORE_BATCH_SIZE, counterStart, keysetId),
      );

    const ratchet = (lastSigned: number | undefined) =>
      Effect.gen(function* () {
        if (typeof lastSigned !== "number" || !Number.isFinite(lastSigned)) return;
        yield* counters.setRestoreCursor(ref, lastSigned + 1);
        yield* counters.ensureCounterAtLeast(ref, lastSigned + 1);
      });

    const filterFresh = (proofs: ReadonlyArray<Proof>): Proof[] =>
      proofs.filter((proof) => {
        const secret = String(proof.secret ?? "").trim();
        return secret !== "" && !knownSecrets.has(secret);
      });

    const filterSpendable = (proofs: Proof[]): Effect.Effect<Proof[]> =>
      proofs.length === 0
        ? Effect.succeed(proofs)
        : runMintCall(handle.mintUrl, () => handle.wallet.checkProofsStates(proofs)).pipe(
            Effect.map((states) => filterUnspentProofs(proofs, states)),
            Effect.orElseSucceed(() => proofs),
          );

    // Windowed scan first.
    const windowed = yield* Effect.either(batchRestore(start));
    if (windowed._tag === "Left") return failedScan; // unreachable keyset — skip (PoC)
    let restored = windowed.right;
    yield* ratchet(restored.lastCounterWithSignature);

    let spendable = yield* filterSpendable(filterFresh(restored.proofs));

    // Deep scan from 0 when the window missed everything (deleted tokens
    // below the window).
    if (spendable.length === 0 && start > 0) {
      const deep = yield* Effect.either(batchRestore(0));
      if (deep._tag === "Right") {
        const last0 = restored.lastCounterWithSignature;
        const last1 = deep.right.lastCounterWithSignature;
        const maxLast = Math.max(
          typeof last0 === "number" && Number.isFinite(last0) ? last0 : -1,
          typeof last1 === "number" && Number.isFinite(last1) ? last1 : -1,
        );
        if (maxLast >= 0) yield* ratchet(maxLast);
        restored = deep.right;
        spendable = yield* filterSpendable(filterFresh(restored.proofs));
      }
    }

    for (const proof of spendable) {
      const secret = String(proof.secret ?? "").trim();
      if (secret !== "") knownSecrets.add(secret);
    }

    const nextCursor = yield* counters.getRestoreCursor(ref);
    return {
      scan: {
        keysetId,
        scanned: true,
        restoredProofCount: spendable.length,
        restoredAmount: sumProofAmounts(spendable),
        nextCursor,
      },
      proofs: spendable,
    };
  });

export const restoreFromMint = (
  args: RestoreFromMintArgs,
): Effect.Effect<
  RestoreFromMintResult,
  RestoreFromMintError,
  HttpClient.HttpClient | CounterStore
> =>
  Effect.gen(function* () {
    const counters = yield* CounterStore;
    const handle = yield* loadWallet({ mintUrl: args.mintUrl, unit: args.unit, seed: args.seed });
    const rescanWindow =
      args.rescanWindow !== undefined && Number.isFinite(args.rescanWindow)
        ? Math.max(0, Math.trunc(args.rescanWindow))
        : RESTORE_RESCAN_WINDOW;

    const knownSecrets = new Set<string>(args.knownSecrets ?? []);

    // Keysets of the wallet's unit (cashu-ts filters by unit).
    const keysets = yield* runMintCall(handle.mintUrl, () => handle.wallet.getKeySets());

    const scans: RestoredKeysetScan[] = [];
    const restoredTokens: RestoredToken[] = [];
    let totalProofs = 0;
    let totalAmount = 0;

    for (const keyset of keysets) {
      const keysetId = String(keyset.id ?? "").trim();
      if (keysetId === "") continue;
      const keysetUnit = String(keyset.unit ?? "").trim();
      if (keysetUnit !== "" && keysetUnit !== handle.unit) continue;

      const ref: KeysetRef = { mintUrl: handle.mintUrl, unit: handle.unit, keysetId };
      const outcome = yield* counters.withCounterLock(
        ref,
        scanKeyset({ handle, keysetId, knownSecrets, rescanWindow }),
      );
      scans.push(outcome.scan);

      // Chunk into reasonably sized tokens (PoC: 200 proofs, memo "restored").
      for (let i = 0; i < outcome.proofs.length; i += RESTORE_TOKEN_CHUNK_SIZE) {
        const chunk = outcome.proofs.slice(i, i + RESTORE_TOKEN_CHUNK_SIZE);
        const amount = sumProofAmounts(chunk);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const token = yield* encodeCashuToken({
          mintUrl: handle.mintUrl,
          proofs: chunk,
          unit: handle.unit,
          memo: "restored",
        });
        restoredTokens.push({
          mintUrl: handle.mintUrl,
          unit: handle.unit,
          keysetId,
          amount,
          proofCount: chunk.length,
          token,
        });
        totalProofs += chunk.length;
        totalAmount += amount;
      }
    }

    return {
      mintUrl: handle.mintUrl,
      unit: handle.unit,
      scans,
      restoredTokens,
      totalRestoredAmount: totalAmount,
      totalRestoredProofs: totalProofs,
    };
  });
