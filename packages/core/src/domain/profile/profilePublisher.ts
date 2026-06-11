/**
 * layerProfilePublisher — the REAL implementation of the `ProfilePublisher`
 * port (issue #24, replacing the #17 stub in `apps/mobile`): publishes the
 * user's profile metadata as a Nostr kind-0 event signed by the ACTIVE
 * Nostr identity.
 *
 * A core-shipped Layer (like the relay services, #21): pure domain logic —
 * all platform access goes through the ports it requires. Behavior:
 *
 * - The signing key is resolved per publish via `loadSession` (#14/#20), so
 *   a custom-key override activated after startup signs immediately. No
 *   identity stored → `ProfilePublishError` (publishing a profile before
 *   onboarding created one is a caller bug surfaced as the port's error).
 * - Event shape + delivery semantics live in
 *   `domain/nostr/profileMetadata.ts` (golden-pinned against the PoC).
 *   Offline is NOT an error: the signed event lands in `NostrPendingQueue`
 *   and goes out on the next flush — the port resolves successfully because
 *   the user's intent is preserved.
 * - Every underlying failure (session storage, signing entropy, outbox
 *   storage) is mapped into `ProfilePublishError` with the typed error as
 *   `cause` (those errors are reason-only by design, no secret material).
 */
import { Effect, Layer } from "effect";

import { ProfilePublishError, ProfilePublisher } from "../../ports/ProfilePublisher.js";
import type { Randomness } from "../../ports/Randomness.js";
import type { SecureStorage } from "../../ports/SecureStorage.js";
import { loadSession } from "../identity/identitySession.js";
import type { NostrPendingQueue } from "../nostr/NostrPendingQueue.js";
import type { RelayPool } from "../nostr/RelayPool.js";
import { publishProfileMetadata } from "../nostr/profileMetadata.js";

/** Everything the real publisher needs from the runtime. */
type PublisherRequirements = RelayPool | NostrPendingQueue | Randomness | SecureStorage;

export const layerProfilePublisher: Layer.Layer<ProfilePublisher, never, PublisherRequirements> =
  Layer.effect(
    ProfilePublisher,
    Effect.gen(function* () {
      const context = yield* Effect.context<PublisherRequirements>();
      return {
        publishProfile: (metadata) =>
          Effect.gen(function* () {
            const state = yield* loadSession;
            if (state._tag === "NoIdentity") {
              return yield* new ProfilePublishError({ cause: "no identity session" });
            }
            yield* publishProfileMetadata(state.session.activeNostr, metadata);
          }).pipe(
            Effect.mapError((error) =>
              error._tag === "ProfilePublishError"
                ? error
                : new ProfilePublishError({ cause: error }),
            ),
            Effect.provide(context),
          ),
      };
    }),
  );
