export const APPLE_PAY_RISK_MULTIPLIER = 0.8;

export function normalizeWhopPaymentMethod(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replaceAll(/[\s-]+/g, "_");
  if (!normalized) return null;
  if (normalized === "apple" || normalized === "applepay") return "apple_pay";
  if (normalized === "google" || normalized === "googlepay") return "google_pay";
  if (normalized === "cash_app" || normalized === "cash_app_pay") {
    return "cashapp";
  }
  if (normalized === "credit_card") return "card";
  return normalized;
}

export function adjustFiatRiskForPaymentMethod(
  eventType: string,
  payload: Record<string, unknown>,
  basePoints: number,
): number {
  if (
    eventType !== "fiat_deposit" ||
    basePoints <= 0 ||
    normalizeWhopPaymentMethod(payload.fiat_payment_method_type) !== "apple_pay"
  ) {
    return basePoints;
  }
  return Math.round(basePoints * APPLE_PAY_RISK_MULTIPLIER);
}
