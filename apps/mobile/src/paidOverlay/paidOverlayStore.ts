/**
 * Paid overlay store (`shell.paid-overlay`) — module-level state + the
 * imperative `paidOverlay` API, mirroring the toast system's shape.
 *
 * `paidOverlay.show()` (optionally with a title like "Sent 1 000 sat.") can
 * be called from anywhere — Cashu/Lightning success workflows later, the
 * dev settings demo today — without a hook or context. PaidOverlayHost.tsx
 * subscribes via useSyncExternalStore and renders the full-screen
 * check-mark sheet; the overlay auto-dismisses after 3s (PoC
 * usePaidOverlayState timing).
 */
export interface PaidOverlayState {
  readonly visible: boolean;
  /** Custom headline; null means the localized default ("Paid"). */
  readonly title: string | null;
}

/** PoC parity: the paid sheet lingers 3s (usePaidOverlayState.ts). */
export const PAID_OVERLAY_DURATION_MS = 3000;

const HIDDEN_STATE: PaidOverlayState = { visible: false, title: null };

let state: PaidOverlayState = HIDDEN_STATE;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const setState = (next: PaidOverlayState): void => {
  state = next;
  for (const listener of listeners) listener();
};

const clearTimer = (): void => {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
};

const dismiss = (): void => {
  clearTimer();
  if (state.visible) setState(HIDDEN_STATE);
};

/** Shows the overlay (restarting the auto-dismiss timer when re-shown). */
const show = (title?: string): void => {
  clearTimer();
  setState({ visible: true, title: title?.trim() ? title.trim() : null });
  timer = setTimeout(dismiss, PAID_OVERLAY_DURATION_MS);
};

/** The app-wide imperative paid-overlay API (like `toast`). */
export const paidOverlay = { show, dismiss } as const;

/** useSyncExternalStore subscription — consumed by PaidOverlayHost only. */
export const subscribeToPaidOverlay = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** useSyncExternalStore snapshot — consumed by PaidOverlayHost only. */
export const getPaidOverlaySnapshot = (): PaidOverlayState => state;
