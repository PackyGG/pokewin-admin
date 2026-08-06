import { z } from "zod";

import type { Config } from "./config.js";

const responseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    user_id: z.string().min(1),
    enabled: z.boolean(),
  }),
});

type UpstreamConfig = Pick<
  Config,
  | "FIAT_ACCESS_API_BASE_URL"
  | "ADMIN_API_KEY"
  | "xbypasssecret"
  | "XBYPASSSECRET"
>;

export class FiatDepositAccessClient {
  constructor(
    private readonly config: UpstreamConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  private endpoint(userId: string): string {
    return `${this.config.FIAT_ACCESS_API_BASE_URL.replace(/\/+$/, "")}/admin/users/${encodeURIComponent(userId)}/fiat-deposit-access`;
  }

  async update(userId: string, enabled: boolean): Promise<boolean> {
    const adminKey = this.config.ADMIN_API_KEY?.trim();
    const bypassSecret = (
      this.config.xbypasssecret ?? this.config.XBYPASSSECRET
    )?.trim();
    if (!adminKey) throw new Error("fiat_deposit_access_admin_key_missing");
    if (!bypassSecret) {
      throw new Error("fiat_deposit_access_bypass_secret_missing");
    }
    const response = await this.request(this.endpoint(userId), {
      method: "PUT",
      headers: {
        "x-api-key": adminKey,
        "x-bypass-secret": bypassSecret,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ enabled }),
      signal: AbortSignal.timeout(8_000),
    });
    const parsed = responseSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!response.ok) {
      throw new Error(`fiat_deposit_access_http_${response.status}`);
    }
    if (!parsed.success || parsed.data.data.user_id !== userId) {
      throw new Error("fiat_deposit_access_invalid_response");
    }
    if (parsed.data.data.enabled !== enabled) {
      throw new Error("fiat_deposit_access_confirmation_mismatch");
    }
    return parsed.data.data.enabled;
  }
}
