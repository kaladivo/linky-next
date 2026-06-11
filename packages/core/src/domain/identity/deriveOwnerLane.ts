/**
 * deriveOwnerLane — one Evolu owner lane from the master secret
 * (`identity.derive-sync-identities` in the feature map).
 *
 * Mechanism (PoC-exact, pinned by golden fixtures): 16 bytes of BIP-85
 * entropy at the lane's path (see `derivationPaths.ts`, including the
 * identity-lane fallthrough quirk), encoded as a 12-word BIP-39 mnemonic.
 *
 * The mnemonic is the contract with `packages/evolu-store`, which turns it
 * into an Evolu `AppOwner` (`mnemonicToOwnerSecret` -> `createAppOwner`,
 * SLIP-21) — core never imports the Evolu runtime. Same master secret ->
 * same owner id as the PoC, so restored accounts reconnect to their synced
 * data.
 *
 * `meta` and `identity` are fixed single lanes: asking for a non-zero index
 * there is a programmer error and dies (defect).
 */
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Effect } from "effect";

import { ownerLaneDerivationPath } from "./derivationPaths.js";
import type { OwnerLane, SyncDomain } from "./DerivedIdentities.js";
import { OwnerLaneIndex, OwnerLaneMnemonic } from "./DerivedIdentities.js";
import { bip85Entropy, hdRootFromMasterSecret } from "./bip85.js";
import type { MasterSecret } from "./MasterIdentity.js";

const ZERO_INDEX = OwnerLaneIndex.make(0);

/**
 * Derives the owner lane for `domain` at rotation `index` (default 0).
 * The mnemonic is a secret — never log it.
 */
export const deriveOwnerLane = (
  masterSecret: MasterSecret,
  domain: SyncDomain,
  index: OwnerLaneIndex = ZERO_INDEX,
): Effect.Effect<OwnerLane> =>
  Effect.sync(() => {
    if ((domain === "meta" || domain === "identity") && index !== 0) {
      // Fixed lanes never rotate; a non-zero index is a bug in the caller.
      throw new Error(`The "${domain}" sync domain has a single fixed lane; index must be 0`);
    }
    const root = hdRootFromMasterSecret(masterSecret);
    const entropy = bip85Entropy(root, ownerLaneDerivationPath(domain, index), 16);
    return {
      domain,
      index,
      mnemonic: OwnerLaneMnemonic.make(entropyToMnemonic(entropy, wordlist)),
    };
  });
