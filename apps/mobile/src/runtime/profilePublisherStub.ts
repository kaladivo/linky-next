/**
 * ProfilePublisher stub Layer.
 *
 * TODO(#24): replace with the real Nostr kind-0 publisher (sign with the
 * session's Nostr key, publish name/display_name/picture/image/lud16 to the
 * configured relays). Swapping THIS Layer in appLayer.ts is the entire
 * integration — onboarding's `completeProfileSetup` already calls the port.
 *
 * Until then publishing is a logged no-op: onboarding completes, the
 * profile stays local (`loadLocalProfile`), and nothing leaves the device.
 */
import { ProfilePublisher } from "@linky/core";
import { Effect, Layer } from "effect";

export const ProfilePublisherStub = Layer.succeed(ProfilePublisher, {
  publishProfile: (metadata) =>
    Effect.logInfo("ProfilePublisher stub (#24): skipping publish").pipe(
      Effect.annotateLogs({
        name: metadata.name,
        hasPicture: String(metadata.pictureUrl !== null),
        lightningAddress: metadata.lightningAddress ?? "",
      }),
    ),
});
