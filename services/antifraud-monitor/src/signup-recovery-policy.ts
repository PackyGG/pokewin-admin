import type { EnrichmentResult } from "./enrichment.js";

export const SIGNUP_FAILURE_KINDS = [
  "provider_transient",
  "provider_configuration",
  "transient",
  "invalid_payload",
] as const;

export type SignupFailureKind = typeof SIGNUP_FAILURE_KINDS[number];

type RetryPolicy = {
  maxAttempts: number;
  baseDelaySeconds: number;
  maxDelaySeconds: number;
};

const RETRY_POLICIES: Record<SignupFailureKind, RetryPolicy | null> = {
  provider_transient: {
    maxAttempts: 8,
    baseDelaySeconds: 60,
    maxDelaySeconds: 3_600,
  },
  transient: {
    maxAttempts: 5,
    baseDelaySeconds: 60,
    maxDelaySeconds: 900,
  },
  provider_configuration: null,
  invalid_payload: null,
};

export class SignupRecoveryError extends Error {
  constructor(
    message: string,
    readonly failureKind: SignupFailureKind,
  ) {
    super(message);
    this.name = "SignupRecoveryError";
  }
}

export function providerSignupFailureKind(
  failures: readonly EnrichmentResult[],
): SignupFailureKind {
  const configurationFailure = failures.some((failure) => {
    if (failure.failureKind === "authentication") return true;
    const code = failure.errorCode?.toLowerCase() ?? "";
    return /http_(401|402|403)|not_configured|quota|out.of.(queries|credits|funds)/.test(
      code,
    );
  });
  return configurationFailure
    ? "provider_configuration"
    : "provider_transient";
}

export function classifySignupFailure(error: unknown): SignupFailureKind {
  if (error instanceof SignupRecoveryError) return error.failureKind;
  return "transient";
}

export function signupRetryPolicy(kind: SignupFailureKind): RetryPolicy | null {
  return RETRY_POLICIES[kind];
}

export function signupRetryDelaySeconds(
  kind: SignupFailureKind,
  failureCount: number,
): number | null {
  const policy = signupRetryPolicy(kind);
  if (!policy || failureCount >= policy.maxAttempts) return null;
  return Math.min(
    policy.maxDelaySeconds,
    policy.baseDelaySeconds * 2 ** Math.max(0, failureCount - 1),
  );
}
