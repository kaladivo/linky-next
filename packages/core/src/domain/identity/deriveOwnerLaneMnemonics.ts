/**
 * deriveOwnerLaneMnemonics — all six owner-lane mnemonics at once, the input
 * `packages/evolu-store`'s `createLinkyStore` needs to boot the session
 * Evolu store (issue #26; `identity.derive-sync-identities`).
 *
 * A thin composition over {@link deriveOwnerLane} at lane index 0 for every
 * sync domain. Rotated lanes (`sync.storage-rotation`, #54) keep using
 * `deriveOwnerLane` directly with their rotation index.
 *
 * The result is secret material — never log it.
 */
import { Effect } from "effect";

import { SyncDomain } from "./DerivedIdentities.js";
import type { OwnerLaneMnemonic } from "./DerivedIdentities.js";
import { deriveOwnerLane } from "./deriveOwnerLane.js";
import type { MasterSecret } from "./MasterIdentity.js";

/** One lane-0 mnemonic per sync domain, keyed by domain. */
export type OwnerLaneMnemonics = Readonly<Record<SyncDomain, OwnerLaneMnemonic>>;

export const deriveOwnerLaneMnemonics = (
  masterSecret: MasterSecret,
): Effect.Effect<OwnerLaneMnemonics> =>
  Effect.forEach(SyncDomain.literals, (domain) => deriveOwnerLane(masterSecret, domain)).pipe(
    Effect.map(
      (lanes) =>
        Object.fromEntries(lanes.map((lane) => [lane.domain, lane.mnemonic])) as Record<
          SyncDomain,
          OwnerLaneMnemonic
        >,
    ),
  );
