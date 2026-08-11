import "server-only";

import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { antifraud_signals } from "@/lib/db-schema/admin/schema";

import { promoteCatchallEmailDomain } from "./fiat-email-domains-api";

const PROMOTION_EVENT = "antifraud_catchall_domain_promoted";

function catchallDomainFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const value = (payload as Record<string, unknown>).emailDomain;
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) &&
    domain.includes(".")
    ? domain
    : null;
}

/** Stable across UI retries and the cron reconciler. */
function promotionIdempotencyKey(reviewId: string, domain: string): string {
  const hex = createHash("sha256")
    .update(`catchall-promotion:${reviewId}:${domain}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

async function promotionRecorded(
  reviewId: string,
  domain: string,
): Promise<boolean> {
  const recorded = await adminDrizzle.execute<{ found: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM admin_audit_events
      WHERE event_type = ${PROMOTION_EVENT}
        AND metadata ->> 'reviewId' = ${reviewId}
        AND metadata ->> 'domain' = ${domain}
    ) AS found
  `);
  return recorded.rows[0]?.found === true;
}

async function recordPromotion(params: {
  reviewId: string;
  domain: string;
  actorId: string;
  targetUserId: string;
  idempotencyKey: string;
}): Promise<void> {
  const metadata = JSON.stringify({
    source: "antifraud_review",
    reviewId: params.reviewId,
    domain: params.domain,
    idempotencyKey: params.idempotencyKey,
  });
  // The production unique index makes concurrent UI/cron reconciliation a
  // harmless no-op after the monitor has confirmed the rule.
  await adminDrizzle.execute(sql`
    INSERT INTO admin_audit_events (
      admin_user_id, event_type, target_user_id, metadata
    ) VALUES (
      ${params.actorId}::uuid,
      ${PROMOTION_EVENT},
      ${params.targetUserId},
      ${metadata}::jsonb
    )
    ON CONFLICT DO NOTHING
  `);
}

export async function promoteConfirmedCatchallDomainsForReview(params: {
  reviewId: string;
  actorId: string;
  actorUsername?: string;
  targetUserId?: string;
}): Promise<{ promoted: number; alreadyPromoted: number }> {
  const signals = await adminDrizzle
    .select({ payload: antifraud_signals.payload })
    .from(antifraud_signals)
    .where(
      and(
        eq(antifraud_signals.review_id, params.reviewId),
        eq(antifraud_signals.kind, "abstract_email_catchall"),
      ),
    );
  const domains = Array.from(
    new Set(
      signals
        .map((signal) => catchallDomainFromPayload(signal.payload))
        .filter((domain): domain is string => domain !== null),
    ),
  );
  let promoted = 0;
  let alreadyPromoted = 0;
  for (const domain of domains) {
    if (await promotionRecorded(params.reviewId, domain)) {
      alreadyPromoted += 1;
      continue;
    }
    const idempotencyKey = promotionIdempotencyKey(params.reviewId, domain);
    await promoteCatchallEmailDomain({
      domain,
      reason: `Confirmed fraudulent catch-all from Account Review ${params.reviewId}`,
      idempotencyKey,
      actorId: params.actorId,
      actorUsername: params.actorUsername,
    });
    await recordPromotion({
      reviewId: params.reviewId,
      domain,
      actorId: params.actorId,
      targetUserId: params.targetUserId ?? "",
      idempotencyKey,
    });
    promoted += 1;
  }
  return { promoted, alreadyPromoted };
}

/** Reconstruct missing work from durable flagged reviews after any outage. */
export async function reconcileConfirmedCatchallPromotions(
  limit = 25,
): Promise<{
  reviewed: number;
  promoted: number;
  failed: number;
}> {
  const candidates = await adminDrizzle.execute<{
    review_id: string;
    actor_id: string;
    target_user_id: string;
  }>(sql`
    SELECT DISTINCT
      review.id::text AS review_id,
      review.resolved_by::text AS actor_id,
      review.target_user_id
    FROM antifraud_reviews AS review
    JOIN antifraud_signals AS signal
      ON signal.review_id = review.id
     AND signal.kind = 'abstract_email_catchall'
    WHERE review.status = 'flagged'
      AND review.resolved_by IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM admin_audit_events AS audit
        WHERE audit.event_type = ${PROMOTION_EVENT}
          AND audit.metadata ->> 'reviewId' = review.id::text
          AND audit.metadata ->> 'domain' = lower(btrim(signal.payload ->> 'emailDomain'))
      )
    ORDER BY review.id::text
    LIMIT ${limit}
  `);

  let reviewed = 0;
  let promoted = 0;
  let failed = 0;
  for (const candidate of candidates.rows) {
    try {
      const result = await promoteConfirmedCatchallDomainsForReview({
        reviewId: candidate.review_id,
        actorId: candidate.actor_id,
        targetUserId: candidate.target_user_id,
      });
      if (result.promoted + result.alreadyPromoted === 0) continue;
      reviewed += 1;
      promoted += result.promoted;
    } catch (error) {
      reviewed += 1;
      failed += 1;
      console.error("[antifraud] catch-all blacklist reconciliation failed", {
        reviewId: candidate.review_id,
        error,
      });
    }
  }
  return { reviewed, promoted, failed };
}
