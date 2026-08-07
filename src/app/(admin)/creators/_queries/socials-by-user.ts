import "server-only";

import { unstable_cache } from "next/cache";

import { asc, inArray } from "drizzle-orm";
import { adminDrizzle } from "@/lib/drizzle";
import { creator_socials } from "@/lib/db-schema/admin/schema";
import { resolveLinkedHandle } from "@/lib/creator-hub";
import {
  creatorsApi,
  type AdminCreatorSocial,
  type CreatorSocialPlatform,
} from "@/lib/backend-api";

export type CreatorSocialSummary = {
  id: string;
  platform: CreatorSocialPlatform;
  username: string;
  url: string | null;
};

/**
 * Pulls all APPROVED creator socials and returns a Map keyed by user_id.
 * Used by the /creators list page to render social handles inline on
 * each creator card without making N round-trips per page.
 *
 * Backend contract: `listSocials` paginates via offset/limit. The platform
 * has a small number of approved creator socials at any time (single
 * digits or low double-digits per creator × ~20 creators), so a single
 * page of 200 covers everyone in practice. If the platform grows past
 * that, this loop will fetch more — the cap at 1000 is a safety stop.
 */
export async function getApprovedSocialsByUser(): Promise<
  Map<string, CreatorSocialSummary[]>
> {
  const result = new Map<string, CreatorSocialSummary[]>();
  const limit = 200;
  const max = 1000;
  let offset = 0;

  while (offset < max) {
    const { items, total } = await creatorsApi.listSocials({
      status: "approved",
      offset,
      limit,
    });
    for (const s of items) {
      addSocial(result, s);
    }
    offset += limit;
    if (offset >= total || items.length < limit) break;
  }

  return result;
}

/**
 * `discord` is no longer a manual social. The creator↔Discord link now comes
 * from the Discord creator-setup bot (`discord_creator_setups`, exposed by
 * `src/lib/creator-discord-links.ts`), so hand-entered discord rows are never
 * rendered as a social chip. Surviving `creator_socials` discord rows are
 * kept only as the carrier for `reward_page_url`.
 */
export function isRetiredSocialPlatform(platform: string): boolean {
  return platform === "discord";
}

function addSocial(
  map: Map<string, CreatorSocialSummary[]>,
  s: AdminCreatorSocial,
) {
  if (isRetiredSocialPlatform(s.platform)) return;
  const entry: CreatorSocialSummary = {
    id: s.id,
    platform: s.platform,
    username: s.username,
    url: s.url,
  };
  const existing = map.get(s.user_id);
  if (existing) {
    existing.push(entry);
  } else {
    map.set(s.user_id, [entry]);
  }
}

/** True when a `creator_socials.username` is a real linked handle (not empty/pending). */
export function isLinkedSocialUsername(
  username: string | null | undefined,
): boolean {
  const trimmed = username?.trim();
  return Boolean(trimmed && trimmed.toLowerCase() !== "pending");
}

/** Map admin-DB `social_platform` to the roster chip enum (`twitter` → `x`). */
function adminPlatformToChipPlatform(
  platform: string,
): CreatorSocialPlatform {
  if (platform === "twitter") return "x";
  return platform as CreatorSocialPlatform;
}

function profileUrlForPlatform(
  platform: CreatorSocialPlatform,
  username: string,
): string | null {
  const handle = username.trim().replace(/^@+/, "");
  if (!handle) return null;
  switch (platform) {
    case "x":
      return `https://x.com/${encodeURIComponent(handle)}`;
    case "kick":
      return `https://kick.com/${encodeURIComponent(handle)}`;
    case "youtube":
      return `https://youtube.com/@${encodeURIComponent(handle)}`;
    case "instagram":
      return `https://instagram.com/${encodeURIComponent(handle)}`;
    case "tiktok":
      return `https://tiktok.com/@${encodeURIComponent(handle)}`;
    case "twitch":
      return `https://twitch.tv/${encodeURIComponent(handle)}`;
    default:
      return null;
  }
}

/**
 * Linked social handles from ADMIN DB `creator_socials` (manager-entered on
 * the Creator Hub Creator tab). This is the Hub's source of truth; the
 * backend approval queue only covers creator-submitted socials.
 */
async function getAdminDbLinkedSocialsByUser(
  userIds: string[],
): Promise<Map<string, CreatorSocialSummary[]>> {
  const result = new Map<string, CreatorSocialSummary[]>();
  if (userIds.length === 0) return result;

  const rows = await adminDrizzle
    .select({
      id: creator_socials.id,
      target_user_id: creator_socials.target_user_id,
      platform: creator_socials.platform,
      username: creator_socials.username,
    })
    .from(creator_socials)
    .where(inArray(creator_socials.target_user_id, userIds))
    .orderBy(
      asc(creator_socials.target_user_id),
      asc(creator_socials.platform),
    );

  for (const row of rows) {
    if (isRetiredSocialPlatform(row.platform)) continue;
    if (!isLinkedSocialUsername(row.username)) continue;
    const platform = adminPlatformToChipPlatform(row.platform);
    const entry: CreatorSocialSummary = {
      id: row.id,
      platform,
      username: row.username.trim().replace(/^@+/, ""),
      url: profileUrlForPlatform(platform, row.username),
    };
    const existing = result.get(row.target_user_id);
    if (existing) existing.push(entry);
    else result.set(row.target_user_id, [entry]);
  }

  return result;
}

/** Merge admin-DB + backend-approved socials; admin wins per platform. */
function mergeCreatorSocialMaps(
  admin: Map<string, CreatorSocialSummary[]>,
  backend: Map<string, CreatorSocialSummary[]>,
  userIds: string[],
): Map<string, CreatorSocialSummary[]> {
  const merged = new Map<string, CreatorSocialSummary[]>();
  for (const userId of userIds) {
    const byPlatform = new Map<CreatorSocialPlatform, CreatorSocialSummary>();
    for (const s of backend.get(userId) ?? []) {
      byPlatform.set(s.platform, s);
    }
    for (const s of admin.get(userId) ?? []) {
      byPlatform.set(s.platform, s);
    }
    const list = [...byPlatform.values()].sort((a, b) =>
      a.platform.localeCompare(b.platform),
    );
    if (list.length > 0) merged.set(userId, list);
  }
  return merged;
}

/**
 * Social chips for Creator Hub roster cards — admin DB first, backend
 * approval queue as fallback (union per platform, admin wins ties).
 */
export async function getRosterSocialsByUser(
  userIds: string[],
): Promise<Map<string, CreatorSocialSummary[]>> {
  const [admin, backend] = await Promise.all([
    getAdminDbLinkedSocialsByUser(userIds).catch((err) => {
      console.error("[roster] admin DB socials read failed:", err);
      return new Map<string, CreatorSocialSummary[]>();
    }),
    getApprovedSocialsByUser().catch((err) => {
      console.error("[roster] backend socials read failed:", err);
      return new Map<string, CreatorSocialSummary[]>();
    }),
  ]);
  return mergeCreatorSocialMaps(admin, backend, userIds);
}

/**
 * Merged linked socials for one creator — same admin-first + backend-fallback
 * union roster cards use ({@link getRosterSocialsByUser}).
 *
 * NOTE this walks the WHOLE backend approval roster (200/page) to extract
 * one user — fine batched for the roster grid, expensive per-render for a
 * single creator. Single-creator surfaces (creator banner header-socials,
 * hub Creator tab metadata) should use
 * {@link getCreatorLinkedSocialsCached} so repeat renders serve the warmed
 * entry instead of re-walking the roster.
 */
async function getCreatorLinkedSocials(
  userId: string,
): Promise<CreatorSocialSummary[]> {
  const map = await getRosterSocialsByUser([userId]);
  return map.get(userId) ?? [];
}

/**
 * Cache tag for the single-creator linked-socials entries. Flushed by the
 * Creator-Hub social-edit / refetch actions after they write
 * `creator_socials`, so an edit shows up immediately instead of waiting
 * out the TTL (`revalidatePath` alone does NOT bust `unstable_cache`).
 * Static tag per the repo convention — social writes are rare and the
 * cache is tiny, so flushing every user's entry on one edit is fine.
 */
export const CREATOR_LINKED_SOCIALS_CACHE_TAG = "creator-linked-socials";

// 180s TTL — matches the sibling `_cost-cache.ts` reasoning: a stable,
// rarely-changing per-creator read that was being re-paid (admin-DB rows +
// the full backend roster walk) on EVERY banner / metadata render,
// including each `?activityPeriod=` / tab switch. The userId argument is
// folded into the cache key by `unstable_cache`. ADMIN client + backend
// API only inside — no request cookie reads, so caching is env-safe.
const cachedCreatorLinkedSocials = unstable_cache(
  (userId: string): Promise<CreatorSocialSummary[]> =>
    getCreatorLinkedSocials(userId),
  ["creator-linked-socials-v1"],
  { revalidate: 180, tags: [CREATOR_LINKED_SOCIALS_CACHE_TAG] },
);

/** Cached {@link getCreatorLinkedSocials} for single-creator surfaces. */
export async function getCreatorLinkedSocialsCached(
  userId: string,
): Promise<CreatorSocialSummary[]> {
  return cachedCreatorLinkedSocials(userId);
}

/**
 * Resolve one platform's linked handle from merged socials (admin DB wins per
 * platform; backend approved queue is the fallback). Used by Creator Hub
 * detail surfaces (Kick/Twitter tabs, refetch) so they agree with roster cards.
 *
 * Kick RapidAPI expects a lowercased channel **slug** in the path
 * (`/api/v1/channels/{slug}`) — not a full URL. Callers pass the stored
 * username through {@link resolveLinkedHandle}, which strips `@`, extracts the
 * first path segment from pasted `kick.com/…` URLs, and lowercases.
 */
async function getMergedLinkedHandle(
  userId: string,
  platform: "kick" | "twitter",
): Promise<string | null> {
  const chipPlatform: CreatorSocialPlatform =
    platform === "twitter" ? "x" : platform;
  const socials = await getCreatorLinkedSocials(userId);
  const entry = socials.find((s) => s.platform === chipPlatform);
  if (!entry || !isLinkedSocialUsername(entry.username)) return null;
  return resolveLinkedHandle(entry.username);
}
