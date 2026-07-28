export const APPLE_PAY_RISK_MULTIPLIER = 0.8;

const METHOD_KEYS = new Set(["payment_method_type", "paymentMethodType"]);

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

function findPaymentMethod(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 6) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findPaymentMethod(entry, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const item = value as Record<string, unknown>;
  for (const key of METHOD_KEYS) {
    const match = normalizeWhopPaymentMethod(item[key]);
    if (match) return match;
  }
  for (const nested of Object.values(item)) {
    const match = findPaymentMethod(nested, depth + 1);
    if (match) return match;
  }
  return null;
}

export function whopPaymentMethodFromPayload(
  ...sources: unknown[]
): string | null {
  for (const source of sources) {
    const match = findPaymentMethod(source);
    if (match) return match;
  }
  return null;
}

export function whopPaymentMethodLabel(value: unknown): string {
  const method = normalizeWhopPaymentMethod(value);
  switch (method) {
    case "apple_pay":
      return "Apple Pay";
    case "google_pay":
      return "Google Pay";
    case "cashapp":
      return "Cash App";
    case "card":
      return "Card";
    case null:
      return "Unknown";
    default:
      return method
        .replaceAll("_", " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
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
