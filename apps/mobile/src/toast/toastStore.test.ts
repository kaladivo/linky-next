/**
 * Store behavior: imperative API, auto-dismiss timers, subscriptions.
 * The store keeps module-level state, so each test gets a fresh module
 * instance via vi.resetModules + dynamic import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadStore = async () => await import("./toastStore");

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("toastStore", () => {
  it("show() adds a trimmed toast and auto-dismisses after its duration", async () => {
    const { toast, getToastSnapshot, DEFAULT_TOAST_DURATION_MS } = await loadStore();

    toast.show("  hello  ");
    expect(getToastSnapshot()).toHaveLength(1);
    expect(getToastSnapshot()[0]?.message).toBe("hello");

    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS - 1);
    expect(getToastSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(getToastSnapshot()).toHaveLength(0);
  });

  it("ignores empty messages", async () => {
    const { toast, getToastSnapshot } = await loadStore();
    toast.show("   ");
    expect(getToastSnapshot()).toHaveLength(0);
  });

  it("variant shorthands tag the toast", async () => {
    const { toast, getToastSnapshot } = await loadStore();
    toast.success("ok");
    toast.error("boom");
    toast.info("fyi");
    expect(getToastSnapshot().map((t) => t.variant)).toEqual(["success", "error", "info"]);
  });

  it("manual dismiss cancels the pending timer", async () => {
    const { toast, getToastSnapshot } = await loadStore();
    toast.show("bye");
    const id = getToastSnapshot()[0]?.id;
    toast.dismiss(id ?? -1);
    expect(getToastSnapshot()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("notifies subscribers on change and supports unsubscribe", async () => {
    const { toast, subscribeToToasts } = await loadStore();
    const listener = vi.fn();
    const unsubscribe = subscribeToToasts(listener);

    toast.show("one");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    toast.show("two");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("respects a custom duration", async () => {
    const { toast, getToastSnapshot } = await loadStore();
    toast.show("fast", { durationMs: 100 });
    vi.advanceTimersByTime(100);
    expect(getToastSnapshot()).toHaveLength(0);
  });
});
