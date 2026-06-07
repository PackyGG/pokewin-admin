"use server";

import { requirePageAccess } from "@/lib/dal";
import { creatorsApi } from "@/lib/backend-api";
import { searchExCreatorsForLink } from "./list-ex-creators";

/**
 * A single creator option for a "link a creator" searchable dropdown
 * (e.g. the Leaderboard balance-adjustment in the Adjust-Balance dialog).
 * Serializable primitives only — safe to hand to a client component.
 */
export type CreatorLinkOption = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  /** True when this option is a PAST / ex creator (not currently role=creator). */
  isExCreator?: boolean;
};

/**
 * Search the CANONICAL creator list (the owner-authoritative backend, via
 * `creatorsApi.list`) for a "link a creator" picker. Mirrors the
 * `searchNonCreatorUsers` precedent but the other way round: it returns
 * actual CREATORS (the backend `/admin/creators` index), forwarding the
 * search term to the backend's username/email index so we never pull the
 * whole population client-side.
 *
 * Reuses the SAME source as the /creators page (`listCreatorsForPage` also
 * wraps `creatorsApi.list`) — no new creator-list assembly, no cross-DB
 * join. An empty/short query returns the first page of creators so the
 * dropdown is useful before the admin types anything.
 *
 * Gated behind `/users` page access (this picker is consumed by the
 * Adjust-Balance dialog on /users/[id]).
 */
export async function searchCreatorsForLink(
  search: string,
  limit = 25,
): Promise<CreatorLinkOption[]> {
  await requirePageAccess("/users");

  const trimmed = search.trim();
  // Clamp the limit defensively — the backend `list` accepts an arbitrary
  // limit, but the picker never needs more than a screenful.
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);

  const { data } = await creatorsApi.list({
    search: trimmed.length > 0 ? trimmed : undefined,
    offset: 0,
    limit: safeLimit,
  });

  const current: CreatorLinkOption[] = data.map((c) => ({
    id: c.id,
    username: c.username,
    email: c.email,
    image: c.image,
    isExCreator: false,
  }));

  // Also surface PAST / ex creators so admins can link a Leaderboard (or
  // other creator-linked) adjustment to someone whose creator role was
  // since removed. Failures here must not break the picker — fall back to
  // just the active roster.
  let exCreators: CreatorLinkOption[] = [];
  try {
    const ex = await searchExCreatorsForLink(trimmed, safeLimit);
    exCreators = ex.map((c) => ({
      id: c.id,
      username: c.username,
      email: c.email,
      image: c.image,
      isExCreator: true,
    }));
  } catch {
    exCreators = [];
  }

  // Active creators first, then ex-creators; dedupe by id (a user the
  // backend already returned as active should never re-appear as "past").
  const seen = new Set(current.map((c) => c.id));
  const merged = [...current];
  for (const c of exCreators) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    merged.push(c);
  }

  return merged.slice(0, safeLimit);
}
