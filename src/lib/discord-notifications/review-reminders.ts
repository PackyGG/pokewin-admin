import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { enqueueDiscordEvent } from "./router";
import { REVIEW_REMINDER_DELAYS_MS } from "./antifraud-policy";
import { buildReviewReminderMessage } from "./review-reminder-card";

const MAX_REMINDERS_PER_TICK = 25;

type DueReminder = {
  review_id: string;
  target_user_id: string;
  target_username: string | null;
  assigned_to: string | null;
  assigned_staff_username: string | null;
  opened_staff_username: string | null;
  reminder_kind: "normal" | "urgent" | "postponed";
  queue_state: "priority" | "normal" | "waiting_kyc" | null;
  next_reminder_at: string;
  lease_token: string;
};

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
      review.assigned_to::text,
      assignee.username AS assigned_staff_username,
      opener.username AS opened_staff_username,
      reminder.reminder_kind,
      workflow.queue_state,
      reminder.next_reminder_at::text,
      reminder.lease_token::text
    FROM claimed AS reminder
    JOIN antifraud_reviews AS review ON review.id = reminder.review_id
    LEFT JOIN admin_users AS assignee ON assignee.id = review.assigned_to
    LEFT JOIN admin_users AS opener ON opener.id = review.opened_by
    LEFT JOIN antifraud_review_workflow AS workflow
      ON workflow.review_id = reminder.review_id
    ORDER BY reminder.next_reminder_at, reminder.review_id
  `);

  let queued = 0;
  for (const row of due.rows) {
    const correlationId = randomUUID();
    const message = buildReviewReminderMessage(
      {
        reviewId: row.review_id,
        targetUserId: row.target_user_id,
        targetUsername: row.target_username,
        staffAction: row.assigned_to ? "claimed" : "started",
        staffUsername: row.assigned_to
          ? row.assigned_staff_username ?? "Unknown staff"
          : row.opened_staff_username,
      },
      correlationId,
    );
    const result = await enqueueDiscordEvent({
      guildId: process.env.ADMIN_GUILD_ID ?? "",
      eventKey: "antifraud.review_reminder",
      dedupeKey: `review-reminder:${row.review_id}:${row.next_reminder_at}`,
      // The destination channel's selection is the complete tag list, even for
      // urgent reminders.
      embed: message.embed,
      components: message.components,
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
