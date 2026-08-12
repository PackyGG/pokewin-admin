import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { getReadDrizzleDb } from "@/lib/db";
import { enqueueKycRequiredReview } from "./kyc-required";
import { enqueueDiscordEvent } from "./router";

const INITIAL_LOOKBACK_DAYS = 30;
const MAX_PER_TICK = 100;
type Cursor = { occurred_at: string; tie_breaker: string };

async function readCursor(stream: string): Promise<Cursor> {
  const result = await adminDrizzle.execute<Cursor>(sql`
    SELECT occurred_at::text, tie_breaker
    FROM kyc_notification_cursors
    WHERE stream = ${stream}
  `);
  return (
    result.rows[0] ?? {
      occurred_at: new Date(
        Date.now() - INITIAL_LOOKBACK_DAYS * 86_400_000,
      ).toISOString(),
      tie_breaker: "",
    }
  );
}

async function advanceCursor(
  stream: string,
  occurredAt: string,
  tieBreaker: string,
): Promise<void> {
  await adminDrizzle.execute(sql`
    INSERT INTO kyc_notification_cursors (stream, occurred_at, tie_breaker)
    VALUES (${stream}, ${occurredAt}::timestamptz, ${tieBreaker})
    ON CONFLICT (stream) DO UPDATE SET
      occurred_at = EXCLUDED.occurred_at,
      tie_breaker = EXCLUDED.tie_breaker,
      updated_at = now()
  `);
}

function safe(value: string | null, max = 128): string {
  return (value?.trim() || "unknown")
    .replace(/@/g, "@\u200b")
    .replace(/[`*_~|>]/g, "\\$&")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, max);
}

type RequiredRow = {
  user_id: string;
  reason: string | null;
  level_name: string | null;
  verification_cycle: number;
  updated_at: string;
};

async function reconcileKycRequired(): Promise<number> {
  const stream = "kyc_required";
  const cursor = await readCursor(stream);
  const db = await getReadDrizzleDb();
  const rows = await db.execute<RequiredRow>(sql`
    SELECT user_id, kyc_required_reason AS reason, level_name,
      verification_cycle, updated_at::text
    FROM user_kyc
    WHERE kyc_required = true
      AND verification_cycle > 0
      AND (updated_at, user_id) >
        (${cursor.occurred_at}::timestamptz, ${cursor.tie_breaker})
    ORDER BY updated_at ASC, user_id ASC
    LIMIT ${MAX_PER_TICK}
  `);

  let queued = 0;
  for (const row of rows.rows) {
    await enqueueKycRequiredReview({
      userId: row.user_id,
      reason: row.reason ?? "KYC review required",
      levelName: row.level_name ?? undefined,
      verificationCycle: row.verification_cycle,
    });
    queued += 1;
    await advanceCursor(stream, row.updated_at, row.user_id);
  }
  return queued;
}

type ReadyRow = {
  user_id: string;
  review_answer: string | null;
  status: string;
  last_webhook_created_at: string;
  last_webhook_digest: string;
};

async function reconcileSumsubReady(): Promise<number> {
  const guildId = process.env.ADMIN_GUILD_ID?.trim();
  if (!guildId) throw new Error("ADMIN_GUILD_ID is not configured");
  const stream = "sumsub_ready";
  const cursor = await readCursor(stream);
  const db = await getReadDrizzleDb();
  const rows = await db.execute<ReadyRow>(sql`
    SELECT user_id, review_answer, status::text,
      last_webhook_created_at::text, last_webhook_digest
    FROM user_kyc
    WHERE applicant_id IS NOT NULL
      AND last_webhook_created_at IS NOT NULL
      AND last_webhook_digest IS NOT NULL
      AND (review_answer IS NOT NULL OR status IN ('approved', 'rejected'))
      AND (last_webhook_created_at, last_webhook_digest) >
        (${cursor.occurred_at}::timestamptz, ${cursor.tie_breaker})
    ORDER BY last_webhook_created_at ASC, last_webhook_digest ASC
    LIMIT ${MAX_PER_TICK}
  `);

  let queued = 0;
  for (const row of rows.rows) {
    const url = new URL("https://fraud.packydash.com/kyc");
    url.searchParams.set("user", row.user_id);
    const result = await enqueueDiscordEvent({
      guildId,
      eventKey: "antifraud.sumsub_ready",
      dedupeKey: `sumsub-ready:${row.last_webhook_digest}`,
      embed: {
        title: "Sumsub result ready",
        description: "A provider result is ready for immediate staff review.",
        url: url.toString(),
        color: row.review_answer === "RED" ? 0xed4245 : 0xf0b232,
        fields: [
          {
            name: "Account",
            value: `User ID \`${safe(row.user_id)}\``,
            inline: true,
          },
          {
            name: "Outcome",
            value: safe(row.review_answer ?? row.status, 80),
            inline: true,
          },
        ],
        footer: { text: "KYC review | PackyGG Fraud" },
        timestamp: new Date(row.last_webhook_created_at).toISOString(),
      },
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: "Open KYC workspace",
              url: url.toString(),
            },
          ],
        },
      ],
    });
    if (result.enqueued + result.duplicate === 0) {
      throw new Error(
        "Sumsub ready notification has no eligible Discord route",
      );
    }
    queued += result.enqueued;
    await advanceCursor(
      stream,
      row.last_webhook_created_at,
      row.last_webhook_digest,
    );
  }
  return queued;
}

export async function reconcileKycLifecycleNotifications(): Promise<{
  required: number;
  ready: number;
}> {
  const [required, ready] = await Promise.all([
    reconcileKycRequired(),
    reconcileSumsubReady(),
  ]);
  return { required, ready };
}

export async function assertKycNotificationDeliveryHealthy(): Promise<void> {
  const result = await adminDrizzle.execute<{
    recent_dead: number;
    overdue: number;
  }>(sql`
    SELECT
      count(*) FILTER (
        WHERE status = 'dead' AND updated_at >= now() - interval '24 hours'
      )::int AS recent_dead,
      count(*) FILTER (
        WHERE status IN ('pending', 'leased')
          AND created_at < now() - interval '10 minutes'
      )::int AS overdue
    FROM discord_notification_jobs
    WHERE event_key IN (
      'antifraud.kyc_required',
      'antifraud.sumsub_started',
      'antifraud.sumsub_ready'
    )
  `);
  const health = result.rows[0] ?? { recent_dead: 0, overdue: 0 };
  if (health.recent_dead > 0 || health.overdue > 0) {
    throw new Error(
      `KYC notification delivery unhealthy: ${health.recent_dead} recent dead, ${health.overdue} overdue`,
    );
  }
}
