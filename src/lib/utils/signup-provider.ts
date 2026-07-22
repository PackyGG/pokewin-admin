/**
 * Display helpers for the BetterAuth `account.providerId` — i.e. HOW a user
 * signed up (Discord / Google / Steam OAuth, or email+password).
 *
 * The signup provider is resolved as the user's EARLIEST `account` row
 * (`ORDER BY created_at ASC NULLS LAST`) — see users-detail.ts
 * (`signupProvider`) and the users-list page hydration, which both use that
 * same definition.
 *
 * Live prod distribution (read-only probe, 2026-07-22): discord, credential,
 * google, steam — every user has at least one account row.
 */

/**
 * Pretty-print a `providerId`. Maps the common OAuth provider ids to
 * capitalised display names and treats the email/password provider
 * (`credential` or `credentials`, depending on BetterAuth version) as plain
 * "Email". Unknown providers are surfaced verbatim so we never hide data.
 */
export function formatSignupProvider(provider: string | null): string {
  if (!provider) return "-";
  const key = provider.toLowerCase();
  switch (key) {
    case "credential":
    case "credentials":
    case "email":
    case "email-password":
      return "Email";
    case "discord":
      return "Discord";
    case "google":
      return "Google";
    case "steam":
      return "Steam";
    case "twitch":
      return "Twitch";
    case "github":
      return "GitHub";
    case "apple":
      return "Apple";
    case "facebook":
      return "Facebook";
    default:
      return provider;
  }
}

/**
 * Badge classes per provider, same token shape as ROLE_COLORS /
 * USER_STATUS_COLORS in src/lib/constants.ts. Keyed by the LOWERCASED raw
 * `providerId`; use {@link signupProviderBadgeClass} so unknown providers
 * fall back to the neutral zinc chip instead of rendering unstyled.
 */
export const SIGNUP_PROVIDER_COLORS: Record<string, string> = {
  discord: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30",
  google: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  steam: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  twitch: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  credential: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  credentials: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  email: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  "email-password": "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

const SIGNUP_PROVIDER_FALLBACK_COLOR =
  "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30";

/** Badge classes for a raw `providerId`, neutral chip for anything unknown. */
export function signupProviderBadgeClass(provider: string | null): string {
  if (!provider) return SIGNUP_PROVIDER_FALLBACK_COLOR;
  return (
    SIGNUP_PROVIDER_COLORS[provider.toLowerCase()] ??
    SIGNUP_PROVIDER_FALLBACK_COLOR
  );
}
