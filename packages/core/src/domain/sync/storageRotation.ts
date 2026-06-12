/**
 * Storage rotation — the convergent decision layer of `sync.storage-rotation`
 * (issue #54).
 *
 * ## The model
 *
 * Each rotating sync domain (`contacts`, `wallet`, `messages`,
 * `transactions`) writes to one Evolu owner lane at a time — the lane at its
 * current ROTATION INDEX (`deriveOwnerLane(domain, index)`). Rotation moves
 * the write lane to index + 1: a fresh, deterministically derived sync
 * storage identity. Every lane up to the current index stays registered for
 * sync, so all older generations remain readable forever — rotation never
 * deletes or migrates a single row.
 *
 * ## Convergence (how devices agree)
 *
 * Every rotation is recorded as one APPEND-ONLY entry in the synced `meta`
 * lane (the `metaEntry` table, which every device always syncs):
 *
 *     key   = "rotation.<domain>.<index>"
 *     value = JSON {"v":1,"rotatedAtSec":<unix seconds>}
 *
 * with a row id derived deterministically from the key. Properties:
 *
 * - The effective index of a domain is the MAXIMUM index present
 *   ({@link resolveRotationPlan}) — a join-semilattice merge, so any set
 *   union of entries (i.e. any sync order) converges to the same plan.
 *   This deliberately diverges from the PoC, which stored ONE
 *   last-writer-wins snapshot per scope plus per-device baselines and
 *   documented cascading re-rotation bugs from exactly that.
 * - Two devices that rotate the same domain concurrently both target
 *   index + 1 and produce the SAME entry (same deterministic row id, same
 *   key), which the CRDT merges into one row: concurrent rotation is one
 *   rotation, never two.
 * - Entries are never interpreted destructively: an unknown/garbled value
 *   still counts (the index comes from the key), a gap below the maximum is
 *   filled (every lane 0..max is kept readable), and indices above
 *   {@link MAX_LANE_INDEX} are ignored by the same deterministic rule on
 *   every device (corruption guard, not a merge hazard).
 *
 * ## Trigger
 *
 * Like the PoC, automatic rotation is size-based: a domain rotates when the
 * row count in its CURRENT write lane reaches the domain's threshold
 * ({@link ROTATION_WRITE_THRESHOLDS}, PoC values), subject to a cooldown
 * since the last rotation ({@link ROTATION_COOLDOWN_SEC}). Counting rows in
 * the write lane (instead of the PoC's history-delta-since-baseline
 * machinery) makes the trigger self-resetting: a fresh lane starts near
 * zero. Manual rotation (dev-only debug surface) bypasses the trigger.
 *
 * The storage side (lane registration, write routing, counting) lives in
 * `@linky/evolu-store`; this module is the pure, deterministic decision
 * logic shared by every device.
 */
import { ROTATING_SYNC_DOMAINS, OwnerLaneIndex } from "../identity/DerivedIdentities.js";

/** A sync domain whose owner lane rotates (`meta`/`identity` never do). */
export type RotatingSyncDomain = (typeof ROTATING_SYNC_DOMAINS)[number];

/** Type guard for {@link RotatingSyncDomain}. */
export const isRotatingSyncDomain = (value: string): value is RotatingSyncDomain =>
  (ROTATING_SYNC_DOMAINS as readonly string[]).includes(value);

/**
 * Hard upper bound on accepted rotation indices. Entries above it are
 * ignored deterministically on every device — a guard against a corrupted
 * or absurd entry forcing clients to derive and register thousands of
 * lanes. At the size-based cadence this allows decades of rotations.
 */
export const MAX_LANE_INDEX = 512;

/**
 * Write-count thresholds that trigger an automatic rotation, per domain.
 * PoC values (`utils/constants.ts`): contacts 220, cashu 170, messages 160,
 * transactions 220.
 */
export const ROTATION_WRITE_THRESHOLDS: Readonly<Record<RotatingSyncDomain, number>> = {
  contacts: 220,
  wallet: 170,
  messages: 160,
  transactions: 220,
};

/** Minimum seconds between automatic rotations of one domain (PoC: 60s). */
export const ROTATION_COOLDOWN_SEC = 60;

const ROTATION_META_KEY_PREFIX = "rotation.";
const ROTATION_META_KEY_REGEX = /^rotation\.([a-z]+)\.(0|[1-9][0-9]*)$/;

/** The `metaEntry.key` recording the rotation of `domain` to `index`. */
export const rotationMetaKey = (domain: RotatingSyncDomain, index: number): string =>
  `${ROTATION_META_KEY_PREFIX}${domain}.${String(index)}`;

/** One parsed rotation entry: which domain rotated to which lane index. */
export interface RotationMetaEntry {
  readonly domain: RotatingSyncDomain;
  readonly index: number;
}

/**
 * Parses a `metaEntry.key` as a rotation entry. Returns `null` for foreign
 * keys, non-rotating domains, and indices above {@link MAX_LANE_INDEX} —
 * the deterministic ignore rule every device applies identically.
 */
export const parseRotationMetaKey = (key: string): RotationMetaEntry | null => {
  const match = ROTATION_META_KEY_REGEX.exec(key);
  if (match === null) return null;
  const [, domain, rawIndex] = match;
  if (domain === undefined || rawIndex === undefined) return null;
  if (!isRotatingSyncDomain(domain)) return null;
  const index = Number(rawIndex);
  if (index > MAX_LANE_INDEX) return null;
  return { domain, index };
};

/** Encodes the rotation entry value (versioned JSON). */
export const encodeRotationMetaValue = (input: { readonly rotatedAtSec: number }): string =>
  JSON.stringify({ v: 1, rotatedAtSec: Math.max(1, Math.trunc(input.rotatedAtSec)) });

/**
 * Decodes a rotation entry value. Tolerant by design: the value only carries
 * the advisory `rotatedAtSec` (cooldown/inspection); a garbled value decodes
 * to `null` and the entry still counts via its key.
 */
export const decodeRotationMetaValue = (value: unknown): { rotatedAtSec: number | null } => {
  if (typeof value !== "string") return { rotatedAtSec: null };
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return { rotatedAtSec: null };
    const raw = (parsed as Record<string, unknown>).rotatedAtSec;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      return { rotatedAtSec: null };
    }
    return { rotatedAtSec: Math.trunc(raw) };
  } catch {
    return { rotatedAtSec: null };
  }
};

/** The resolved lane plan of one rotating domain. */
export interface RotationLanePlan {
  /** Current write-lane index (max accepted entry; 0 when none). */
  readonly index: OwnerLaneIndex;
  /** `rotatedAtSec` of the entry at `index`, when present and decodable. */
  readonly rotatedAtSec: number | null;
}

/** The resolved lane plan across all rotating domains. */
export type RotationPlan = Readonly<Record<RotatingSyncDomain, RotationLanePlan>>;

const ZERO_PLAN: RotationLanePlan = { index: OwnerLaneIndex.make(0), rotatedAtSec: null };

/**
 * Resolves the convergent rotation plan from the raw rotation entries of the
 * meta lane. Pure max-merge: the result depends only on the SET of entries,
 * never on their order — two devices holding the same entries always agree,
 * and syncing can only move indices forward.
 */
export const resolveRotationPlan = (
  entries: ReadonlyArray<{ readonly key: string; readonly value: unknown }>,
): RotationPlan => {
  const plan: Record<RotatingSyncDomain, RotationLanePlan> = {
    contacts: ZERO_PLAN,
    wallet: ZERO_PLAN,
    messages: ZERO_PLAN,
    transactions: ZERO_PLAN,
  };
  for (const entry of entries) {
    const parsed = parseRotationMetaKey(entry.key);
    if (parsed === null) continue;
    const current = plan[parsed.domain];
    if (parsed.index < current.index) continue;
    const { rotatedAtSec } = decodeRotationMetaValue(entry.value);
    plan[parsed.domain] = {
      index: OwnerLaneIndex.make(parsed.index),
      // Same index seen twice (cannot happen via the deterministic row id,
      // but stay order-independent anyway): keep the larger timestamp.
      rotatedAtSec:
        parsed.index === current.index && current.rotatedAtSec !== null
          ? Math.max(current.rotatedAtSec, rotatedAtSec ?? 0)
          : rotatedAtSec,
    };
  }
  return plan;
};

/** Inputs of the automatic-rotation decision for one domain. */
export interface AutoRotateInput {
  /** Rows currently stored in the domain's WRITE lane (all tables). */
  readonly writeLaneRowCount: number;
  /** Trigger threshold ({@link ROTATION_WRITE_THRESHOLDS}). */
  readonly threshold: number;
  /** Current unix seconds. */
  readonly nowSec: number;
  /** When the current write lane was rotated in; `null` for lane 0 / unknown. */
  readonly rotatedAtSec: number | null;
  /** Cooldown ({@link ROTATION_COOLDOWN_SEC}). */
  readonly cooldownSec: number;
}

/**
 * Whether a domain should rotate automatically: the write lane reached the
 * threshold and the cooldown since the last rotation has elapsed. The
 * decision is a local heuristic — devices need not agree on WHEN to rotate;
 * they converge on the RESULT via {@link resolveRotationPlan}.
 */
export const shouldAutoRotate = (input: AutoRotateInput): boolean => {
  if (input.writeLaneRowCount < input.threshold) return false;
  if (input.rotatedAtSec === null) return true;
  return input.nowSec - input.rotatedAtSec >= input.cooldownSec;
};
