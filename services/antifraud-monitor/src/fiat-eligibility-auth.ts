import { safeTokenEqual } from "./auth.js";
import type { Config } from "./config.js";

export type FiatEligibilityEnvironment = "dev" | "prod";

type EnvironmentPolicy = {
  environment: FiatEligibilityEnvironment;
  apiKey: string;
};

export type FiatEligibilityAuthentication =
  | { authorized: true; environment: FiatEligibilityEnvironment }
  | { authorized: false; error: "unauthorized" };

export class FiatEligibilityAccess {
  private readonly policies: EnvironmentPolicy[];

  constructor(
    config: Pick<
      Config,
      | "FIAT_ELIGIBILITY_DEV_API_KEY"
      | "FIAT_ELIGIBILITY_PROD_API_KEY"
    >,
  ) {
    this.policies = [
      config.FIAT_ELIGIBILITY_DEV_API_KEY
        ? {
            environment: "dev" as const,
            apiKey: config.FIAT_ELIGIBILITY_DEV_API_KEY,
          }
        : null,
      config.FIAT_ELIGIBILITY_PROD_API_KEY
        ? {
            environment: "prod" as const,
            apiKey: config.FIAT_ELIGIBILITY_PROD_API_KEY,
          }
        : null,
    ].filter((policy): policy is EnvironmentPolicy => policy !== null);
  }

  authenticate(token: string): FiatEligibilityAuthentication {
    let matched: EnvironmentPolicy | null = null;
    for (const policy of this.policies) {
      if (safeTokenEqual(token, policy.apiKey)) matched = policy;
    }
    if (!matched) return { authorized: false, error: "unauthorized" };
    return { authorized: true, environment: matched.environment };
  }

  configuredEnvironments(): FiatEligibilityEnvironment[] {
    return this.policies.map((policy) => policy.environment);
  }
}
