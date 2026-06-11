/**
 * Toast system (shell.toast): imperative `toast.show/success/error/info`
 * API + ToastHost overlay mounted in the root layout. Pure queue logic in
 * toastQueue.ts, stateful store in toastStore.ts.
 */
export { toast } from "./toastStore";
export type { ToastOptions } from "./toastStore";
export { ToastHost } from "./ToastHost";
export type { ToastItem, ToastState, ToastVariant } from "./toastQueue";
