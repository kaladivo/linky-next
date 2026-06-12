import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import type { FakeRelayNetwork, NostrEvent, NostrTransport } from "@linky/core";
import { makeFakeRelayNetwork } from "@linky/core";
import { afterEach, describe, expect, it } from "vitest";

import type { PushConfig, PushConfigData } from "./config.js";
import { testConfig } from "./config.js";
import type { PushSender } from "./pushSender.js";
import type { RateLimiter } from "./rateLimit.js";
import { PushStorage } from "./storage.js";
import type { FakeSender } from "./testKit.js";
import { alice, baseLayers, bob, makeFakeSender, makeWrap, until } from "./testKit.js";
import type { Watcher } from "./watcher.js";
import { makeWatcher } from "./watcher.js";

const RELAY_ONE = "wss://fake.relay.one";
const RELAY_TWO = "wss://fake.relay.two";

type Deps = PushConfig | PushStorage | RateLimiter | PushSender | NostrTransport;

interface Harness {
  readonly runtime: ManagedRuntime.ManagedRuntime<Deps, never>;
  readonly network: FakeRelayNetwork;
  readonly sender: FakeSender;
  readonly registerRecipient: (pubkeyHex: string, token: string) => Promise<void>;
  readonly startWatcher: () => Promise<{
    readonly watcher: Watcher;
    readonly stop: () => Promise<void>;
  }>;
  readonly emit: (relayUrl: string, event: NostrEvent) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

const makeHarness = async (config: PushConfigData = testConfig()): Promise<Harness> => {
  const network = await Effect.runPromise(makeFakeRelayNetwork);
  const sender = makeFakeSender();
  const runtime: ManagedRuntime.ManagedRuntime<Deps, never> = ManagedRuntime.make(
    Layer.mergeAll(baseLayers(config), sender.layer, network.transport),
  );

  const allLive = (watcher: Watcher) => async () => {
    await until(() => {
      const status = Effect.runSync(watcher.status);
      return config.relayUrls.every((url) => status[url]?.live === true);
    });
  };

  return {
    runtime,
    network,
    sender,
    registerRecipient: (pubkeyHex, token) =>
      runtime
        .runPromise(
          Effect.flatMap(PushStorage, (storage) =>
            storage.register({
              recipientPubkey: pubkeyHex,
              installationId: `install-${token}`,
              expoPushToken: token,
              nowMs: Date.now(),
              maxInstallsPerIdentity: 10,
              maxIdentitiesPerInstall: 8,
            }),
          ),
        )
        .then(() => undefined),
    startWatcher: async () => {
      const watcher = await runtime.runPromise(makeWatcher);
      const fiber = runtime.runFork(watcher.run);
      await allLive(watcher)();
      return {
        watcher,
        stop: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined),
      };
    },
    emit: async (relayUrl, event) => {
      const relay = await Effect.runPromise(network.relay(relayUrl));
      await Effect.runPromise(relay.emitEvent(event));
    },
    dispose: () => runtime.dispose(),
  };
};

describe("relay watcher (service-watch, dedupe, catch-up suppression)", () => {
  const harnesses: Array<Harness> = [];
  afterEach(async () => {
    while (harnesses.length > 0) await harnesses.pop()?.dispose();
  });
  const harness = async (config?: PushConfigData) => {
    const created = await makeHarness(config);
    harnesses.push(created);
    return created;
  };

  it("delivers a live marked wrap exactly once across two relays", async () => {
    const h = await harness();
    await h.registerRecipient(bob.publicKeyHex, "ExponentPushToken[bob]");
    const { stop } = await h.startWatcher();

    const wrap = makeWrap({
      sender: alice,
      recipientPublicKeyHex: bob.publicKeyHex,
      pushMarker: true,
    });
    await h.emit(RELAY_ONE, wrap);
    await h.emit(RELAY_TWO, wrap);

    await until(() => h.sender.sent.length === 1);
    // Settle: confirm no second delivery sneaks in from the other relay.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.sender.sent).toHaveLength(1);
    expect(h.sender.sent[0]?.to).toBe("ExponentPushToken[bob]");
    expect(h.sender.sent[0]?.data["eventId"]).toBe(wrap.id);
    await stop();
  });

  it("suppresses historical backfill after downtime (pre-EOSE events never notify)", async () => {
    const h = await harness();
    await h.registerRecipient(bob.publicKeyHex, "ExponentPushToken[bob]");

    // Events stored on the relay BEFORE the watcher connects = downtime
    // traffic; they arrive before EOSE and must stay silent.
    const missed = makeWrap({
      sender: alice,
      recipientPublicKeyHex: bob.publicKeyHex,
      pushMarker: true,
    });
    await h.emit(RELAY_ONE, missed);
    await h.emit(RELAY_TWO, missed);

    const { stop } = await h.startWatcher();
    // Live traffic still notifies after catch-up.
    const fresh = makeWrap({
      sender: alice,
      recipientPublicKeyHex: bob.publicKeyHex,
      pushMarker: true,
    });
    await h.emit(RELAY_ONE, fresh);
    await until(() => h.sender.sent.length === 1);
    expect(h.sender.sent[0]?.data["eventId"]).toBe(fresh.id);
    await stop();
  });

  it("does not redeliver across watcher restarts (reinstall/redeploy)", async () => {
    const h = await harness();
    await h.registerRecipient(bob.publicKeyHex, "ExponentPushToken[bob]");
    const first = await h.startWatcher();

    const wrap = makeWrap({
      sender: alice,
      recipientPublicKeyHex: bob.publicKeyHex,
      pushMarker: true,
    });
    await h.emit(RELAY_ONE, wrap);
    await until(() => h.sender.sent.length === 1);
    await first.stop();

    // Restart: the wrap is now relay backfill AND in the seen store.
    const second = await h.startWatcher();
    const fresh = makeWrap({
      sender: alice,
      recipientPublicKeyHex: bob.publicKeyHex,
      pushMarker: true,
    });
    await h.emit(RELAY_TWO, fresh);
    await until(() => h.sender.sent.length === 2);
    expect(h.sender.sent.map((message) => message.data["eventId"])).toEqual([wrap.id, fresh.id]);
    await second.stop();
  });

  it("never alerts for unmarked traffic: self copies, reactions, token messages", async () => {
    const h = await harness();
    await h.registerRecipient(alice.publicKeyHex, "ExponentPushToken[alice]");
    await h.registerRecipient(bob.publicKeyHex, "ExponentPushToken[bob]");
    const { stop } = await h.startWatcher();

    // Self/sync copy addressed to alice (registered!) — quiet.
    await h.emit(
      RELAY_ONE,
      makeWrap({
        sender: alice,
        recipientPublicKeyHex: bob.publicKeyHex,
        pushMarker: true,
        self: true,
      }),
    );
    // Reaction to bob — quiet.
    await h.emit(
      RELAY_ONE,
      makeWrap({
        sender: alice,
        recipientPublicKeyHex: bob.publicKeyHex,
        pushMarker: false,
        kind: 7,
      }),
    );
    // Token message to bob — quiet.
    await h.emit(
      RELAY_ONE,
      makeWrap({
        sender: alice,
        recipientPublicKeyHex: bob.publicKeyHex,
        pushMarker: false,
        content: "cashuA...",
      }),
    );
    // Sentinel marked wrap — the only alert; proves the quiet ones were
    // processed (in-order per connection), not just still in flight.
    const sentinel = makeWrap({
      sender: alice,
      recipientPublicKeyHex: bob.publicKeyHex,
      pushMarker: true,
    });
    await h.emit(RELAY_ONE, sentinel);

    await until(() => h.sender.sent.length === 1);
    expect(h.sender.sent[0]?.data["eventId"]).toBe(sentinel.id);
    await stop();
  });

  it("stays quiet for unregistered recipients", async () => {
    const h = await harness();
    await h.registerRecipient(alice.publicKeyHex, "ExponentPushToken[alice]");
    const { stop } = await h.startWatcher();

    await h.emit(
      RELAY_ONE,
      makeWrap({ sender: alice, recipientPublicKeyHex: bob.publicKeyHex, pushMarker: true }),
    );
    const forAlice = makeWrap({
      sender: bob,
      recipientPublicKeyHex: alice.publicKeyHex,
      pushMarker: true,
    });
    await h.emit(RELAY_ONE, forAlice);
    await until(() => h.sender.sent.length === 1);
    expect(h.sender.sent[0]?.data["eventId"]).toBe(forAlice.id);
    await stop();
  });

  it("drops registrations whose token Expo reports as dead", async () => {
    const h = await harness();
    await h.registerRecipient(bob.publicKeyHex, "ExponentPushToken[dead]");
    h.sender.setOutcome("ExponentPushToken[dead]", "device-not-registered");
    const { stop } = await h.startWatcher();

    await h.emit(
      RELAY_ONE,
      makeWrap({ sender: alice, recipientPublicKeyHex: bob.publicKeyHex, pushMarker: true }),
    );
    await until(() => h.sender.sent.length === 1);
    await until(() => {
      const rows = h.runtime.runSync(
        Effect.flatMap(PushStorage, (storage) => storage.registrationsForPubkey(bob.publicKeyHex)),
      );
      return rows.length === 0;
    });
    await stop();
  });
});
