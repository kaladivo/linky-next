/**
 * Toast queue — the pure half of the toast system (shell.toast).
 *
 * Plain reducer over an immutable list of toasts: no timers, no React, no
 * globals, so it is unit-testable in vitest. The stateful half (id
 * generation, auto-dismiss timers, subscriptions) lives in toastStore.ts;
 * the rendering half in ToastHost.tsx.
 */

export type ToastVariant = "success" | "error" | "info";

export interface ToastItem {
  readonly id: number;
  readonly message: string;
  readonly variant: ToastVariant;
  /** Auto-dismiss delay; the store schedules the timer, the reducer only stores it. */
  readonly durationMs: number;
}

export type ToastState = readonly ToastItem[];

export type ToastAction =
  | { readonly type: "add"; readonly toast: ToastItem }
  | { readonly type: "dismiss"; readonly id: number }
  | { readonly type: "clear" };

/** Older toasts beyond this cap are dropped (oldest first), as in the PoC stack. */
export const MAX_VISIBLE_TOASTS = 3;

export const initialToastState: ToastState = [];

/**
 * Returns the same reference when an action changes nothing (unknown
 * dismiss id, clear on empty) so subscribers can skip re-rendering.
 */
export const toastReducer = (state: ToastState, action: ToastAction): ToastState => {
  switch (action.type) {
    case "add": {
      const next = [...state, action.toast];
      return next.length > MAX_VISIBLE_TOASTS ? next.slice(next.length - MAX_VISIBLE_TOASTS) : next;
    }
    case "dismiss": {
      const next = state.filter((toast) => toast.id !== action.id);
      return next.length === state.length ? state : next;
    }
    case "clear":
      return state.length === 0 ? state : initialToastState;
  }
};
