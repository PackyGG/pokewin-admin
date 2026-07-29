import type { Config } from "./config.js";

export type FiatDepositAccess = {
  enabled: boolean;
};

type FiatDepositAccessResponse =
  | FiatDepositAccess
  | boolean
  | {
      data?: FiatDepositAccess | boolean;
      success?: boolean;
    };

type UpstreamConfig = Pick<
  Config,
  "ADMIN_API_KEY" | "xbypasssecret" | "XBYPASSSECRET"
>;

const FIAT_DEPOSIT_ACCESS_BASE_URL = "https://packy.gg/v1";

function parseAccess(response: FiatDepositAccessResponse): FiatDepositAccess {
  if (typeof response === "boolean") return { enabled: response };
  if (
    response &&
    typeof response === "object" &&
    "enabled" in response &&
    typeof response.enabled === "boolean"
  ) {
    return { enabled: response.enabled };
  }
  const data =
    response && typeof response === "object" && "data" in response
      ? response.data
      : undefined;
  if (typeof data === "boolean") return { enabled: data };
  if (
    data &&
    typeof data === "object" &&
    typeof data.enabled === "boolean"
  ) {
    return { enabled: data.enabled };
  }
  throw new Error("fiat_deposit_access_invalid_response");
}

export class FiatDepositAccessClient {
  constructor(
    private readonly config: UpstreamConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  private endpoint(userId: string): string {
    return `${FIAT_DEPOSIT_ACCESS_BASE_URL}/admin/users/${encodeURIComponent(userId)}/fiat-deposit-access`;
  }

  private headers(hasBody: boolean): Record<string, string> {
    const adminKey = this.config.ADMIN_API_KEY?.trim();
    const bypassSecret = (
      this.config.xbypasssecret ?? this.config.XBYPASSSECRET
    )?.trim();
    if (!adminKey) throw new Error("fiat_deposit_access_admin_key_missing");
    if (!bypassSecret) {
      throw new Error("fiat_deposit_access_bypass_secret_missing");
    }
    return {
      "x-admin-api-key": adminKey,
      xbypasssecret: bypassSecret,
      accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : {}),
    };
  }

  private async execute(
    userId: string,
    method: "GET" | "PUT",
    enabled?: boolean,
  ): Promise<FiatDepositAccess> {
    const response = await this.request(this.endpoint(userId), {
      method,
      headers: this.headers(method === "PUT"),
      body: method === "PUT" ? JSON.stringify({ enabled }) : undefined,
      signal: AbortSignal.timeout(8_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`fiat_deposit_access_http_${response.status}`);
    }
    return parseAccess(body as FiatDepositAccessResponse);
  }

  get(userId: string): Promise<FiatDepositAccess> {
    return this.execute(userId, "GET");
  }

  update(userId: string, enabled: boolean): Promise<FiatDepositAccess> {
    return this.execute(userId, "PUT", enabled);
  }
}
