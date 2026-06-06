import "server-only";

import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import type { CreatorSocialPlatform } from "@/lib/backend-api";
import { getCreatorSocialUrls } from "@/lib/creator-social-urls";
import {
  getCreatorLinkedSocials,
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
};

/**
 * Fetch the full metadata bundle for the Creator tab. Returns null only for a
 * truly unknown user id (no game-DB user row) — the page already resolved the
 * header, so in practice this always returns a record.
 */
export async function getCreatorMetadata(
  userId: string,
): Promise<CreatorMetadata | null> {
  const db = await getDb();

  // ── MAIN (read-only): user record + owned affiliate codes, in parallel.
  const [user, codeRows] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: {
        username: true,
        display_username: true,
        email: true,
        image: true,
        role: true,
        created_at: true,
        country: true,
        state: true,
        city: true,
        referred_by: true,
        affiliate_code_active: true,
      },
    }),
    // The creator's OWN codes live in affiliate_codes (NOT user.affiliate_code,
    // which is the referral cookie they carry from whoever referred THEM).
    db.$queryRawUnsafe<{ code: string }[]>(
      `SELECT code FROM affiliate_codes WHERE user_id = $1 ORDER BY created_at ASC`,
      userId,
    ),
  ]);

  if (!user) return null;

  // Resolve the referrer's display name (best-effort; a missing/over-broad
  // referral id just yields null rather than failing the whole tab).
  let referredByName: string | null = null;
  if (user.referred_by) {
    const referrer = await db.user
      .findUnique({
        where: { id: user.referred_by },
        select: { username: true, display_username: true },
      })
      .catch(() => null);
    referredByName =
      referrer?.display_username ?? referrer?.username ?? null;
  }

  // ── ADMIN: socials + the onboarding audit event, in parallel.
  const [adminSocials, mergedSocials, socialUrls, madeCreatorEvent] =
    await Promise.all([
    adminDb.creator_socials.findMany({
      where: { target_user_id: userId },
      orderBy: { platform: "asc" },
      select: {
        id: true,
        platform: true,
        username: true,
        follower_count: true,
        subscriber_count: true,
        last_fetched_at: true,
      },
    }),
    getCreatorLinkedSocials(userId),
    getCreatorSocialUrls(userId).catch(() => ({
      discordChannelUrl: null,
      rewardPageUrl: null,
    })),
    // The earliest `user_made_creator` event for this target = the initial
    // onboarding. Joined to the acting admin so we can name the manager.
    // `admin_user` is a nullable relation (the actor may have been deleted),
    // so we guard for null below.
    adminDb.admin_audit_events.findFirst({
      where: { event_type: "user_made_creator", target_user_id: userId },
      orderBy: { created_at: "asc" },
      select: {
        created_at: true,
        metadata: true,
        admin_user: {
          select: { username: true, display_username: true, role: true },
        },
      },
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
        madeCreatorEvent.admin_user?.display_username ??
        madeCreatorEvent.admin_user?.username ??
        null,
      managerRole: madeCreatorEvent.admin_user?.role ?? null,
      at: madeCreatorEvent.created_at?.toISOString() ?? null,
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
    createdAt: user.created_at?.toISOString() ?? null,
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
      lastFetchedAt: s.last_fetched_at?.toISOString() ?? null,
    })),
    discordChannelUrl: socialUrls.discordChannelUrl,
    rewardPageUrl: socialUrls.rewardPageUrl,
    onboardedBy,
  };
}
