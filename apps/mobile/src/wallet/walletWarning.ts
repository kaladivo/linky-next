/**
 * Wallet warning conditions (`wallet.warning`) — pure logic mirroring the
 * PoC: the "Linky is in a very early stage…" banner
 * (walletEarlyWarningTitle/Body) applies only once the spendable balance
 * exceeds 50 000 sat (PoC WALLET_WARNING_BALANCE_THRESHOLD_SAT), and the
 * dismissal resets as soon as the warning stops applying, so it re-arms the
 * next time the balance grows past the threshold.
 *
 * Divergence from the PoC: dismissal is persisted (KeyValueStorage) instead
 * of session-only — issue #36 requires the dismissed state to survive
 * relaunches.
 */
export const WALLET_WARNING_BALANCE_THRESHOLD_SAT = 50_000;

/** The warning condition, independent of dismissal. */
export const walletWarningApplies = (spendableSat: number): boolean =>
  spendableSat > WALLET_WARNING_BALANCE_THRESHOLD_SAT;

/** What the wallet home actually renders. */
export const shouldShowWalletWarning = (spendableSat: number, dismissed: boolean): boolean =>
  walletWarningApplies(spendableSat) && !dismissed;
