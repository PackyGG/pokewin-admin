export type Signup = {
  id: string;
  name?: string | null;
  username: string | null;
  email: string | null;
  image: string | null;
  signup_ip: string | null;
  country: string | null;
  country_code: string | null;
  continent_code: string | null;
  state: string | null;
  city: string | null;
  affiliate_code: string | null;
  referred_by: string | null;
  is_suspected_alt: boolean;
  created_at: Date;
  fingerprint_request_id: string | null;
  visitor_id: string | null;
  fingerprint_confidence: number | null;
  fingerprint_ip: string | null;
  user_agent: string | null;
  auth_provider?: string | null;
  auth_providers?: Array<{ provider: string; linkedAt: string | null }>;
  is_creator?: boolean;
};

export const SIGNUP_AUTH_PROVIDERS = [
  "credential",
  "google",
  "discord",
  "steam",
] as const;

export type SignupAuthProvider = (typeof SIGNUP_AUTH_PROVIDERS)[number];

export function signupAuthProvider(
  value: string | null | undefined,
): SignupAuthProvider | "other" | "unknown" {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "unknown";
  if (normalized === "credentials" || normalized === "email") {
    return "credential";
  }
  return (SIGNUP_AUTH_PROVIDERS as readonly string[]).includes(normalized)
    ? normalized as SignupAuthProvider
    : "other";
}

export function isOauthSignupProvider(
  value: string | null | undefined,
): boolean {
  return ["google", "discord", "steam", "other"].includes(
    signupAuthProvider(value),
  );
}

export type Signal = {
  key: string;
  title: string;
  detail: string;
  points: number;
  payload?: Record<string, unknown>;
};

export const LIVE_SCHEMA_VERSION = 1 as const;

export const LIVE_EVENT_TYPES = [
  "signup.assessed",
  "monitor.started",
  "monitor.event",
  "rule.matched",
  "monitor.completed",
  "case.decided",
  "rule.created",
  "rule.updated",
] as const;

export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

export type LiveMessage = {
  schemaVersion: typeof LIVE_SCHEMA_VERSION;
  correlationId: string;
  type: LiveEventType;
  at: string;
  data: Record<string, unknown>;
};

export type ActiveSession = {
  id: string;
  case_id: string;
  user_id: string;
  current_score: number;
  started_at: Date;
  ends_at: Date;
  activity_cursor_at: Date;
  activity_cursor_source: string;
  activity_cursor_ref: string;
};
