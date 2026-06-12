/**
 * The user's own Lightning address for no-amount receive
 * (`cashu.no-amount-receive`, #37) — DISPLAY ONLY here; the hosted
 * npub.cash-style sync that makes the address actually route is #41.
 *
 * PoC source order (`effectiveMyLightningAddress`): the profile's saved
 * Lightning address when present, otherwise the derived default
 * `<npub>@linky.fit` for the ACTIVE Nostr identity.
 */
import { deriveDefaultLightningAddress, loadLocalProfile, loadSession } from "@linky/core";
import { Effect, Option } from "effect";

/**
 * The address to show, or null while logged out (gate prevents that).
 * E/R inferred: storage read failures plus `loadSession`'s corruption
 * errors over KeyValueStorage + SecureStorage — all ⊆ AppServices.
 */
export const loadOwnLightningAddress = Effect.gen(function* () {
  const session = yield* loadSession;
  if (session._tag !== "IdentityLoaded") return null;

  const profile = yield* loadLocalProfile;
  const fromProfile = Option.match(profile, {
    onNone: () => "",
    onSome: (value) => value.lightningAddress.trim(),
  });
  if (fromProfile !== "") return fromProfile;
  return deriveDefaultLightningAddress(session.session.activeNostr.identity.npub);
});
