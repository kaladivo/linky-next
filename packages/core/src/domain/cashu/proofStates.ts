/**
 * Proof-state validation against the mint (`cashu.validate-token`,
 * `cashu.cleanup-spent` in the feature map): NUT-07 checkstate, plus the
 * pure helpers the PoC uses to dedupe proofs and partition token rows by
 * their on-mint state (`utils/cashuProofs.ts`).
 */
import type { ProofState } from "@cashu/cashu-ts";
import { Effect } from "effect";

import type { HttpClient } from "../../ports/index.js";
import type { CashuMintFailure, KeysetUnavailableError } from "./errors.js";
import { loadWallet, runMintCall } from "./internal/wallet.js";
import type { CashuProof } from "./tokenCodec.js";

/** NUT-07 proof state as the mint reports it. */
export type CashuProofState = ProofState;

const proofKey = (proof: CashuProof): string =>
  [
    String(proof.id ?? "").trim(),
    String(proof.secret ?? "").trim(),
    String(proof.C ?? "").trim(),
    String(Number(proof.amount ?? 0) || 0),
  ].join("|");

/** Removes duplicate proofs (same id|secret|C|amount). */
export const dedupeProofs = (proofs: ReadonlyArray<CashuProof>): CashuProof[] => {
  const seen = new Set<string>();
  const unique: CashuProof[] = [];
  for (const proof of proofs) {
    const key = proofKey(proof);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(proof);
  }
  return unique;
};

/**
 * Keeps proofs whose reported state is UNSPENT. If the states array does not
 * align with the proofs (truncated mint response), all proofs are kept — the
 * caller must not treat unknown as spent.
 */
export const filterUnspentProofs = (
  proofs: ReadonlyArray<CashuProof>,
  states: ReadonlyArray<CashuProofState>,
): CashuProof[] => {
  if (proofs.length === 0) return [];
  if (states.length !== proofs.length) return [...proofs];
  return proofs.filter((_, index) => String(states[index]?.state ?? "").trim() === "UNSPENT");
};

export interface ProofGroup<TId> {
  readonly id: TId;
  readonly proofs: ReadonlyArray<CashuProof>;
}

export interface ProofGroupPartition<TId> {
  /** Groups with at least one UNSPENT proof, narrowed to just those proofs. */
  readonly liveGroups: ReadonlyArray<{ readonly id: TId; readonly proofs: CashuProof[] }>;
  /** Groups whose every proof came back SPENT — definitively spent. */
  readonly fullySpentIds: ReadonlyArray<TId>;
  /** Groups with PENDING/unknown/missing states — no certainty either way. */
  readonly unknownStateIds: ReadonlyArray<TId>;
}

/**
 * Partitions token-row proof groups using one batched checkstate response
 * (states aligned to the concatenated input order). Gives per-row
 * spent/unspent fidelity so only truly spent rows get marked spent.
 */
export const partitionProofGroupsByState = <TId>(
  groups: ReadonlyArray<ProofGroup<TId>>,
  states: ReadonlyArray<CashuProofState>,
): ProofGroupPartition<TId> => {
  const liveGroups: Array<{ id: TId; proofs: CashuProof[] }> = [];
  const fullySpentIds: TId[] = [];
  const unknownStateIds: TId[] = [];

  let cursor = 0;
  for (const group of groups) {
    const groupStates = states.slice(cursor, cursor + group.proofs.length);
    cursor += group.proofs.length;

    if (groupStates.length !== group.proofs.length) {
      unknownStateIds.push(group.id);
      continue;
    }

    const unspent: CashuProof[] = [];
    let sawUnknown = false;
    let sawSpent = false;

    for (let index = 0; index < group.proofs.length; index += 1) {
      const state = String(groupStates[index]?.state ?? "")
        .trim()
        .toUpperCase();
      const proof = group.proofs[index];
      if (proof === undefined) continue;
      if (state === "UNSPENT") unspent.push(proof);
      else if (state === "SPENT") sawSpent = true;
      else sawUnknown = true;
    }

    if (unspent.length > 0) liveGroups.push({ id: group.id, proofs: unspent });
    else if (sawSpent && !sawUnknown) fullySpentIds.push(group.id);
    else unknownStateIds.push(group.id);
  }

  return { liveGroups, fullySpentIds, unknownStateIds };
};

export interface CheckProofStatesArgs {
  readonly mintUrl: string;
  readonly unit?: string | undefined;
  readonly proofs: ReadonlyArray<CashuProof>;
}

/**
 * Asks the mint for the NUT-07 state of each proof (spent/pending/unspent),
 * aligned to the input order. No seed or counters involved.
 */
export const checkProofStates = (
  args: CheckProofStatesArgs,
): Effect.Effect<
  ReadonlyArray<CashuProofState>,
  CashuMintFailure | KeysetUnavailableError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    if (args.proofs.length === 0) return [];
    const handle = yield* loadWallet({ mintUrl: args.mintUrl, unit: args.unit });
    return yield* runMintCall(handle.mintUrl, () =>
      handle.wallet.checkProofsStates([...args.proofs]),
    );
  });
