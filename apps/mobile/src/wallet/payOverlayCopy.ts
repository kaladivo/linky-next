/**
 * Paid-overlay headline copy for the #39 pay flows ("Sent X sat." /
 * "Sent X sat to NAME.", PoC `paidSent` / `paidSentTo`). Amount text goes
 * through the single formatting authority (`formatAmountParts`), so the
 * hidden-amount mode masks overlay copy too.
 */
import type { Translator } from "@linky/locales";
import type { AmountDisplayUnit } from "@linky/ui/amount";
import { formatAmountParts } from "@linky/ui/amount";

export interface PaidOverlayFormat {
  readonly unit: AmountDisplayUnit;
  readonly hidden: boolean;
  readonly locale: string;
}

export const paidOverlayTitle = (
  t: Translator,
  amountSat: number,
  format: PaidOverlayFormat,
  recipientName?: string,
): string => {
  const parts = formatAmountParts(amountSat, {
    unit: format.unit,
    hidden: format.hidden,
    locale: format.locale,
  });
  const amount = parts.text;
  const unit = parts.unitLabel;
  return recipientName === undefined || recipientName.trim() === ""
    ? t("paidSent", { amount, unit })
    : t("paidSentTo", { amount, unit, name: recipientName.trim() });
};
