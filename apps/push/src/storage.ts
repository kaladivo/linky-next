/**
 * PushStorage — the service's entire persistent state behind one Effect
 * service tag, so the sqlite engine stays swappable.
 *
 * What is stored (and the privacy ceiling of this service):
 *
 * - `registrations` — recipient pubkey x install x Expo push token. No
 *   message content, no keys, nothing decryptable.
 * - `seen_events` — processed wrap ids for delivery dedupe across relays
 *   and watcher restarts (pruned after `seenEventRetentionMs`).
 * - `deliveries` — (event id, push token) pairs actually pushed, the
 *   second dedupe line covering tokens shared across old/new installs.
 * - `consumed_proofs` — NIP-98 proof event ids until their validity window
 *   passes, blocking proof replay.
 *
 * Engine: better-sqlite3 — synchronous (registration lifecycle is naturally
 * transactional), zero-config single file, already pinned in this monorepo
 * (evolu-store). All methods are wrapped in `Effect.sync`; an sqlite failure
 * is a defect, not an expected error.
 */
import Database from "better-sqlite3";
import { Context, Effect, Layer } from "effect";

export interface RegistrationRow {
  readonly recipientPubkey: string;
  readonly installationId: string;
  readonly expoPushToken: string;
  readonly updatedAtMs: number;
}

export type RegisterResult =
  | { readonly _tag: "registered"; readonly replacedStaleInstalls: number }
  | { readonly _tag: "limit-installs-per-identity" }
  | { readonly _tag: "limit-identities-per-install" };

export interface UnregisterResult {
  /** The (pubkey, install) row existed and was removed. */
  readonly removedIdentity: boolean;
  /** No identities remain for the install — it is now fully gone. */
  readonly installRemoved: boolean;
}

export interface PushStorageService {
  /**
   * Registers (or refreshes) one identity on one install. Atomically
   * replaces stale state instead of duplicating:
   *
   * - same (pubkey, install) with a different token → token is updated;
   * - the same token held by a DIFFERENT install (app reinstall: new
   *   installation id, same device token) → the old install's rows are
   *   deleted so one device never gets two pushes.
   *
   * Caps are enforced inside the same transaction.
   */
  readonly register: (args: {
    readonly recipientPubkey: string;
    readonly installationId: string;
    readonly expoPushToken: string;
    readonly nowMs: number;
    readonly maxInstallsPerIdentity: number;
    readonly maxIdentitiesPerInstall: number;
  }) => Effect.Effect<RegisterResult>;

  readonly unregister: (args: {
    readonly recipientPubkey: string;
    readonly installationId: string;
  }) => Effect.Effect<UnregisterResult>;

  readonly registrationsForPubkey: (
    recipientPubkey: string,
  ) => Effect.Effect<ReadonlyArray<RegistrationRow>>;

  readonly countInstallsForPubkey: (recipientPubkey: string) => Effect.Effect<number>;

  /** Drops every registration holding `expoPushToken` (token went dead). */
  readonly removeToken: (expoPushToken: string) => Effect.Effect<number>;

  /** True when `eventId` was not seen before (and is now recorded). */
  readonly markEventSeen: (eventId: string, nowMs: number) => Effect.Effect<boolean>;

  readonly pruneSeenEvents: (olderThanMs: number) => Effect.Effect<number>;

  /** True when (eventId, token) was not delivered before (now recorded). */
  readonly markDelivered: (
    eventId: string,
    expoPushToken: string,
    nowMs: number,
  ) => Effect.Effect<boolean>;

  /** True when the proof id is fresh (recorded); false = replay. */
  readonly consumeProof: (proofEventId: string, expiresAtMs: number) => Effect.Effect<boolean>;

  readonly pruneProofs: (nowMs: number) => Effect.Effect<number>;
}

export class PushStorage extends Context.Tag("@linky/push/PushStorage")<
  PushStorage,
  PushStorageService
>() {}

// ---------------------------------------------------------------------------
// sqlite implementation
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS registrations (
  recipient_pubkey TEXT NOT NULL,
  installation_id  TEXT NOT NULL,
  expo_push_token  TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (recipient_pubkey, installation_id)
);
CREATE INDEX IF NOT EXISTS idx_registrations_installation ON registrations (installation_id);
CREATE INDEX IF NOT EXISTS idx_registrations_token ON registrations (expo_push_token);

CREATE TABLE IF NOT EXISTS seen_events (
  event_id      TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  event_id        TEXT NOT NULL,
  expo_push_token TEXT NOT NULL,
  delivered_at    INTEGER NOT NULL,
  PRIMARY KEY (event_id, expo_push_token)
);

CREATE TABLE IF NOT EXISTS consumed_proofs (
  proof_event_id TEXT PRIMARY KEY,
  expires_at     INTEGER NOT NULL
);
`;

export const makeSqliteStorage = (
  dbPath: string,
): { readonly service: PushStorageService; readonly close: () => void } => {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const stmtCountInstallsForPubkey = db.prepare(
    "SELECT COUNT(*) AS n FROM registrations WHERE recipient_pubkey = ? AND installation_id != ?",
  );
  const stmtCountIdentitiesForInstall = db.prepare(
    "SELECT COUNT(*) AS n FROM registrations WHERE installation_id = ? AND recipient_pubkey != ?",
  );
  const stmtDeleteStaleToken = db.prepare(
    "DELETE FROM registrations WHERE expo_push_token = ? AND installation_id != ?",
  );
  const stmtUpsert = db.prepare(
    `INSERT INTO registrations (recipient_pubkey, installation_id, expo_push_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (recipient_pubkey, installation_id)
     DO UPDATE SET expo_push_token = excluded.expo_push_token, updated_at = excluded.updated_at`,
  );
  const stmtDeleteRegistration = db.prepare(
    "DELETE FROM registrations WHERE recipient_pubkey = ? AND installation_id = ?",
  );
  const stmtCountForInstall = db.prepare(
    "SELECT COUNT(*) AS n FROM registrations WHERE installation_id = ?",
  );
  const stmtRowsForPubkey = db.prepare(
    `SELECT recipient_pubkey AS recipientPubkey, installation_id AS installationId,
            expo_push_token AS expoPushToken, updated_at AS updatedAtMs
     FROM registrations WHERE recipient_pubkey = ? ORDER BY updated_at DESC`,
  );
  const stmtCountDistinctInstalls = db.prepare(
    "SELECT COUNT(*) AS n FROM registrations WHERE recipient_pubkey = ?",
  );
  const stmtRemoveToken = db.prepare("DELETE FROM registrations WHERE expo_push_token = ?");
  const stmtInsertSeen = db.prepare(
    "INSERT OR IGNORE INTO seen_events (event_id, first_seen_at) VALUES (?, ?)",
  );
  const stmtPruneSeen = db.prepare("DELETE FROM seen_events WHERE first_seen_at < ?");
  const stmtInsertDelivery = db.prepare(
    "INSERT OR IGNORE INTO deliveries (event_id, expo_push_token, delivered_at) VALUES (?, ?, ?)",
  );
  const stmtInsertProof = db.prepare(
    "INSERT OR IGNORE INTO consumed_proofs (proof_event_id, expires_at) VALUES (?, ?)",
  );
  const stmtPruneProofs = db.prepare("DELETE FROM consumed_proofs WHERE expires_at < ?");

  const count = (row: unknown): number => (row as { n: number }).n;

  const registerTx = db.transaction(
    (args: {
      recipientPubkey: string;
      installationId: string;
      expoPushToken: string;
      nowMs: number;
      maxInstallsPerIdentity: number;
      maxIdentitiesPerInstall: number;
    }): RegisterResult => {
      const installs = count(
        stmtCountInstallsForPubkey.get(args.recipientPubkey, args.installationId),
      );
      if (installs >= args.maxInstallsPerIdentity) {
        return { _tag: "limit-installs-per-identity" };
      }
      const identities = count(
        stmtCountIdentitiesForInstall.get(args.installationId, args.recipientPubkey),
      );
      if (identities >= args.maxIdentitiesPerInstall) {
        return { _tag: "limit-identities-per-install" };
      }
      const stale = stmtDeleteStaleToken.run(args.expoPushToken, args.installationId).changes;
      stmtUpsert.run(
        args.recipientPubkey,
        args.installationId,
        args.expoPushToken,
        args.nowMs,
        args.nowMs,
      );
      return { _tag: "registered", replacedStaleInstalls: stale };
    },
  );

  const unregisterTx = db.transaction(
    (args: { recipientPubkey: string; installationId: string }): UnregisterResult => {
      const removed = stmtDeleteRegistration.run(args.recipientPubkey, args.installationId);
      const remaining = count(stmtCountForInstall.get(args.installationId));
      return {
        removedIdentity: removed.changes > 0,
        installRemoved: removed.changes > 0 && remaining === 0,
      };
    },
  );

  const service: PushStorageService = {
    register: (args) => Effect.sync(() => registerTx(args)),
    unregister: (args) => Effect.sync(() => unregisterTx(args)),
    registrationsForPubkey: (recipientPubkey) =>
      Effect.sync(() => stmtRowsForPubkey.all(recipientPubkey) as Array<RegistrationRow>),
    countInstallsForPubkey: (recipientPubkey) =>
      Effect.sync(() => count(stmtCountDistinctInstalls.get(recipientPubkey))),
    removeToken: (expoPushToken) => Effect.sync(() => stmtRemoveToken.run(expoPushToken).changes),
    markEventSeen: (eventId, nowMs) =>
      Effect.sync(() => stmtInsertSeen.run(eventId, nowMs).changes > 0),
    pruneSeenEvents: (olderThanMs) => Effect.sync(() => stmtPruneSeen.run(olderThanMs).changes),
    markDelivered: (eventId, expoPushToken, nowMs) =>
      Effect.sync(() => stmtInsertDelivery.run(eventId, expoPushToken, nowMs).changes > 0),
    consumeProof: (proofEventId, expiresAtMs) =>
      Effect.sync(() => stmtInsertProof.run(proofEventId, expiresAtMs).changes > 0),
    pruneProofs: (nowMs) => Effect.sync(() => stmtPruneProofs.run(nowMs).changes),
  };

  return { service, close: () => db.close() };
};

/** Scoped Layer: opens the database, closes it with the scope. */
export const layerSqliteStorage = (dbPath: string): Layer.Layer<PushStorage> =>
  Layer.scoped(
    PushStorage,
    Effect.acquireRelease(
      Effect.sync(() => makeSqliteStorage(dbPath)),
      (storage) => Effect.sync(() => storage.close()),
    ).pipe(Effect.map((storage) => storage.service)),
  );
