/**
 * saveProfileEdits — the profile editor's SAVE workflow (`profile.edit`,
 * `profile.publish-metadata`, `profile.publish-status`; issue #30).
 *
 * One save does three things, in order:
 *
 * 1. Persists the edited profile locally (same #17 storage:
 *    `saveLocalProfile` over KeyValueStorage — including the encoded NIP-38
 *    status string, so the profile view works offline after a relaunch).
 * 2. Publishes the kind-0 metadata through the ProfilePublisher port (#24:
 *    name/display_name, lud16, picture+image — golden-pinned shape).
 * 3. Publishes the kind-30315 general status (NIP-38 workflow,
 *    `publishProfileGeneralStatus`) as the ACTIVE Nostr identity. `null`
 *    publishes `""` (clears the status) — kind 30315 is parameterized
 *    replaceable, so every save just re-publishes.
 *
 * Offline is NOT an error for either publish: signed events land in
 * `NostrPendingQueue` and go out on the next flush (`deliverNostrEvent`
 * semantics), so the user's intent is never lost. The local save happens
 * FIRST: even if publishing fails outright, the device shows what the user
 * chose (PoC behavior: local cache is updated alongside the publish).
 *
 * `NoIdentity` at save time is a caller bug (the profile editor only exists
 * behind the session gate) — surfaced as `ProfilePublishError`, matching
 * the ProfilePublisher port's contract.
 */
import { Effect } from "effect";
import type { PlatformError } from "@effect/platform/Error";

import type { CustomNostrKeyCorruptedError } from "../identity/customNostrKey.js";
import type { IdentitySessionCorruptedError } from "../identity/identitySession.js";
import { loadSession } from "../identity/identitySession.js";
import type { NostrPendingQueue, NostrPendingQueueError } from "../nostr/NostrPendingQueue.js";
import type { RelayPool } from "../nostr/RelayPool.js";
import { publishProfileGeneralStatus } from "../nostr/profileStatus.js";
import type { KeyValueStorage } from "../../ports/index.js";
import { ProfilePublishError, ProfilePublisher } from "../../ports/ProfilePublisher.js";
import type { Randomness, RandomnessError } from "../../ports/Randomness.js";
import type { SecureStorage, SecureStorageError } from "../../ports/SecureStorage.js";
import type { LocalProfile } from "./localProfile.js";
import { saveLocalProfile } from "./localProfile.js";

/** What the profile editor saves: the full local profile (incl. status). */
export interface ProfileEdits {
  /** The edited profile; `status` carries the encoded NIP-38 string. */
  readonly profile: LocalProfile;
}

export type SaveProfileEditsError =
  | PlatformError
  | ProfilePublishError
  | RandomnessError
  | NostrPendingQueueError
  | SecureStorageError
  | IdentitySessionCorruptedError
  | CustomNostrKeyCorruptedError;

export type SaveProfileEditsRequirements =
  | KeyValueStorage.KeyValueStore
  | ProfilePublisher
  | SecureStorage
  | Randomness
  | RelayPool
  | NostrPendingQueue;

export const saveProfileEdits = (
  edits: ProfileEdits,
): Effect.Effect<void, SaveProfileEditsError, SaveProfileEditsRequirements> =>
  Effect.gen(function* () {
    const { profile } = edits;

    // 1. Local persistence first — the device always reflects the user's choice.
    yield* saveLocalProfile(profile);

    // 2. Kind 0 metadata via the port (#24 Layer resolves the signing key).
    const publisher = yield* ProfilePublisher;
    yield* publisher.publishProfile({
      name: profile.name,
      displayName: profile.name,
      pictureUrl: profile.pictureUrl || null,
      lightningAddress: profile.lightningAddress || null,
    });

    // 3. Kind 30315 general status as the active identity.
    const state = yield* loadSession;
    if (state._tag === "NoIdentity") {
      return yield* new ProfilePublishError({ cause: "no identity session" });
    }
    yield* publishProfileGeneralStatus(state.session.activeNostr, profile.status ?? null);
  });
