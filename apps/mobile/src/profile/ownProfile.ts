/**
 * Own-profile workflows (#30, `profile.view` / `profile.edit`) — the Effect
 * values the profile screens run through `useEffectQuery`/`useEffectMutation`.
 * App-level workflow module (like src/wallet/ownLightningAddress.ts): no
 * React, just composition of core workflows.
 *
 * Source order for the view model (PoC `effectiveProfile*`):
 *
 * 1. The locally saved profile (#17 storage, `loadLocalProfile`) — the
 *    user's own choices, present after onboarding or a previous save.
 * 2. Otherwise (restored account, nothing local yet): the user's OWN
 *    published kind-0 metadata / kind-30315 status from the relays
 *    (cache-first core fetches, bounded like #27's refresh because the
 *    relay stack can stall on a cold first subscribe).
 * 3. Derived defaults fill any remaining hole: deterministic name + avatar
 *    and the canonical `${npub}@linky.fit` default Lightning address
 *    (core `deriveDefaultProfile` — the ONE place that rule lives).
 */
import type { AvatarSelection, NameLanguage, ProfileEdits } from "@linky/core";
import {
  bestProfileName,
  deriveDefaultProfile,
  fetchProfileGeneralStatus,
  fetchProfileMetadata,
  loadLocalProfile,
  loadSession,
  profileLightningAddress,
  profilePictureUrl,
  saveProfileEdits,
} from "@linky/core";
import type { Duration } from "effect";
import { Effect, Option } from "effect";

import { invalidateOwnProfile } from "./ownProfileStore";

/** Everything the profile view + edit screens need about the own profile. */
export interface OwnProfile {
  readonly npub: string;
  readonly name: string;
  /** Canonical picture URL (DiceBear SVG URL or photo data URL). */
  readonly pictureUrl: string;
  readonly pictureKind: "generated" | "custom";
  /** Stored generated-avatar state when known (resumes the editor). */
  readonly avatarSelection: AvatarSelection | null;
  readonly lightningAddress: string;
  /** Encoded NIP-38 general status string; null when none is known. */
  readonly status: string | null;
}

/**
 * Hard ceiling on the relay lookups (cache misses only) — the #27 pattern:
 * `Effect.disconnect` + `timeoutTo`, so a stalled first subscribe can never
 * spin the profile screen forever.
 */
const FETCH_TIMEOUT: Duration.DurationInput = "20 seconds";

const bounded = <A, E, R>(
  effect: Effect.Effect<Option.Option<A>, E, R>,
): Effect.Effect<Option.Option<A>, E, R> =>
  Effect.disconnect(effect).pipe(
    Effect.timeoutTo({
      duration: FETCH_TIMEOUT,
      onTimeout: Option.none<A>,
      onSuccess: (value) => value,
    }),
  );

/**
 * The profile view model, or `null` while logged out (the gate prevents
 * that in practice). `lang` picks the deterministic default-name list.
 */
export const loadOwnProfile = (lang: NameLanguage) =>
  Effect.gen(function* () {
    const session = yield* loadSession;
    if (session._tag !== "IdentityLoaded") return null;

    const active = session.session.activeNostr;
    const npub = active.identity.npub;
    const pubkeyHex = active.identity.publicKeyHex;
    const defaults = deriveDefaultProfile(npub, lang);

    const local = yield* loadLocalProfile;
    if (Option.isSome(local)) {
      const profile = local.value;
      // Pre-#30 saved profiles carry no status — the relay fetch (cache-first)
      // fills it in once, bounded like every relay lookup here.
      const status =
        profile.status !== undefined
          ? profile.status
          : Option.getOrNull(yield* bounded(fetchProfileGeneralStatus(pubkeyHex)));
      return {
        npub,
        name: profile.name,
        pictureUrl: profile.pictureUrl,
        pictureKind: profile.pictureKind,
        avatarSelection: profile.avatarSelection,
        lightningAddress: profile.lightningAddress.trim() || defaults.lnAddress,
        status,
      };
    }

    // Restored account: published values win over derived defaults (PoC).
    // A custom-key override only sees post-switch events (#20 `since` rule).
    const fetchOptions = active.source === "custom" ? { sinceSec: active.activatedAtSec } : {};
    const metadata = Option.getOrNull(
      yield* bounded(fetchProfileMetadata(pubkeyHex, fetchOptions)),
    );
    const status = Option.getOrNull(yield* bounded(fetchProfileGeneralStatus(pubkeyHex)));

    const pictureUrl = profilePictureUrl(metadata) ?? defaults.pictureUrl;
    const result: OwnProfile = {
      npub,
      name: bestProfileName(metadata) ?? defaults.name,
      pictureUrl,
      // A published picture that is not the derived DiceBear URL behaves as
      // a custom photo in the editor (PoC `toggleProfileEditing` rule).
      pictureKind: pictureUrl === defaults.pictureUrl ? "generated" : "custom",
      avatarSelection: null,
      lightningAddress: profileLightningAddress(metadata) ?? defaults.lnAddress,
      status,
    };
    return result;
  });

/**
 * Paid hosted `@linky.fit` aliases the account owns.
 *
 * TODO(#61): the post-v1 alias-claim flow populates this (PoC:
 * `ownedLightningAddresses` from the npub.cash account info). Until then it
 * is structurally always empty, which keeps the restore-default affordance
 * rule (`canRestoreDefaultLightningAddress`) honest without a backend call.
 */
export const loadOwnedLightningAliases: Effect.Effect<ReadonlyArray<string>> = Effect.succeed([]);

/**
 * SAVE from the profile editor: core `saveProfileEdits` (local persistence +
 * kind 0 + kind 30315) plus the app-side invalidation so every mounted
 * consumer re-reads the new values.
 */
export const saveOwnProfile = (edits: ProfileEdits) =>
  saveProfileEdits(edits).pipe(Effect.tap(() => Effect.sync(invalidateOwnProfile)));
