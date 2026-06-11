/**
 * completeProfileSetup — the final step of `onboarding.setup-profile`:
 * persist the chosen profile locally, then publish the initial metadata
 * through the ProfilePublisher port (`profile.publish-metadata`).
 *
 * Publishing goes through the port so issue #24 (real Nostr kind-0
 * publishing) only swaps the Layer — this workflow and its callers do not
 * change. Until then `apps/mobile` provides a no-op stub Layer, so the
 * publish step cannot fail in practice; once #24 lands, the typed
 * `ProfilePublishError` in the E channel is already part of the API.
 */
import { Effect } from "effect";
import type { PlatformError } from "@effect/platform/Error";

import type { ProfilePublishError } from "../../ports/ProfilePublisher.js";
import { ProfilePublisher } from "../../ports/ProfilePublisher.js";
import type { KeyValueStorage } from "../../ports/index.js";
import type { LocalProfile } from "./localProfile.js";
import { saveLocalProfile } from "./localProfile.js";

export const completeProfileSetup = (
  profile: LocalProfile,
): Effect.Effect<
  void,
  PlatformError | ProfilePublishError,
  KeyValueStorage.KeyValueStore | ProfilePublisher
> =>
  Effect.gen(function* () {
    yield* saveLocalProfile(profile);
    const publisher = yield* ProfilePublisher;
    yield* publisher.publishProfile({
      name: profile.name,
      displayName: profile.name,
      pictureUrl: profile.pictureUrl || null,
      lightningAddress: profile.lightningAddress || null,
    });
  });
