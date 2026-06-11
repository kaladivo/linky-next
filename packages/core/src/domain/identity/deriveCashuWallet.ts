/**
 * deriveCashuWallet — the deterministic Cashu wallet identity from the
 * master secret (`identity.derive-cashu-seed` in the feature map).
 *
 * Mechanism (PoC-exact, pinned by golden fixtures): BIP-85 — 32 bytes of
 * entropy at `m/83696968'/39'/0'/24'/0'`, encoded as a 24-word BIP-39
 * mnemonic, expanded to the 64-byte BIP-39 seed with an empty passphrase.
 *
 * STABILITY IS A FUND-SAFETY CONTRACT: Cashu deterministic-secret recovery
 * restores ecash from mints using this seed. Any change strands users'
 * funds. The mnemonic exists so users can recover funds in other Cashu
 * wallets; the seed is what cashu-ts consumes.
 */
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Effect } from "effect";

import { CASHU_SEED_DERIVATION_PATH } from "./derivationPaths.js";
import type { CashuWallet } from "./DerivedIdentities.js";
import { CashuMnemonic, CashuSeed } from "./DerivedIdentities.js";
import { bip85Entropy, hdRootFromMasterSecret } from "./bip85.js";
import type { MasterSecret } from "./MasterIdentity.js";

/**
 * Derives the Cashu wallet mnemonic + seed. Same master secret -> same seed
 * as the PoC, forever. Both values are secrets — never log them.
 */
export const deriveCashuWallet = (masterSecret: MasterSecret): Effect.Effect<CashuWallet> =>
  Effect.sync(() => {
    const root = hdRootFromMasterSecret(masterSecret);
    const entropy = bip85Entropy(root, CASHU_SEED_DERIVATION_PATH, 32);
    const mnemonic = entropyToMnemonic(entropy, wordlist);
    return {
      mnemonic: CashuMnemonic.make(mnemonic),
      seed: CashuSeed.make(mnemonicToSeedSync(mnemonic)),
    };
  });
