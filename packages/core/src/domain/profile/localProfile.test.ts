/**
 * Tests for local profile persistence + the profile-setup workflow (#17),
 * run against in-memory Layers per the core testing conventions.
 */
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { KeyValueStorage } from "../../ports/index.js";
import type { ProfileMetadata } from "../../ports/ProfilePublisher.js";
import { ProfilePublishError, ProfilePublisher } from "../../ports/ProfilePublisher.js";
import { completeProfileSetup } from "./completeProfileSetup.js";
import { deriveInitialAvatarSelection } from "./generatedAvatar.js";
import type { LocalProfile } from "./localProfile.js";
import {
  LOCAL_PROFILE_STORAGE_KEY,
  clearLocalProfile,
  loadLocalProfile,
  saveLocalProfile,
} from "./localProfile.js";

const profile: LocalProfile = {
  name: "Alice",
  pictureUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=npub1alice",
  pictureKind: "generated",
  avatarSelection: deriveInitialAvatarSelection("npub1alice"),
  lightningAddress: "npub1alice@linky.fit",
};

describe("local profile persistence", () => {
  it("round-trips a saved profile", async () => {
    const program = Effect.gen(function* () {
      yield* saveLocalProfile(profile);
      return yield* loadLocalProfile;
    });
    const loaded = await Effect.runPromise(
      program.pipe(Effect.provide(KeyValueStorage.layerMemory)),
    );
    expect(Option.getOrNull(loaded)).toEqual(profile);
  });

  it("is none when nothing was saved", async () => {
    const loaded = await Effect.runPromise(
      loadLocalProfile.pipe(Effect.provide(KeyValueStorage.layerMemory)),
    );
    expect(Option.isNone(loaded)).toBe(true);
  });

  it("clearLocalProfile removes the stored profile and is idempotent", async () => {
    const program = Effect.gen(function* () {
      yield* saveLocalProfile(profile);
      yield* clearLocalProfile;
      yield* clearLocalProfile;
      return yield* loadLocalProfile;
    });
    const loaded = await Effect.runPromise(
      program.pipe(Effect.provide(KeyValueStorage.layerMemory)),
    );
    expect(Option.isNone(loaded)).toBe(true);
  });

  it("treats a corrupted stored value as absent, not an error", async () => {
    const program = Effect.gen(function* () {
      const kv = yield* KeyValueStorage.KeyValueStore;
      yield* kv.set(LOCAL_PROFILE_STORAGE_KEY, "{not json");
      return yield* loadLocalProfile;
    });
    const loaded = await Effect.runPromise(
      program.pipe(Effect.provide(KeyValueStorage.layerMemory)),
    );
    expect(Option.isNone(loaded)).toBe(true);
  });
});

describe("completeProfileSetup", () => {
  it("saves locally and publishes the metadata through the port", async () => {
    const published: ProfileMetadata[] = [];
    const PublisherCapture = Layer.succeed(ProfilePublisher, {
      publishProfile: (metadata) => Effect.sync(() => void published.push(metadata)),
    });

    const program = Effect.gen(function* () {
      yield* completeProfileSetup(profile);
      return yield* loadLocalProfile;
    });
    const loaded = await Effect.runPromise(
      program.pipe(Effect.provide(Layer.merge(KeyValueStorage.layerMemory, PublisherCapture))),
    );

    expect(Option.getOrNull(loaded)).toEqual(profile);
    expect(published).toEqual([
      {
        name: "Alice",
        displayName: "Alice",
        pictureUrl: profile.pictureUrl,
        lightningAddress: profile.lightningAddress,
      },
    ]);
  });

  it("surfaces a typed ProfilePublishError from the port", async () => {
    const PublisherFailing = Layer.succeed(ProfilePublisher, {
      publishProfile: () => Effect.fail(new ProfilePublishError({})),
    });
    const error = await Effect.runPromise(
      completeProfileSetup(profile).pipe(
        Effect.flip,
        Effect.provide(Layer.merge(KeyValueStorage.layerMemory, PublisherFailing)),
      ),
    );
    expect(error._tag).toBe("ProfilePublishError");
  });
});
