"use server";

import { and, count, gt, lte } from "drizzle-orm";
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
const WATERMARK_LAG_MS = 5_000;

type NavAlertCounts = {
  checkedAt: string;
  fiat?: number | null;
  reviews?: number | null;
  signups?: number | null;
};

function boundedSince(value: string, checkedAt: Date): Date {
  const requested = new Date(value);
  const oldest = checkedAt.getTime() - MAX_LOOKBACK_MS;
  return new Date(
    Math.min(
      Math.max(requested.getTime(), oldest),
      checkedAt.getTime(),
    ),
  );
}

async function countCompletedFiatSince(
  since: Date,
  checkedAt: Date,
): Promise<number> {
  const db = await getReadDrizzleDb();
  const rows = await queryRows<{ count: string }[]>(db, sql`
    SELECT LEAST(COUNT(*), ${MAX_BADGE_COUNT})::text AS count
    FROM fiat_deposit_intents
    WHERE status IN (
        'completed',
        'partially_refunded',
        'refunded',
        'disputed'
      )
      AND updated_at > (
        ${since.toISOString()}::timestamptz AT TIME ZONE 'UTC'
      )
      AND updated_at <= (
        ${checkedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'
      )
      AND completed_at > (
        ${since.toISOString()}::timestamptz AT TIME ZONE 'UTC'
      )
      AND completed_at <= (
        ${checkedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'
      )
  `);
  return Number(rows[0]?.count ?? 0);
}

async function countReviewsSince(
  since: Date,
  checkedAt: Date,
): Promise<number> {
  const [row] = await adminDrizzle
    .select({ value: count() })
    .from(antifraud_reviews)
    .where(
      and(
        gt(antifraud_reviews.created_at, since.toISOString()),
        lte(antifraud_reviews.created_at, checkedAt.toISOString()),
      ),
    );
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

  if (parsed.scope === "antifraud") {
    await requireAntifraudAccess();
  } else {
    if (parsed.reviews || parsed.signups) {
      throw new Error("Antifraud badge counts require Antifraud access.");
    }
    await requirePageAccess("/fiat");
  }

  // Every cursor returned to the browser comes from the server clock. Queries
  // use the same value as an inclusive upper bound, so an event cannot fall
  // between "counted" and "marked seen". A small safety lag prevents a row
  // that is still crossing the read replica from being skipped permanently.
  const checkedAt = new Date(Date.now() - WATERMARK_LAG_MS);
  const result: NavAlertCounts = { checkedAt: checkedAt.toISOString() };
  const reads: Promise<void>[] = [];
  if (parsed.fiat) {
    reads.push(
      countCompletedFiatSince(
        boundedSince(parsed.fiat, checkedAt),
        checkedAt,
      )
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
      countReviewsSince(
        boundedSince(parsed.reviews, checkedAt),
        checkedAt,
      )
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
      countAntifraudSignupsSince(
        boundedSince(parsed.signups, checkedAt),
        checkedAt,
      )
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
