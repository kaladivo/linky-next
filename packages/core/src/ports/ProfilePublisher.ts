/**
 * ProfilePublisher port — publishing the user's public profile metadata to
 * the outside world (`profile.publish-metadata` in the feature map: Nostr
 * kind 0 with name / picture / lud16).
 *
 * Defined as a port so onboarding (#17) can call "publish my initial
 * profile" without knowing how publishing works. The real relay-backed
 * implementation is issue #24 — until it lands, `apps/mobile` provides a
 * no-op stub Layer and ONLY the Layer is swapped when #24 ships; every
 * workflow calling this port stays untouched.
 */
import { Context, Data } from "effect";
import type { Effect } from "effect";

/**
 * What gets published. Field names are protocol-agnostic on purpose; the
 * implementation maps them to the wire format (for Nostr kind 0:
 * `name`/`display_name`, `picture`/`image`, `lud16` — the PoC publishes
 * exactly those fields).
 */
export interface ProfileMetadata {
  readonly name: string;
  readonly displayName: string;
  /** Avatar URL (DiceBear URL or data URL for a custom photo), if any. */
  readonly pictureUrl: string | null;
  /** Lightning address (`lud16`), if any. */
  readonly lightningAddress: string | null;
}

/**
 * Expected failure of publishing (no relay reachable, signing backend
 * unavailable). Implementations map every native failure into this error;
 * nothing is thrown across the port.
 */
export class ProfilePublishError extends Data.TaggedError("ProfilePublishError")<{
  readonly cause?: unknown;
}> {}

export interface ProfilePublisherService {
  /** Publish (or republish) the user's profile metadata. */
  readonly publishProfile: (
    metadata: ProfileMetadata,
  ) => Effect.Effect<void, ProfilePublishError>;
}

export class ProfilePublisher extends Context.Tag("@linky/core/ProfilePublisher")<
  ProfilePublisher,
  ProfilePublisherService
>() {}
