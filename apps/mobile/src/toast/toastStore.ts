/**
 * Toast store — module-level state + the imperative `toast` API.
 *
 * `toast.show("…")` (or the `success`/`error`/`info` shorthands) can be
 * called from anywhere — components, the startup coordinator, future
 * payment/sync workflows — without a hook or context. ToastHost.tsx
 * subscribes via useSyncExternalStore and renders the overlay.
 *
 * Hand-rolled on purpose (no toast library): the whole system is this
 * store, the pure reducer in toastQueue.ts, and one host component.
 */
import type { ToastAction, ToastState, ToastVariant } from "./toastQueue";
import { initialToastState, toastReducer } from "./toastQueue";

export interface ToastOptions {
  readonly variant?: ToastVariant;
  readonly durationMs?: number;
}

/** PoC parity: toasts linger 2.5s (useToasts.ts in linky-poc). */
export const DEFAULT_TOAST_DURATION_MS = 2500;

let state: ToastState = initialToastState;
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const clearTimer = (id: number): void => {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
};

const dispatch = (action: ToastAction): void => {
  const next = toastReducer(state, action);
  if (next === state) return;
  // Tidy up timers of toasts that fell out of the queue (cap or clear).
  for (const toast of state) {
    if (!next.includes(toast)) clearTimer(toast.id);
  }
  state = next;
  for (const listener of listeners) listener();
};

const dismiss = (id: number): void => {
  clearTimer(id);
  dispatch({ type: "dismiss", id });
};

const show = (message: string, options?: ToastOptions): void => {
  const text = message.trim();
  if (text.length === 0) return;

  const id = nextId++;
  const durationMs = options?.durationMs ?? DEFAULT_TOAST_DURATION_MS;
  dispatch({
    type: "add",
    toast: { id, message: text, variant: options?.variant ?? "info", durationMs },
  });
  timers.set(
    id,
    setTimeout(() => dismiss(id), durationMs),
  );
};

/** The app-wide imperative toast API. */
export const toast = {
  show,
  dismiss,
  success: (message: string, options?: Omit<ToastOptions, "variant">) =>
    show(message, { ...options, variant: "success" }),
  error: (message: string, options?: Omit<ToastOptions, "variant">) =>
    show(message, { ...options, variant: "error" }),
  info: (message: string, options?: Omit<ToastOptions, "variant">) =>
    show(message, { ...options, variant: "info" }),
} as const;

/** useSyncExternalStore subscription — consumed by ToastHost only. */
export const subscribeToToasts = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** useSyncExternalStore snapshot — consumed by ToastHost only. */
export const getToastSnapshot = (): ToastState => state;
