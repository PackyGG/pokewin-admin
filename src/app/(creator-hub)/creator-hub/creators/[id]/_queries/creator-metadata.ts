import "server-only";

import { getReadDrizzleDb } from "@/lib/db";
import { and, asc, eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/drizzle";
import {
  admin_audit_events,
  admin_users,
  creator_socials,
} from "@/lib/db-schema/admin/schema";
import {
  affiliate_codes,
  user as mainUsers,
} from "@/lib/db-schema/main/schema";
import type { CreatorSocialPlatform } from "@/lib/backend-api";
import { getCreatorSocialUrls } from "@/lib/creator-social-urls";
import {
  getCreatorLinkedSocialsCached,
  isLinkedSocialUsername,
} from "../../../../../(admin)/creators/_queries/socials-by-user";

/**
 * Data layer for the `creators/[id]` **Creator (metadata)** tab.
 *
 * Gathers ALL of a creator's metadata for the tab in ONE call, merging the
 * two DBs in code (NEVER a cross-DB join):
 *   • MAIN / prod game DB (READ-ONLY): the user record (identity, role,
 *     geo, account dates, referral) + every affiliate code the creator owns
 *     + the referrer's display name (if they were referred by another
 *     creator). Only SELECTed columns the tab renders.
 *   • ADMIN DB: the creator's linked socials (`creator_socials`) and the
 *     "who set this creator up" signal — the earliest `user_made_creator`
 *     audit event for this target user, joined to the acting admin so we can
 *     show which manager onboarded them.
 *
 * Nothing here writes anything; the MAIN reads are plain SELECTs. No data is
 * fabricated — missing admin-DB fields are returned null, never guessed.
 *
 * LAZY: this runs only when the Creator tab is opened (the tab is its own
 * keyed Suspense boundary on the detail page), per the active-tab-only rule.
 */

/** A single editable/linked social handle. */
export type CreatorSocialRow = {
  id: string;
  /** `creator_socials.platform` enum: twitter | youtube | kick | discord | instagram. */
  platform: string;
  username: string;
  followerCount: number | null;
  subscriberCount: number | null;
  lastFetchedAt: string | null;
};

/** Who performed the initial creator onboarding (from the audit trail). */
export type OnboardedBy = {
  /** Manager's display label (display_username → username), or null if the
   *  acting admin row no longer exists / the event had no actor. */
  managerName: string | null;
  /** Manager's admin role (e.g. admin / creator_manager), or null. */
  managerRole: string | null;
  /** When the onboarding event was recorded (ISO), or null. */
  at: string | null;
  /** How the promotion happened, from the event metadata (`via`), or null. */
  via: string | null;
};

export type CreatorMetadata = {
  userId: string;
  // Identity
  username: string | null;
  displayUsername: string | null;
  email: string | null;
  image: string | null;
  role: string;
  // Account
  createdAt: string | null;
  // Geo (from the game DB user record — populated by the signup geo service)
  country: string | null;
  state: string | null;
  city: string | null;
  // Referral — was THIS creator themselves referred by someone?
  referredByUserId: string | null;
  referredByName: string | null;
  // Affiliate codes the creator owns (oldest first; first = primary)
  codes: string[];
  affiliateCodeActive: boolean;
  // Linked socials (admin DB)
  socials: CreatorSocialRow[];
  /** Discord server/channel deep-link (admin DB `creator_socials`). */
  discordChannelUrl: string | null;
  /** Creator reward-page URL (admin DB `creator_socials`). */
  rewardPageUrl: string | null;
  // Who onboarded them (admin audit)
  onboardedBy: OnboardedBy | null;
  /**
   * Human-readable labels for every best-effort leg that FAILED this load
   * (ADMIN-DB socials, backend socials roster, social URLs, onboarding
   * audit). The tab renders these as visible gap chips so a degraded
   * section is never indistinguishable from "no data" — per the
   * no-silent-empty rule. Empty when every leg loaded.
   */
  gaps: string[];
};

/**
 * Fetch the full metadata bundle for the Creator tab. Returns null only for a
 * truly unknown user id (no game-DB user row) — the page already resolved the
 * header, so in practice this always returns a record.
 */
export async function getCreatorMetadata(
  userId: string,
): Promise<CreatorMetadata | null> {
  const db = await getReadDrizzleDb();

  // ── MAIN (read-only): user record + owned affiliate codes, in parallel.
  const [userRows, codeRows] = await Promise.all([
    db
      .select({
        username: mainUsers.username,
        display_username: mainUsers.display_username,
        email: mainUsers.email,
        image: mainUsers.image,
        role: mainUsers.role,
        created_at: mainUsers.created_at,
        country: mainUsers.country,
        state: mainUsers.state,
        city: mainUsers.city,
        referred_by: mainUsers.referred_by,
        affiliate_code_active: mainUsers.affiliate_code_active,
      })
      .from(mainUsers)
      .where(eq(mainUsers.id, userId))
      .limit(1),
    // The creator's OWN codes live in affiliate_codes (NOT user.affiliate_code,
    // which is the referral cookie they carry from whoever referred THEM).
    db
      .select({ code: affiliate_codes.code })
      .from(affiliate_codes)
      .where(eq(affiliate_codes.user_id, userId))
      .orderBy(asc(affiliate_codes.created_at)),
  ]);
  const user = userRows[0];

  if (!user) return null;

  // Resolve the referrer's display name (best-effort; a missing/over-broad
  // referral id just yields null rather than failing the whole tab).
  let referredByName: string | null = null;
  if (user.referred_by) {
    const referrer = await db
      .select({
        username: mainUsers.username,
        display_username: mainUsers.display_username,
      })
      .from(mainUsers)
      .where(eq(mainUsers.id, user.referred_by))
      .limit(1)
      .then((rows) => rows[0] ?? null)
      .catch(() => null);
    referredByName =
      referrer?.display_username ?? referrer?.username ?? null;
  }

  // ── ADMIN: socials + the onboarding audit event, in parallel.
  //
  // Every leg here is BEST-EFFORT (mirrors `alt-accounts-data.ts`): an
  // ADMIN-DB or backend blip used to throw straight through the tab —
  // now it degrades THAT leg to empty/null and records a human-readable
  // gap label the tab renders as a visible chip. The MAIN identity reads
  // above stay raw on purpose: without them the tab is meaningless, and
  // the tab component's own `safeQueryOrNull` wrapper turns that into a
  // visible band instead of a crash.
  const gaps: string[] = [];
  const [adminSocials, mergedSocials, socialUrls, madeCreatorEvent] =
    await Promise.all([
    adminDrizzle
      .select({
        id: creator_socials.id,
        platform: creator_socials.platform,
        username: creator_socials.username,
        follower_count: creator_socials.follower_count,
        subscriber_count: creator_socials.subscriber_count,
        last_fetched_at: creator_socials.last_fetched_at,
      })
      .from(creator_socials)
      .where(eq(creator_socials.target_user_id, userId))
      .orderBy(asc(creator_socials.platform))
      .catch((err: unknown) => {
      console.error(
        "[creator-hub.creators.metadata] admin-DB socials read failed:",
        err,
      );
      gaps.push("Social stats (admin DB) unavailable");
      return [] as never[];
    }),
    // Cached (180s, tag-flushed on social edits) — the uncached helper
    // re-walked the entire backend roster per tab render.
    getCreatorLinkedSocialsCached(userId).catch((err: unknown) => {
      console.error(
        "[creator-hub.creators.metadata] linked-socials roster read failed:",
        err,
      );
      gaps.push("Backend socials unavailable");
      return [] as Awaited<ReturnType<typeof getCreatorLinkedSocialsCached>>;
    }),
    getCreatorSocialUrls(userId).catch((err: unknown) => {
      console.error(
        "[creator-hub.creators.metadata] social URLs read failed:",
        err,
      );
      gaps.push("Discord / reward-page links unavailable");
      return { discordChannelUrl: null, rewardPageUrl: null };
    }),
    // The earliest `user_made_creator` event for this target = the initial
    // onboarding. Joined to the acting admin so we can name the manager.
    // `admin_user` is a nullable relation (the actor may have been deleted),
    // so we guard for null below.
    adminDrizzle
      .select({
        created_at: admin_audit_events.created_at,
        metadata: admin_audit_events.metadata,
        adminUsername: admin_users.username,
        adminDisplayUsername: admin_users.display_username,
        adminRole: admin_users.role,
      })
      .from(admin_audit_events)
      .leftJoin(admin_users, eq(admin_users.id, admin_audit_events.admin_user_id))
      .where(
        and(
          eq(admin_audit_events.event_type, "user_made_creator"),
          eq(admin_audit_events.target_user_id, userId),
        ),
      )
      .orderBy(asc(admin_audit_events.created_at))
      .limit(1)
      .then((rows) => rows[0] ?? null)
      .catch((err: unknown) => {
      console.error(
        "[creator-hub.creators.metadata] onboarding audit read failed:",
        err,
      );
      gaps.push("Onboarding record unavailable");
      return null;
    }),
  ]);

  const adminByChip = new Map<
    CreatorSocialPlatform,
    (typeof adminSocials)[number]
  >();
  for (const row of adminSocials) {
    const chip: CreatorSocialPlatform =
      row.platform === "twitter" ? "x" : (row.platform as CreatorSocialPlatform);
    adminByChip.set(chip, row);
  }

  const socials = mergedSocials
    .filter((s) => isLinkedSocialUsername(s.username))
    .map((s) => {
      const admin = adminByChip.get(s.platform);
      return {
        id: admin?.id ?? s.id,
        platform: s.platform === "x" ? "twitter" : s.platform,
        username: s.username,
        follower_count: admin?.follower_count ?? null,
        subscriber_count: admin?.subscriber_count ?? null,
        last_fetched_at: admin?.last_fetched_at ?? null,
      };
    })
    .sort((a, b) => a.platform.localeCompare(b.platform));

  let onboardedBy: OnboardedBy | null = null;
  if (madeCreatorEvent) {
    const meta = madeCreatorEvent.metadata as
      | Record<string, unknown>
      | null
      | undefined;
    const via =
      meta && typeof meta.via === "string" ? (meta.via as string) : null;
    onboardedBy = {
      managerName:
        madeCreatorEvent.adminDisplayUsername ??
        madeCreatorEvent.adminUsername ??
        null,
      managerRole: madeCreatorEvent.adminRole,
      at: madeCreatorEvent.created_at
        ? new Date(madeCreatorEvent.created_at).toISOString()
        : null,
      via,
    };
  }

  return {
    userId,
    username: user.username,
    displayUsername: user.display_username,
    email: user.email,
    image: user.image,
    role: user.role,
    createdAt: user.created_at
      ? new Date(user.created_at).toISOString()
      : null,
    country: user.country,
    state: user.state,
    city: user.city,
    referredByUserId: user.referred_by,
    referredByName,
    codes: codeRows.map((r) => r.code),
    affiliateCodeActive: user.affiliate_code_active ?? false,
    socials: socials.map((s) => ({
      id: s.id,
      platform: s.platform,
      username: s.username,
      followerCount: s.follower_count,
      subscriberCount: s.subscriber_count,
      lastFetchedAt: s.last_fetched_at
        ? new Date(s.last_fetched_at).toISOString()
        : null,
    })),
    discordChannelUrl: socialUrls.discordChannelUrl,
    rewardPageUrl: socialUrls.rewardPageUrl,
    onboardedBy,
    gaps,
  };
}
