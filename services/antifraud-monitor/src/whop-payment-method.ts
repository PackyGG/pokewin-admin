import { createHash } from "node:crypto";

export const APPLE_PAY_RISK_MULTIPLIER = 0.8;

const METHOD_KEYS = new Set(["payment_method_type", "paymentMethodType"]);
const CARD_BRAND_KEYS = new Set(["card_brand", "cardBrand"]);
const CARD_LAST4_KEYS = new Set(["card_last4", "cardLast4"]);
const PAYMENT_METHOD_ID_KEYS = new Set([
  "payment_method_id",
  "paymentMethodId",
  "payment_method_token",
  "paymentMethodToken",
  "token_id",
  "tokenId",
]);
const CUSTOMER_ID_KEYS = new Set([
  "customer_id",
  "customerId",
  "whop_user_id",
  "whopUserId",
]);

export type WhopPaymentMethodInfo = {
  type: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  /** Stable non-reversible identities used only for cross-account matching. */
  customerIdHash: string | null;
  paymentMethodIdHash: string | null;
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function identityHash(value: string | null): string | null {
  return value
    ? createHash("sha256").update(value).digest("hex")
    : null;
}

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

function scalarString(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function findValue(
  value: unknown,
  keys: ReadonlySet<string>,
  depth = 0,
): string | null {
  if (!value || typeof value !== "object" || depth > 6) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findValue(entry, keys, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const item = value as Record<string, unknown>;
  for (const key of keys) {
    const match = scalarString(item[key]);
    if (match) return match;
  }
  for (const nested of Object.values(item)) {
    const match = findValue(nested, keys, depth + 1);
    if (match) return match;
  }
  return null;
}

export function whopPaymentMethodInfo(
  ...sources: unknown[]
): WhopPaymentMethodInfo {
  let type: string | null = null;
  let cardBrand: string | null = null;
  let cardLast4: string | null = null;
  let customerId: string | null = null;
  let paymentMethodId: string | null = null;
  for (const source of sources) {
    type ??= normalizeWhopPaymentMethod(findValue(source, METHOD_KEYS));
    cardBrand ??= findValue(source, CARD_BRAND_KEYS)?.toLowerCase() ?? null;
    cardLast4 ??= findValue(source, CARD_LAST4_KEYS);
    // `data.user.id` stays the preferred shape for a raw Whop webhook, but the
    // search must fall back to the whole source like the other three fields do.
    // Restricting it to `source.data` meant a bare `provider_metadata` yielded
    // null hashes, and cross-account payment-identity reuse silently never
    // fired.
    const data = object(object(source).data);
    customerId ??= scalarString(object(data.user).id)
      ?? findValue(source, CUSTOMER_ID_KEYS);
    paymentMethodId ??= findValue(source, PAYMENT_METHOD_ID_KEYS);
  }
  return {
    type,
    cardBrand,
    cardLast4,
    customerIdHash: identityHash(customerId),
    paymentMethodIdHash: identityHash(paymentMethodId),
  };
}

export function whopPaymentMethodFromPayload(
  ...sources: unknown[]
): string | null {
  return whopPaymentMethodInfo(...sources).type;
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
