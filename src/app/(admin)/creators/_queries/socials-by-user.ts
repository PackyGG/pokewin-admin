import "server-only";

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

function addSocial(
  map: Map<string, CreatorSocialSummary[]>,
  s: AdminCreatorSocial,
) {
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
