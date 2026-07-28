export const FIAT_WITHDRAWAL_HOLD_SIGNAL_KIND =
  "fiat_deposit_withdrawal_hold";

export function reviewSignalLabel(signal: string): string {
  return signal === FIAT_WITHDRAWAL_HOLD_SIGNAL_KIND
    ? "Fiat-triggered withdrawal hold"
    : signal;
}

export function isFiatWithdrawalHoldSignal(signal: string): boolean {
  return signal === FIAT_WITHDRAWAL_HOLD_SIGNAL_KIND;
}
