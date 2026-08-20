import { apiError } from "@/lib/api-auth/with-api-key";
import { VipPerksError } from "@/lib/vip-perks";

export function perksError(error: unknown): Response {
  if (error instanceof VipPerksError) {
    return apiError(error.status, error.code, error.message);
  }
  throw error;
}
