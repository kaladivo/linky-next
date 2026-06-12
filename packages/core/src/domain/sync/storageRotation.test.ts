/**
 * Storage rotation decision logic (#54): key codec, the convergent max-merge
 * plan, and the auto-rotation trigger. The convergence suite simulates two
 * devices as two entry SETS — the plan must be a pure function of the set
 * (order-independent, monotonic under union), which is the whole
 * cross-device agreement argument.
 */
import { describe, expect, it } from "vitest";

import {
  decodeRotationMetaValue,
  encodeRotationMetaValue,
  MAX_LANE_INDEX,
  parseRotationMetaKey,
  resolveRotationPlan,
  ROTATION_COOLDOWN_SEC,
  rotationMetaKey,
  shouldAutoRotate,
} from "./storageRotation.js";

const entry = (key: string, value: unknown = encodeRotationMetaValue({ rotatedAtSec: 1000 })) => ({
  key,
  value,
});

describe("rotationMetaKey / parseRotationMetaKey", () => {
  it("round-trips every rotating domain", () => {
    for (const domain of ["contacts", "wallet", "messages", "transactions"] as const) {
      expect(parseRotationMetaKey(rotationMetaKey(domain, 7))).toEqual({ domain, index: 7 });
    }
  });

  it("rejects foreign keys, fixed domains, and malformed indices", () => {
    for (const key of [
      "mainMint", // unrelated metaEntry key
      "rotation.meta.1", // fixed lane — never rotates
      "rotation.identity.1", // fixed lane — never rotates
      "rotation.messages", // no index
      "rotation.messages.", // empty index
      "rotation.messages.01", // leading zero
      "rotation.messages.-1",
      "rotation.messages.1.5",
      "rotation.messages.1x",
      "ROTATION.messages.1",
      "rotation.unknown.1",
    ]) {
      expect(parseRotationMetaKey(key), key).toBeNull();
    }
  });

  it("ignores indices above MAX_LANE_INDEX (deterministic corruption guard)", () => {
    expect(parseRotationMetaKey(rotationMetaKey("messages", MAX_LANE_INDEX))).not.toBeNull();
    expect(parseRotationMetaKey(rotationMetaKey("messages", MAX_LANE_INDEX + 1))).toBeNull();
    expect(parseRotationMetaKey("rotation.messages.999999999")).toBeNull();
  });
});

describe("rotation value codec", () => {
  it("round-trips rotatedAtSec", () => {
    expect(decodeRotationMetaValue(encodeRotationMetaValue({ rotatedAtSec: 1718000000 }))).toEqual({
      rotatedAtSec: 1718000000,
    });
  });

  it("tolerates garbage values (the index lives in the key)", () => {
    for (const value of [null, 42, "", "not json", "{}", '{"rotatedAtSec":"x"}', '{"rotatedAtSec":-5}']) {
      expect(decodeRotationMetaValue(value)).toEqual({ rotatedAtSec: null });
    }
  });
});

describe("resolveRotationPlan", () => {
  it("defaults every domain to lane 0", () => {
    const plan = resolveRotationPlan([]);
    for (const domain of ["contacts", "wallet", "messages", "transactions"] as const) {
      expect(plan[domain]).toEqual({ index: 0, rotatedAtSec: null });
    }
  });

  it("takes the maximum index per domain and its rotatedAtSec", () => {
    const plan = resolveRotationPlan([
      entry(rotationMetaKey("messages", 1), encodeRotationMetaValue({ rotatedAtSec: 100 })),
      entry(rotationMetaKey("messages", 3), encodeRotationMetaValue({ rotatedAtSec: 300 })),
      entry(rotationMetaKey("messages", 2), encodeRotationMetaValue({ rotatedAtSec: 200 })),
      entry(rotationMetaKey("wallet", 1), encodeRotationMetaValue({ rotatedAtSec: 50 })),
    ]);
    expect(plan.messages).toEqual({ index: 3, rotatedAtSec: 300 });
    expect(plan.wallet).toEqual({ index: 1, rotatedAtSec: 50 });
    expect(plan.contacts.index).toBe(0);
    expect(plan.transactions.index).toBe(0);
  });

  it("counts entries with garbled values (lane may hold data; never ignore it)", () => {
    const plan = resolveRotationPlan([entry(rotationMetaKey("contacts", 2), "garbage")]);
    expect(plan.contacts).toEqual({ index: 2, rotatedAtSec: null });
  });

  it("skips foreign keys and over-cap indices without affecting the rest", () => {
    const plan = resolveRotationPlan([
      entry("mainMint", "https://mint.example.com"),
      entry(rotationMetaKey("messages", 1)),
      entry(`rotation.messages.${String(MAX_LANE_INDEX + 100)}`),
    ]);
    expect(plan.messages.index).toBe(1);
  });

  it("is order-independent: any permutation of the same set yields the same plan", () => {
    const entries = [
      entry(rotationMetaKey("messages", 2), encodeRotationMetaValue({ rotatedAtSec: 222 })),
      entry(rotationMetaKey("messages", 1), encodeRotationMetaValue({ rotatedAtSec: 111 })),
      entry(rotationMetaKey("contacts", 1), encodeRotationMetaValue({ rotatedAtSec: 11 })),
      entry(rotationMetaKey("wallet", 3), "garbage"),
      entry("unrelated", "x"),
    ];
    const reference = resolveRotationPlan(entries);
    expect(resolveRotationPlan([...entries].reverse())).toEqual(reference);
    expect(
      resolveRotationPlan([entries[3]!, entries[0]!, entries[4]!, entries[2]!, entries[1]!]),
    ).toEqual(reference);
  });

  it("converges two devices: union of both entry sets is the agreed plan", () => {
    // Device A rotated messages to 1; device B (not yet synced) rotated
    // messages to 1 concurrently AND transactions to 1.
    const deviceA = [entry(rotationMetaKey("messages", 1))];
    const deviceB = [entry(rotationMetaKey("messages", 1)), entry(rotationMetaKey("transactions", 1))];
    const merged = resolveRotationPlan([...deviceA, ...deviceB]);
    // Concurrent identical rotations collapse: max-merge gives 1, not 2.
    expect(merged.messages.index).toBe(1);
    expect(merged.transactions.index).toBe(1);
    // Monotone: merging never lowers any device's own index.
    const planA = resolveRotationPlan(deviceA);
    const planB = resolveRotationPlan(deviceB);
    for (const domain of ["contacts", "wallet", "messages", "transactions"] as const) {
      expect(merged[domain].index).toBeGreaterThanOrEqual(planA[domain].index);
      expect(merged[domain].index).toBeGreaterThanOrEqual(planB[domain].index);
    }
  });
});

describe("shouldAutoRotate", () => {
  const base = {
    writeLaneRowCount: 160,
    threshold: 160,
    nowSec: 10_000,
    rotatedAtSec: null,
    cooldownSec: ROTATION_COOLDOWN_SEC,
  };

  it("rotates at the threshold when the domain never rotated", () => {
    expect(shouldAutoRotate(base)).toBe(true);
  });

  it("stays put below the threshold", () => {
    expect(shouldAutoRotate({ ...base, writeLaneRowCount: 159 })).toBe(false);
  });

  it("respects the cooldown after a rotation", () => {
    expect(shouldAutoRotate({ ...base, rotatedAtSec: base.nowSec - 30 })).toBe(false);
    expect(shouldAutoRotate({ ...base, rotatedAtSec: base.nowSec - ROTATION_COOLDOWN_SEC })).toBe(
      true,
    );
  });
});
