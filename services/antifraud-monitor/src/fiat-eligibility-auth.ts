import { BlockList, isIP } from "node:net";

import { safeTokenEqual } from "./auth.js";
import type { Config } from "./config.js";
import { canonicalIp } from "./enrichment.js";

export type FiatEligibilityEnvironment = "dev" | "prod";

type EnvironmentPolicy = {
  environment: FiatEligibilityEnvironment;
  apiKey: string;
  allowlist: IpAllowlist;
};

export type FiatEligibilityAuthentication =
  | { authorized: true; environment: FiatEligibilityEnvironment }
  | { authorized: false; error: "unauthorized" | "source_ip_not_allowed" };

class IpAllowlist {
  private readonly ipv4 = new BlockList();
  private readonly ipv6 = new BlockList();

  constructor(raw: string) {
    const entries = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length === 0) {
      throw new Error("Fiat eligibility IP allowlist must not be empty");
    }
    for (const entry of entries) this.add(entry);
  }

  private add(entry: string): void {
    const [addressPart, prefixPart, ...rest] = entry.split("/");
    if (!addressPart || rest.length > 0) {
      throw new Error(`Invalid Fiat eligibility allowlist entry: ${entry}`);
    }
    const address = canonicalIp(addressPart);
    const family = address ? isIP(address) : 0;
    if (!address || family === 0) {
      throw new Error(`Invalid Fiat eligibility allowlist address: ${entry}`);
    }
    const list = family === 4 ? this.ipv4 : this.ipv6;
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefixPart === undefined) {
      list.addAddress(address, type);
      return;
    }
    if (!/^\d{1,3}$/.test(prefixPart)) {
      throw new Error(`Invalid Fiat eligibility CIDR prefix: ${entry}`);
    }
    const prefix = Number(prefixPart);
    const maximum = family === 4 ? 32 : 128;
    if (prefix < 0 || prefix > maximum) {
      throw new Error(`Invalid Fiat eligibility CIDR prefix: ${entry}`);
    }
    list.addSubnet(address, prefix, type);
  }

  has(input: string): boolean {
    const address = canonicalIp(input);
    if (!address) return false;
    const family = isIP(address);
    if (family === 4) return this.ipv4.check(address, "ipv4");
    if (family === 6) return this.ipv6.check(address, "ipv6");
    return false;
  }
}

export class FiatEligibilityAccess {
  private readonly policies: EnvironmentPolicy[];

  constructor(
    config: Pick<
      Config,
      | "FIAT_ELIGIBILITY_DEV_API_KEY"
      | "FIAT_ELIGIBILITY_PROD_API_KEY"
      | "FIAT_ELIGIBILITY_DEV_ALLOWED_IPS"
      | "FIAT_ELIGIBILITY_PROD_ALLOWED_IPS"
    >,
  ) {
    this.policies = [
      config.FIAT_ELIGIBILITY_DEV_API_KEY
        ? {
            environment: "dev" as const,
            apiKey: config.FIAT_ELIGIBILITY_DEV_API_KEY,
            allowlist: new IpAllowlist(
              config.FIAT_ELIGIBILITY_DEV_ALLOWED_IPS,
            ),
          }
        : null,
      config.FIAT_ELIGIBILITY_PROD_API_KEY
        ? {
            environment: "prod" as const,
            apiKey: config.FIAT_ELIGIBILITY_PROD_API_KEY,
            allowlist: new IpAllowlist(
              config.FIAT_ELIGIBILITY_PROD_ALLOWED_IPS,
            ),
          }
        : null,
    ].filter((policy): policy is EnvironmentPolicy => policy !== null);
  }

  authenticate(token: string, sourceIp: string): FiatEligibilityAuthentication {
    let matched: EnvironmentPolicy | null = null;
    for (const policy of this.policies) {
      if (safeTokenEqual(token, policy.apiKey)) matched = policy;
    }
    if (!matched) return { authorized: false, error: "unauthorized" };
    if (!matched.allowlist.has(sourceIp)) {
      return { authorized: false, error: "source_ip_not_allowed" };
    }
    return { authorized: true, environment: matched.environment };
  }

  configuredEnvironments(): FiatEligibilityEnvironment[] {
    return this.policies.map((policy) => policy.environment);
  }
}
