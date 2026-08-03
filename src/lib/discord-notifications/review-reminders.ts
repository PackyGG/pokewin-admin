import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { enqueueDiscordEvent } from "./router";
import { REVIEW_REMINDER_DELAYS_MS } from "./antifraud-policy";

const MAX_REMINDERS_PER_TICK = 25;

type DueReminder = {
  review_id: string;
  target_user_id: string;
  target_username: string | null;
  reason: string;
  reminder_kind: "normal" | "urgent" | "postponed";
  queue_state: "priority" | "normal" | "waiting_kyc" | null;
  next_reminder_at: string;
  lease_token: string;
};

function reviewUrl(reviewId: string): string {
  const url = new URL("https://fraud.packydash.com/reviews");
  url.searchParams.set("review", reviewId);
  return url.toString();
}

function safeDiscordText(value: string, max: number): string {
  return value
    .replace(/@/g, "@\u200b")
    .replace(/[`*_~|>]/g, "\\$&")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function reminderEmbed(row: DueReminder, correlationId: string) {
  const url = reviewUrl(row.review_id);
  return {
    title:
      row.reminder_kind === "urgent"
        ? "🚨 Urgent account review reminder"
        : "⏰ Account review reminder",
    description:
      "This account review is still unresolved and needs a staff decision.",
    url,
    color: row.reminder_kind === "urgent" ? 0xed4245 : 0x5865f2,
    fields: [
      {
        name: "Account",
        value: row.target_username
          ? `**${safeDiscordText(row.target_username, 100)}**\nUser ID \`${safeDiscordText(row.target_user_id, 100)}\``
          : `User ID \`${safeDiscordText(row.target_user_id, 100)}\``,
        inline: true,
      },
      {
        name: "Queue",
        value:
          row.queue_state === "priority"
            ? "High priority"
            : row.queue_state === "waiting_kyc"
              ? "Waiting KYC"
              : "Normal review",
        inline: true,
      },
      {
        name: "Reason",
        value: safeDiscordText(row.reason, 900),
        inline: false,
      },
    ],
    footer: { text: `Correlation ${correlationId}` },
    timestamp: new Date().toISOString(),
  };
}

export async function enqueueDueReviewReminders(): Promise<{
  inspected: number;
  queued: number;
}> {
  await adminDrizzle.execute(sql`
    INSERT INTO antifraud_review_reminder_state (
      review_id, reminder_kind, next_reminder_at
    )
    SELECT
      review.id,
      CASE
        WHEN workflow.queue_state IN ('priority', 'waiting_kyc')
          THEN 'urgent'
        ELSE 'normal'
      END,
      review.created_at + interval '2 hours'
    FROM antifraud_reviews AS review
    LEFT JOIN antifraud_review_workflow AS workflow
      ON workflow.review_id = review.id
    WHERE review.status IN ('open', 'in_review', 'escalated')
    ON CONFLICT (review_id) DO NOTHING
  `);

  const due = await adminDrizzle.execute<DueReminder>(sql`
    WITH candidates AS (
      SELECT reminder.review_id
      FROM antifraud_review_reminder_state AS reminder
      JOIN antifraud_reviews AS review ON review.id = reminder.review_id
      LEFT JOIN antifraud_review_workflow AS workflow
        ON workflow.review_id = reminder.review_id
      WHERE review.status IN ('open', 'in_review', 'escalated')
        AND reminder.next_reminder_at <= now()
        AND NOT COALESCE(workflow.postponed_until > now(), false)
        AND (
          reminder.leased_until IS NULL
          OR reminder.leased_until < now()
        )
      ORDER BY reminder.next_reminder_at, reminder.review_id
      FOR UPDATE OF reminder SKIP LOCKED
      LIMIT ${MAX_REMINDERS_PER_TICK}
    ),
    claimed AS (
      UPDATE antifraud_review_reminder_state AS reminder
      SET
        lease_token = gen_random_uuid(),
        leased_until = now() + interval '60 seconds',
        updated_at = now()
      FROM candidates
      WHERE reminder.review_id = candidates.review_id
      RETURNING reminder.*
    )
    SELECT
      review.id::text AS review_id,
      review.target_user_id,
      review.target_username,
      review.reason,
      reminder.reminder_kind,
      workflow.queue_state,
      reminder.next_reminder_at::text,
      reminder.lease_token::text
    FROM claimed AS reminder
    JOIN antifraud_reviews AS review ON review.id = reminder.review_id
    LEFT JOIN antifraud_review_workflow AS workflow
      ON workflow.review_id = reminder.review_id
    ORDER BY reminder.next_reminder_at, reminder.review_id
  `);

  let queued = 0;
  for (const row of due.rows) {
    const correlationId = randomUUID();
    const result = await enqueueDiscordEvent({
      guildId: process.env.ADMIN_GUILD_ID ?? "",
      eventKey: "antifraud.review_reminder",
      dedupeKey: `review-reminder:${row.review_id}:${row.next_reminder_at}`,
      // Who gets tagged is the destination channel's own configuration now;
      // urgent reminders escalate on top of it.
      escalate: row.reminder_kind === "urgent",
      embed: reminderEmbed(row, correlationId),
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: "Review account",
              url: reviewUrl(row.review_id),
            },
          ],
        },
      ],
    });
    if (result.enqueued + result.duplicate === 0) continue;
    queued += result.enqueued;
    const delay =
      row.queue_state === "priority" || row.queue_state === "waiting_kyc"
        ? REVIEW_REMINDER_DELAYS_MS.urgent
        : REVIEW_REMINDER_DELAYS_MS.normal;
    await adminDrizzle.execute(sql`
      UPDATE antifraud_review_reminder_state
      SET
        last_sent_at = now(),
        sent_count = sent_count + 1,
        next_reminder_at = now() + (${delay}::bigint * interval '1 millisecond'),
        reminder_kind = CASE
          WHEN EXISTS (
            SELECT 1
            FROM antifraud_review_workflow AS workflow
            WHERE workflow.review_id = ${row.review_id}::uuid
              AND workflow.queue_state IN ('priority', 'waiting_kyc')
          ) THEN 'urgent'
          ELSE 'normal'
        END,
        lease_token = NULL,
        leased_until = NULL,
        updated_at = now()
      WHERE review_id = ${row.review_id}::uuid
        AND lease_token = ${row.lease_token}::uuid
    `);
  }

  return { inspected: due.rows.length, queued };
}
