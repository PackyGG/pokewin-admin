import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { getReadDrizzleDb } from "@/lib/db";
import { enqueueDiscordEvent } from "./router";

/**
 * "Sumsub verification started" alerts.
 *
 * Sumsub writes an `applicantCreated` webhook the moment a player opens the
 * verification flow and an applicant is minted for them, so that row is the
 * signal for "they actually began the process" — not `applicantPending`, which
 * only lands once documents are submitted.
 *
 * MAIN stays strictly read-only here: the tick reads the mirrored webhook log
 * and the delivery job (admin DB) carries all state. The job dedupe index
 * `(guild_id, event_key, dedupe_key, channel_id)` keyed on the webhook digest
 * makes re-scanning the same window a no-op, so no cursor table is needed.
 */
const INITIAL_LOOKBACK_DAYS = 30;
const MAX_PER_TICK = 100;
const STREAM = "sumsub_started";

type StartedRow = {
  digest: string;
  applicant_id: string | null;
  user_id: string | null;
  username: string | null;
  country: string | null;
  level_name: string | null;
  started_at: string;
};

function safeDiscordText(value: string, max: number): string {
  return value
    .replace(/@/g, "@\u200b")
    .replace(/[`*_~|>]/g, "\\$&")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function kycUrl(userId: string | null): string {
  const url = new URL("https://fraud.packydash.com/kyc");
  if (userId) url.searchParams.set("user", userId);
  return url.toString();
}

function startedEmbed(row: StartedRow, url: string) {
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    {
      name: "Account",
      value: row.username
        ? `**${safeDiscordText(row.username, 100)}**\nUser ID \`${safeDiscordText(row.user_id ?? "unknown", 100)}\``
        : `User ID \`${safeDiscordText(row.user_id ?? "unknown", 100)}\``,
      inline: true,
    },
    {
      name: "Level",
      value: safeDiscordText(row.level_name ?? "Unknown level", 100),
      inline: true,
    },
  ];
  if (row.country) {
    fields.push({
      name: "Account country",
      value: safeDiscordText(row.country, 100),
      inline: true,
    });
  }
  // Provider applicant ids stay out of Discord. Staff can open the restricted
  // workspace when provider evidence is required.
  return {
    title: "🪪 Sumsub verification started",
    description:
      "The player opened the Sumsub flow and an applicant was created.",
    url,
    color: 0x5865f2,
    fields,
    footer: { text: "Automated KYC alert | PackyGG Fraud" },
    timestamp: new Date(`${row.started_at.replace(" ", "T")}Z`).toISOString(),
  };
}

export async function enqueueSumsubVerificationStarts(): Promise<{
  inspected: number;
  queued: number;
}> {
  const guildId = process.env.ADMIN_GUILD_ID?.trim();
  if (!guildId) return { inspected: 0, queued: 0 };

  const db = await getReadDrizzleDb();
  const cursor = await adminDrizzle.execute<{
    occurred_at: string;
    tie_breaker: string;
  }>(sql`
    SELECT occurred_at::text, tie_breaker
    FROM kyc_notification_cursors
    WHERE stream = ${STREAM}
  `);
  const occurredAt =
    cursor.rows[0]?.occurred_at ??
    new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86_400_000).toISOString();
  const tieBreaker = cursor.rows[0]?.tie_breaker ?? "";
  const started = await db.execute<StartedRow>(sql`
    SELECT
      event.digest,
      event.applicant_id,
      event.external_user_id AS user_id,
      account.username,
      account.country,
      COALESCE(kyc.level_name, event.payload->>'levelName') AS level_name,
      event.provider_created_at::text AS started_at
    FROM sumsub_webhook_events AS event
    LEFT JOIN "user" AS account
      ON account.id = event.external_user_id
    LEFT JOIN user_kyc AS kyc
      ON kyc.applicant_id = event.applicant_id
    WHERE event.event_type = 'applicantCreated'
      AND (event.provider_created_at, event.digest) >
        (${occurredAt}::timestamptz, ${tieBreaker})
    ORDER BY event.provider_created_at ASC, event.digest ASC
    LIMIT ${MAX_PER_TICK}
  `);

  let queued = 0;
  for (const row of started.rows) {
    const url = kycUrl(row.user_id);
    const result = await enqueueDiscordEvent({
      guildId,
      eventKey: "antifraud.sumsub_started",
      dedupeKey: `sumsub-started:${row.digest}`,
      embed: startedEmbed(row, url),
      components: [
        {
          type: 1,
          components: [{ type: 2, style: 5, label: "Open KYC workspace", url }],
        },
      ],
    });
    if (result.enqueued + result.duplicate === 0) {
      throw new Error(
        "Sumsub started notification has no eligible Discord route",
      );
    }
    queued += result.enqueued;
    await adminDrizzle.execute(sql`
      INSERT INTO kyc_notification_cursors (stream, occurred_at, tie_breaker)
      VALUES (${STREAM}, ${row.started_at}::timestamptz, ${row.digest})
      ON CONFLICT (stream) DO UPDATE SET
        occurred_at = EXCLUDED.occurred_at,
        tie_breaker = EXCLUDED.tie_breaker,
        updated_at = now()
    `);
  }

  return { inspected: started.rows.length, queued };
}
