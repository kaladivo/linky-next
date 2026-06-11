import { describe, expect, it } from "vitest";

import type { ToastItem } from "./toastQueue";
import { MAX_VISIBLE_TOASTS, initialToastState, toastReducer } from "./toastQueue";

const makeToast = (id: number, message = `toast ${id}`): ToastItem => ({
  id,
  message,
  variant: "info",
  durationMs: 2500,
});

describe("toastReducer", () => {
  it("appends new toasts in order", () => {
    const one = toastReducer(initialToastState, { type: "add", toast: makeToast(1) });
    const two = toastReducer(one, { type: "add", toast: makeToast(2) });
    expect(two.map((t) => t.id)).toEqual([1, 2]);
  });

  it("drops the oldest toast beyond the cap", () => {
    let state = initialToastState;
    for (let id = 1; id <= MAX_VISIBLE_TOASTS + 2; id++) {
      state = toastReducer(state, { type: "add", toast: makeToast(id) });
    }
    expect(state).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(state.map((t) => t.id)).toEqual([3, 4, 5]);
  });

  it("dismisses by id", () => {
    let state = initialToastState;
    state = toastReducer(state, { type: "add", toast: makeToast(1) });
    state = toastReducer(state, { type: "add", toast: makeToast(2) });
    state = toastReducer(state, { type: "dismiss", id: 1 });
    expect(state.map((t) => t.id)).toEqual([2]);
  });

  it("returns the same reference when dismissing an unknown id", () => {
    const state = toastReducer(initialToastState, { type: "add", toast: makeToast(1) });
    expect(toastReducer(state, { type: "dismiss", id: 99 })).toBe(state);
  });

  it("clear empties the queue and is a no-op reference-wise when already empty", () => {
    const state = toastReducer(initialToastState, { type: "add", toast: makeToast(1) });
    expect(toastReducer(state, { type: "clear" })).toEqual([]);
    expect(toastReducer(initialToastState, { type: "clear" })).toBe(initialToastState);
  });
});
