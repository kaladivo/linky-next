/**
 * Token list/detail presentation model (#38) — the PURE half of the token
 * screens: grouping, sorting, state badges and mint display. The impure
 * actions (mint calls, repository writes) live in ./tokenActions.ts.
 *
 * Grouping follows the PoC (CashuTokensPage): two sections, "mine" (value
 * the wallet holds: accepted + error + spent leftovers awaiting cleanup)
 * and "issued" (value that is out: issued / pending / externalized /
 * reserved — the PoC's `isCashuTokenUnavailableState` set). Within a
 * section, rows are ordered by state rank (live value first, dead value
 * last) and newest-first inside a rank, so the list reads
 * "spendable → broken → dead".
 */
import type { TokenRecord, TokenState } from "@linky/core";
import { buildCashuShareUrl, canTransitionTokenState } from "@linky/core";
import { Effect, Either } from "effect";

// ---------------------------------------------------------------------------
// Mint display
// ---------------------------------------------------------------------------

/** Mint display like the PoC: scheme and trailing slashes stripped. */
export const mintDisplayName = (mintUrl: string): string =>
  mintUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// Share link
// ---------------------------------------------------------------------------

/**
 * The public Linky share link for a token (`cashu.share-token`):
 * `https://linky.fit/cashu/#<token>` — core's `buildCashuShareUrl` keeps the
 * token in the URL FRAGMENT so it never reaches any server. Null when the
 * stored token text is not a decodable Cashu token (share is disabled then).
 */
export const tokenShareUrl = (token: string): string | null => {
  const result = Effect.runSync(Effect.either(buildCashuShareUrl(token)));
  return Either.isRight(result) ? result.right : null;
};

// ---------------------------------------------------------------------------
// State badges
// ---------------------------------------------------------------------------

/** Badge tone — maps to the PoC pill classes (default / muted / error). */
export type TokenStateTone = "ok" | "muted" | "danger";

const STATE_TONES: Readonly<Record<TokenState, TokenStateTone>> = {
  accepted: "ok",
  issued: "muted",
  pending: "muted",
  reserved: "muted",
  externalized: "muted",
  spent: "danger",
  deleted: "muted",
  error: "danger",
};

export const tokenStateTone = (state: TokenState): TokenStateTone => STATE_TONES[state];

/** Translation key of the badge label, one per #33 state. */
export type TokenStateLabelKey =
  | "tokenStateAccepted"
  | "tokenStateIssued"
  | "tokenStatePending"
  | "tokenStateReserved"
  | "tokenStateExternalized"
  | "tokenStateSpent"
  | "tokenStateDeleted"
  | "tokenStateError";

const STATE_LABEL_KEYS: Readonly<Record<TokenState, TokenStateLabelKey>> = {
  accepted: "tokenStateAccepted",
  issued: "tokenStateIssued",
  pending: "tokenStatePending",
  reserved: "tokenStateReserved",
  externalized: "tokenStateExternalized",
  spent: "tokenStateSpent",
  deleted: "tokenStateDeleted",
  error: "tokenStateError",
};

export const tokenStateLabelKey = (state: TokenState): TokenStateLabelKey =>
  STATE_LABEL_KEYS[state];

// ---------------------------------------------------------------------------
// Grouping / sorting
// ---------------------------------------------------------------------------

/** "Out" = the PoC's unavailable set: emitted or deliberately set aside. */
const OUT_STATES: ReadonlySet<TokenState> = new Set([
  "issued",
  "pending",
  "reserved",
  "externalized",
]);

/** Sort rank within a section: live value first, dead value last. */
const STATE_RANK: Readonly<Record<TokenState, number>> = {
  accepted: 0,
  issued: 0,
  pending: 1,
  reserved: 1,
  externalized: 1,
  error: 2,
  spent: 3,
  deleted: 3,
};

const sortSection = (records: ReadonlyArray<TokenRecord>): ReadonlyArray<TokenRecord> =>
  [...records].sort((a, b) => {
    const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (rank !== 0) return rank;
    return b.createdAtMillis - a.createdAtMillis;
  });

export interface TokenListGroups {
  /** Held value: accepted / error / spent (awaiting cleanup). */
  readonly mine: ReadonlyArray<TokenRecord>;
  /** Out of the wallet: issued / pending / externalized / reserved. */
  readonly out: ReadonlyArray<TokenRecord>;
  /** Sum of the spendable (`accepted`) amounts in "mine". */
  readonly mineTotal: number;
  /** Sum of the "out" amounts (all still count toward the total balance). */
  readonly outTotal: number;
  /** `spent` rows cleanup could purge right now (list button badge). */
  readonly spentCount: number;
}

/**
 * Splits the (already tombstone-free) repository list into the PoC's two
 * sections. `deleted` rows never render — they are tombstones (#33).
 */
export const groupTokenRecords = (records: ReadonlyArray<TokenRecord>): TokenListGroups => {
  const visible = records.filter((record) => record.state !== "deleted");
  const mine = visible.filter((record) => !OUT_STATES.has(record.state));
  const out = visible.filter((record) => OUT_STATES.has(record.state));
  return {
    mine: sortSection(mine),
    out: sortSection(out),
    mineTotal: mine
      .filter((record) => record.state === "accepted")
      .reduce((sum, record) => sum + record.amount, 0),
    outTotal: out.reduce((sum, record) => sum + record.amount, 0),
    spentCount: mine.filter((record) => record.state === "spent").length,
  };
};

// ---------------------------------------------------------------------------
// Detail affordances — which actions a state offers (#33 transitions)
// ---------------------------------------------------------------------------

export interface TokenDetailActions {
  /** NUT-07 check against the mint (reconcile via repository). */
  readonly canCheck: boolean;
  /** `Reserve`: accepted → reserved (manual support/repair). */
  readonly canReserve: boolean;
  /** `Return`: issued | pending | reserved | externalized → accepted. */
  readonly canReturn: boolean;
  /** Re-accept at the mint then `Recover` (error rows only). */
  readonly canReaccept: boolean;
  /**
   * `Externalize` via NFC write (#50, `cashu.write-nfc`): accepted | issued
   * only (the #33 transition table). The screen additionally gates on
   * device NFC support — this flag is state-only.
   */
  readonly canWriteNfc: boolean;
}

/** PoC parity: which repair/check buttons the detail page shows per state. */
export const tokenDetailActions = (state: TokenState): TokenDetailActions => ({
  canCheck: state !== "spent" && state !== "deleted",
  canReserve: state === "accepted",
  canReturn: OUT_STATES.has(state),
  canReaccept: state === "error",
  canWriteNfc: canTransitionTokenState(state, "Externalize"),
});
