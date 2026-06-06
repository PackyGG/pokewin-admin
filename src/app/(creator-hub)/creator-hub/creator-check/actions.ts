"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";

import { verifySession } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  canAccessCreatorHub,
  getCreatorHubAccessSettings,
} from "@/lib/creator-hub-access";
import {
  runCreatorCheck,
  normalizeHandle,
  isNoKeyConfigured,
} from "@/lib/creator-hub";

import {
  getKickCheckDetail,
  getTwitterCheckDetail,
  type KickCheckDetail,
  type TwitterCheckDetail,
} from "./_queries/check-history";

/**
 * Server actions for the Creator Check recon tool.
 *
 * SECURITY: the only outbound third-party API use lives behind the barrel's
 * server-only services. Every action here re-verifies the session and
 * re-authorizes against the SAME rule that guards the whole Creator Hub
 * (`canAccessCreatorHub`: the founder `motha`, or a viewer whose effective
 * role has its ADMIN-DB toggle enabled), reading the live role/active flag
 * from the ADMIN DB — never trusting client identity. RapidAPI keys are read
 * server-side only and never returned to the client.
 *
 * NO-SPAM: `runCheck` routes through `runCreatorCheck`, whose every sub-fetch
 * is TTL/throttle-gated (served from the ADMIN DB within the window; a forced
 * refresh is still anti-mash floored). There are no loops/pollers here.
 *
 * DB: writes land ONLY in the ADMIN-DB substrate tables (kick_profiles /
 * kick_streams / twitter_profiles / tweets / twitter_mentions) via the barrel.
 * MAIN/prod is never touched.
 */

// ─── Auth helper (mirrors settings/actions.ts) ──────────────────────────────

async function requireCreatorHubAccess(): Promise<{ userId: string }> {
  const session = await verifySession();

  // Re-read the live account so a deactivated user / changed username can't
  // slip through on a stale JWT.
  const user = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { username: true, is_active: true },
  });
  if (!user?.is_active) {
    throw new Error("Not authorized to use Creator Check.");
  }

  const settings = await getCreatorHubAccessSettings();
  const allowed = canAccessCreatorHub(
    { username: user.username, role: session.role, roles: session.roles },
    settings,
  );
  if (!allowed) {
    throw new Error("Not authorized to use Creator Check.");
  }
  return { userId: session.userId };
}

// ─── Input validation ───────────────────────────────────────────────────────

/**
 * Both handles optional, but at least one required (owner spec). We accept the
 * raw input (handles or pasted profile URLs) and let `normalizeHandle` clean
 * it; the Zod step only enforces presence + a sane length cap. The real
 * "is this a usable handle" check is `normalizeHandle` returning non-null.
 */
const checkInputSchema = z
  .object({
    kick: z.string().trim().max(200).optional().nullable(),
    twitter: z.string().trim().max(200).optional().nullable(),
  })
  .refine(
    (v) => Boolean((v.kick ?? "").trim()) || Boolean((v.twitter ?? "").trim()),
    { message: "Enter a Kick username, a Twitter username, or both." },
  );

// ─── Result shapes (serializable — safe to return to the client) ────────────

/** Per-platform outcome flags surfaced to the dialog after a check. */
type PlatformOutcome = {
  /** The normalized handle we actually queried (null = none provided). */
  handle: string | null;
  /** Was the profile found / present in our cache after the check? */
  found: boolean;
  /** The relevant RapidAPI key is not configured in settings. */
  noKey: boolean;
  /** A non-fatal upstream error occurred (served stale/empty). */
  staleError: string | null;
};

export type RunCheckResult =
  | {
      success: true;
      kick: PlatformOutcome;
      twitter: PlatformOutcome;
      /** Convenience for the toast: did we resolve at least one profile? */
      anyFound: boolean;
    }
  | { success: false; error: string };

/**
 * Run a Creator Check for a (kick, twitter) handle pair: fetch ALL available
 * data from both APIs, persist into the ADMIN-DB substrate, and return a
 * serializable summary (the full data renders from the saved rows on the page
 * after revalidate). At least one handle is required.
 */
export async function runCheck(input: {
  kick?: string | null;
  twitter?: string | null;
}): Promise<RunCheckResult> {
  let userId: string;
  try {
    ({ userId } = await requireCreatorHubAccess());
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Not authorized.",
    };
  }

  const parsed = checkInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }

  const kickHandle = normalizeHandle(parsed.data.kick);
  const twitterHandle = normalizeHandle(parsed.data.twitter);

  // A non-empty-but-unparseable handle (e.g. only symbols) normalizes to null.
  // If the user typed something for both fields but neither is usable, fail
  // clearly rather than silently doing nothing.
  if (!kickHandle && !twitterHandle) {
    return {
      success: false,
      error: "That doesn't look like a valid Kick or Twitter handle.",
    };
  }

  // Force a fresh pull on an explicit check (the throttle floor still applies),
  // so "Check" reflects the latest data, saved to the substrate tables.
  const result = await runCreatorCheck(
    { kick: kickHandle, twitter: twitterHandle },
    { force: true },
  );

  const kickOutcome: PlatformOutcome = {
    handle: kickHandle,
    found: Boolean(
      result.kick.profile &&
        result.kick.profile.ok === true &&
        result.kick.profile.profile != null,
    ),
    noKey: isNoKeyConfigured(result.kick.profile),
    staleError:
      result.kick.profile && result.kick.profile.ok === true
        ? (result.kick.profile.staleError ?? null)
        : null,
  };

  const twitterOutcome: PlatformOutcome = {
    handle: twitterHandle,
    found: Boolean(
      result.twitter.profile &&
        result.twitter.profile.ok === true &&
        result.twitter.profile.profile != null,
    ),
    noKey: isNoKeyConfigured(result.twitter.profile),
    staleError:
      result.twitter.profile && result.twitter.profile.ok === true
        ? (result.twitter.profile.staleError ?? null)
        : null,
  };

  // Audit the recon action (handles only — never any key/secret).
  await createAdminAuditEvent({
    adminUserId: userId,
    eventType: "creator_check_run",
    metadata: {
      kick: kickHandle,
      twitter: twitterHandle,
      kickFound: kickOutcome.found,
      twitterFound: twitterOutcome.found,
      via: "creator_hub_creator_check",
    },
  }).catch(() => {
    // Audit is best-effort — never fail the check because the audit insert hit
    // a transient ADMIN-DB issue.
  });

  // Bust the history cache so the new/updated profile boxes show immediately.
  revalidateTag("creator-check-history");
  revalidatePath("/creator-hub/creator-check");

  return {
    success: true,
    kick: kickOutcome,
    twitter: twitterOutcome,
    anyFound: kickOutcome.found || twitterOutcome.found,
  };
}

// ─── Detail fetch (lazy, for the per-profile detail modal) ──────────────────

export type CheckDetailResult =
  | { success: true; platform: "kick"; detail: KickCheckDetail | null }
  | { success: true; platform: "twitter"; detail: TwitterCheckDetail | null }
  | { success: false; error: string };

/**
 * Load the full cached detail for one already-checked handle, on demand (when
 * a manager opens a profile box). DB-served — no forced external fetch, so
 * opening detail never spams the API. Gated like every Hub action.
 */
export async function getCheckDetail(
  platform: "kick" | "twitter",
  rawHandle: string,
): Promise<CheckDetailResult> {
  try {
    await requireCreatorHubAccess();
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Not authorized.",
    };
  }

  const handle = normalizeHandle(rawHandle);
  if (!handle) {
    return { success: false, error: "Invalid handle." };
  }

  try {
    if (platform === "kick") {
      const detail = await getKickCheckDetail(handle);
      return { success: true, platform: "kick", detail };
    }
    const detail = await getTwitterCheckDetail(handle);
    return { success: true, platform: "twitter", detail };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to load detail.",
    };
  }
}

/**
 * Manual Refetch for one already-checked profile box (the per-box Refetch
 * button). Forces a fresh pull for that single platform/handle (throttle floor
 * still applies), persists to the substrate, busts the history cache. Returns
 * the refreshed detail so the modal updates in place.
 */
export async function refetchCheck(
  platform: "kick" | "twitter",
  rawHandle: string,
): Promise<CheckDetailResult> {
  try {
    await requireCreatorHubAccess();
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Not authorized.",
    };
  }

  const handle = normalizeHandle(rawHandle);
  if (!handle) {
    return { success: false, error: "Invalid handle." };
  }

  // Force a fresh pull for just this platform via the shared runner (the other
  // platform stays null → not fetched), then read the refreshed detail.
  await runCreatorCheck(
    platform === "kick" ? { kick: handle } : { twitter: handle },
    { force: true },
  );

  revalidateTag("creator-check-history");
  revalidatePath("/creator-hub/creator-check");

  return getCheckDetail(platform, handle);
}
