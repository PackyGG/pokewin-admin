import "server-only";

import { getDb } from "@/lib/db";
import { creatorsApi } from "@/lib/backend-api";
import { toNumber } from "@/lib/utils/decimal";

const PAGE_SIZE = 100;
// Caps the per-creator converted-session walk (same guard as session-windows).
const MAX_PAGES = 10;

/** One fill stream session where the creator withdrew and ended the session. */
export type ConvertedFillSessionRow = {
  sessionId: string;
  dealId: string;
  userId: string;
  username: string | null;
  /** When the creator converted / withdrew from the session (backend). */
  convertedAtIso: string;
  /** `converted_to_raw_usd` — raw USD withdrawn from the session. */
  amountUsd: number;
};

/**
 * Fill-program sessions converted in `[since, now)` — the canonical "creator
 * withdrew from the stream and ended the session" event. Session rows live ONLY
 * in the backend creators API (no MAIN table); this fans out per creator the
 * same way `creator-session-windows.ts` does for wager exclusion.
 *
 * Filters `status = 'converted'` server-side, then keeps rows whose
 * `converted_at` falls inside the window and `converted_to_raw_usd` > 0.
 */
export async function getConvertedFillSessionsInWindow(
  since: Date,
): Promise<ConvertedFillSessionRow[]> {
  const db = await getDb();
  const creators = await db.user.findMany({
    where: { role: "creator" },
    select: { id: true, username: true },
  });
  if (creators.length === 0) return [];

  const sinceMs = since.getTime();
  const settled = await Promise.allSettled(
    creators.map((c) =>
      fetchCreatorConvertedSessions(c.id, c.username, sinceMs),
    ),
  );

  const rows: ConvertedFillSessionRow[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") rows.push(...r.value);
  }
  rows.sort((a, b) => b.convertedAtIso.localeCompare(a.convertedAtIso));
  return rows;
}

export function sumConvertedFillSessions(
  rows: ConvertedFillSessionRow[],
): number {
  return rows.reduce((sum, r) => sum + r.amountUsd, 0);
}

async function fetchCreatorConvertedSessions(
  userId: string,
  username: string | null,
  sinceMs: number,
): Promise<ConvertedFillSessionRow[]> {
  const out: ConvertedFillSessionRow[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await creatorsApi.listSessions(userId, {
      status: "converted",
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    });

    for (const s of res.data) {
      if (s.status !== "converted" || !s.converted_at) continue;
      const convertedMs = Date.parse(s.converted_at);
      if (Number.isNaN(convertedMs) || convertedMs < sinceMs) continue;

      const amountUsd = toNumber(s.converted_to_raw_usd);
      if (amountUsd <= 0) continue;

      out.push({
        sessionId: s.id,
        dealId: s.deal_id,
        userId: s.user_id,
        username,
        convertedAtIso: new Date(convertedMs).toISOString(),
        amountUsd,
      });
    }

    if (res.data.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= res.total) {
      break;
    }
  }

  return out;
}
