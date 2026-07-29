import "server-only";

import Whop, { APIError } from "@whop/sdk";

let client: Whop | null = null;

function apiKey(): string {
  const value =
    process.env.WHOP_ADMIN_KEY?.trim() ?? process.env.WHOP_API_KEY?.trim();
  if (!value) {
    throw new Error("The Whop admin API key is not configured.");
  }
  return value;
}

export function whopAdminClient(): Whop {
  client ??= new Whop({
    apiKey: apiKey(),
    // Whop does not document an idempotency key for refunds. Automatic
    // mutation retries could therefore issue the same refund twice.
    maxRetries: 0,
    timeout: 15_000,
  });
  return client;
}

export type SafeWhopError = {
  code: string;
  message: string;
  outcomeUnknown: boolean;
};

export function safeWhopError(error: unknown): SafeWhopError {
  if (error instanceof APIError) {
    const status = error.status ?? 0;
    return {
      code: status > 0 ? `whop_http_${status}` : "whop_api_error",
      message:
        status === 401 || status === 403
          ? "The Whop key cannot manage this payment."
          : status === 404
            ? "Whop could not find this payment."
            : status === 409 || status === 422
              ? "Whop rejected the refund because the payment is no longer refundable."
              : status >= 500
                ? "Whop had a temporary error. The payment must be reconciled before retrying."
                : "Whop rejected the refund.",
      outcomeUnknown: status === 0 || status >= 500,
    };
  }

  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const networkFailure =
    name === "AbortError" ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("fetch");
  return {
    code: networkFailure ? "whop_network_unknown" : "whop_unexpected_error",
    message: networkFailure
      ? "The Whop response was interrupted. The payment must be reconciled before retrying."
      : "The refund could not be completed.",
    outcomeUnknown: networkFailure,
  };
}
