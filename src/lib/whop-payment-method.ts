export type WhopPaymentMethodInfo = {
  type: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
};

const METHOD_KEYS = new Set(["payment_method_type", "paymentMethodType"]);
const CARD_BRAND_KEYS = new Set(["card_brand", "cardBrand"]);
const CARD_LAST4_KEYS = new Set(["card_last4", "cardLast4"]);

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

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const match = scalarString(record[key]);
    if (match) return match;
  }
  for (const nested of Object.values(record)) {
    const match = findValue(nested, keys, depth + 1);
    if (match) return match;
  }
  return null;
}

export function normalizeWhopPaymentMethod(value: unknown): string | null {
  const raw = scalarString(value)?.toLowerCase().replaceAll(/[\s-]+/g, "_");
  if (!raw) return null;
  if (raw === "apple" || raw === "applepay") return "apple_pay";
  if (raw === "google" || raw === "googlepay") return "google_pay";
  if (raw === "cash_app" || raw === "cash_app_pay") return "cashapp";
  if (raw === "credit_card") return "card";
  return raw;
}

export function whopPaymentMethodInfo(
  ...sources: unknown[]
): WhopPaymentMethodInfo {
  for (const source of sources) {
    const type = normalizeWhopPaymentMethod(findValue(source, METHOD_KEYS));
    const cardBrand = findValue(source, CARD_BRAND_KEYS)?.toLowerCase() ?? null;
    const cardLast4 = findValue(source, CARD_LAST4_KEYS);
    if (type || cardBrand || cardLast4) {
      return { type, cardBrand, cardLast4 };
    }
  }
  return { type: null, cardBrand: null, cardLast4: null };
}

export function whopPaymentMethodLabel(type: string | null): string {
  switch (normalizeWhopPaymentMethod(type)) {
    case "apple_pay":
      return "Apple Pay";
    case "google_pay":
      return "Google Pay";
    case "cashapp":
      return "Cash App";
    case "card":
      return "Card";
    default:
      return type
        ? type
            .replaceAll("_", " ")
            .replace(/\b\w/g, (letter) => letter.toUpperCase())
        : "Unknown";
  }
}
