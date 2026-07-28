"use server";

import { count, gt } from "drizzle-orm";
import { z } from "zod";

import { adminDrizzle } from "@/lib/admin-db";
import { countAntifraudSignupsSince } from "@/lib/antifraud/signups";
import { antifraud_reviews } from "@/lib/db-schema/admin/schema";
import { getReadDrizzleDb } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import {
  queryRows,
  sql,
} from "@/lib/queries/insights-rewards/_drizzle-query";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";

const requestSchema = z
  .object({
    scope: z.enum(["main", "antifraud"]),
    fiat: z.iso.datetime().optional(),
    reviews: z.iso.datetime().optional(),
    signups: z.iso.datetime().optional(),
  })
  .strict();

const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_BADGE_COUNT = 100;

type NavAlertCounts = {
  fiat?: number | null;
  reviews?: number | null;
  signups?: number | null;
};

function boundedSince(value: string): Date {
  const requested = new Date(value);
  const oldest = Date.now() - MAX_LOOKBACK_MS;
  return new Date(Math.max(requested.getTime(), oldest));
}

async function countCompletedFiatSince(since: Date): Promise<number> {
  const db = await getReadDrizzleDb();
  const rows = await queryRows<{ count: string }[]>(db, sql`
    SELECT LEAST(COUNT(*), ${MAX_BADGE_COUNT})::text AS count
    FROM fiat_deposit_intents
    WHERE status = 'completed'
      AND updated_at > (
        ${since.toISOString()}::timestamptz AT TIME ZONE 'UTC'
      )
  `);
  return Number(rows[0]?.count ?? 0);
}

async function countReviewsSince(since: Date): Promise<number> {
  const [row] = await adminDrizzle
    .select({ value: count() })
    .from(antifraud_reviews)
    .where(gt(antifraud_reviews.created_at, since.toISOString()));
  return Math.min(MAX_BADGE_COUNT, Number(row?.value ?? 0));
}

/**
 * Poll target for the navigation badges.
 *
 * The client supplies only its per-staff "last viewed" timestamps. Each
 * requested area is authorized again here, and every leg fails independently
 * so one unavailable data source cannot erase the other badges.
 */
export async function fetchNavAlertCounts(
  input: unknown,
): Promise<NavAlertCounts> {
  const parsed = requestSchema.parse(input);
  const result: NavAlertCounts = {};

  if (parsed.scope === "antifraud") {
    await requireAntifraudAccess();
  } else {
    if (parsed.reviews || parsed.signups) {
      throw new Error("Antifraud badge counts require Antifraud access.");
    }
    await requirePageAccess("/fiat");
  }

  const reads: Promise<void>[] = [];
  if (parsed.fiat) {
    reads.push(
      countCompletedFiatSince(boundedSince(parsed.fiat))
        .then((value) => {
          result.fiat = value;
        })
        .catch((error) => {
          console.error("[nav-alerts] fiat count failed:", error);
          result.fiat = null;
        }),
    );
  }
  if (parsed.reviews) {
    reads.push(
      countReviewsSince(boundedSince(parsed.reviews))
        .then((value) => {
          result.reviews = value;
        })
        .catch((error) => {
          console.error("[nav-alerts] account review count failed:", error);
          result.reviews = null;
        }),
    );
  }
  if (parsed.signups) {
    reads.push(
      countAntifraudSignupsSince(boundedSince(parsed.signups))
        .then((value) => {
          result.signups = value;
        })
        .catch((error) => {
          console.error("[nav-alerts] signup count failed:", error);
          result.signups = null;
      }),
    );
  }
  await Promise.all(reads);

  return result;
}
