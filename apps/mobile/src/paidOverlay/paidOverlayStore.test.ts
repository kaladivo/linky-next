/**
 * Store behavior: imperative API, 3s auto-dismiss, subscriptions. The store
 * keeps module-level state, so each test gets a fresh module instance via
 * vi.resetModules + dynamic import (same pattern as toastStore.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadStore = async () => await import("./paidOverlayStore");

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("paidOverlayStore", () => {
  it("show() opens the overlay and auto-dismisses after the PoC 3s", async () => {
    const { paidOverlay, getPaidOverlaySnapshot, PAID_OVERLAY_DURATION_MS } = await loadStore();

    paidOverlay.show();
    expect(getPaidOverlaySnapshot()).toEqual({ visible: true, title: null });

    vi.advanceTimersByTime(PAID_OVERLAY_DURATION_MS - 1);
    expect(getPaidOverlaySnapshot().visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(getPaidOverlaySnapshot().visible).toBe(false);
  });

  it("keeps a custom title and treats blank titles as the default", async () => {
    const { paidOverlay, getPaidOverlaySnapshot } = await loadStore();

    paidOverlay.show("Sent 1 000 sat.");
    expect(getPaidOverlaySnapshot().title).toBe("Sent 1 000 sat.");

    paidOverlay.show("   ");
    expect(getPaidOverlaySnapshot().title).toBeNull();
  });

  it("re-show restarts the auto-dismiss timer", async () => {
    const { paidOverlay, getPaidOverlaySnapshot, PAID_OVERLAY_DURATION_MS } = await loadStore();

    paidOverlay.show();
    vi.advanceTimersByTime(PAID_OVERLAY_DURATION_MS - 500);
    paidOverlay.show("again");
    vi.advanceTimersByTime(PAID_OVERLAY_DURATION_MS - 1);
    expect(getPaidOverlaySnapshot().visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(getPaidOverlaySnapshot().visible).toBe(false);
  });

  it("manual dismiss hides immediately and cancels the timer", async () => {
    const { paidOverlay, getPaidOverlaySnapshot } = await loadStore();

    paidOverlay.show();
    paidOverlay.dismiss();
    expect(getPaidOverlaySnapshot().visible).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("notifies subscribers on change and supports unsubscribe", async () => {
    const { paidOverlay, subscribeToPaidOverlay } = await loadStore();
    const listener = vi.fn();
    const unsubscribe = subscribeToPaidOverlay(listener);

    paidOverlay.show();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    paidOverlay.dismiss();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
