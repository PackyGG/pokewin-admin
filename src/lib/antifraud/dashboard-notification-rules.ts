import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import type {
  AntifraudDashboardEventOption,
  AntifraudDashboardGroup,
  AntifraudDashboardNotificationRule,
  AntifraudSeverity,
} from "./dashboard-notification-contract";

export async function listAntifraudDashboardNotificationRules(): Promise<{
  rules: AntifraudDashboardNotificationRule[];
  events: AntifraudDashboardEventOption[];
}> {
  const [rulesResult, eventsResult] = await Promise.all([
    adminDrizzle.execute<{
      id: string;
      event_key: string;
      event_label: string;
      label: string;
      minimum_severity: AntifraudSeverity;
      target_groups: AntifraudDashboardGroup[];
      title_template: string;
      body_template: string;
      href_template: string | null;
      enabled: boolean;
      updated_at: string;
    }>(sql`
      SELECT
        rule.id::text,
        rule.event_key,
        event.label AS event_label,
        rule.label,
        rule.minimum_severity,
        rule.target_groups,
        rule.title_template,
        rule.body_template,
        rule.href_template,
        rule.enabled,
        rule.updated_at::text
      FROM antifraud_dashboard_notification_rules AS rule
      JOIN discord_notification_events AS event
        ON event.event_key = rule.event_key
      ORDER BY rule.enabled DESC, rule.updated_at DESC, rule.id DESC
      LIMIT 250
    `),
    adminDrizzle.execute<{
      event_key: string;
      label: string;
      category: string;
    }>(sql`
      SELECT event_key, label, category
      FROM discord_notification_events
      WHERE enabled = true
        AND event_key LIKE 'antifraud.%'
      ORDER BY category, label, event_key
      LIMIT 500
    `),
  ]);

  return {
    rules: rulesResult.rows.map((row) => ({
      id: row.id,
      eventKey: row.event_key,
      eventLabel: row.event_label,
      label: row.label,
      minimumSeverity: row.minimum_severity,
      targetGroups: row.target_groups,
      titleTemplate: row.title_template,
      bodyTemplate: row.body_template,
      hrefTemplate: row.href_template,
      enabled: row.enabled,
      updatedAt: row.updated_at,
    })),
    events: eventsResult.rows.map((row) => ({
      key: row.event_key,
      label: row.label,
      category: row.category,
    })),
  };
}

export async function createAntifraudDashboardNotificationRule(input: {
  eventKey: string;
  label: string;
  minimumSeverity: AntifraudSeverity;
  targetGroups: AntifraudDashboardGroup[];
  titleTemplate: string;
  bodyTemplate: string;
  hrefTemplate: string | null;
  enabled: boolean;
  actorId: string;
}): Promise<string> {
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    INSERT INTO antifraud_dashboard_notification_rules (
      event_key, label, minimum_severity, target_groups,
      title_template, body_template, href_template, enabled,
      created_by, updated_by
    )
    SELECT
      event.event_key,
      ${input.label},
      ${input.minimumSeverity},
      ARRAY(
        SELECT jsonb_array_elements_text(
          ${JSON.stringify(input.targetGroups)}::jsonb
        )
      ),
      ${input.titleTemplate},
      ${input.bodyTemplate},
      ${input.hrefTemplate},
      ${input.enabled},
      ${input.actorId}::uuid,
      ${input.actorId}::uuid
    FROM discord_notification_events AS event
    WHERE event.event_key = ${input.eventKey}
      AND event.enabled = true
      AND event.event_key LIKE 'antifraud.%'
    RETURNING id::text
  `);
  const row = result.rows[0];
  if (!row) throw new Error("That Fraud event is not available.");
  return row.id;
}

export async function setAntifraudDashboardNotificationRuleEnabled(input: {
  id: string;
  enabled: boolean;
  actorId: string;
}): Promise<void> {
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    UPDATE antifraud_dashboard_notification_rules
    SET
      enabled = ${input.enabled},
      updated_by = ${input.actorId}::uuid,
      updated_at = now()
    WHERE id = ${input.id}::uuid
    RETURNING id::text
  `);
  if (result.rows.length !== 1) throw new Error("Dashboard rule not found.");
}

export async function deleteAntifraudDashboardNotificationRule(
  id: string,
): Promise<void> {
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    DELETE FROM antifraud_dashboard_notification_rules
    WHERE id = ${id}::uuid
    RETURNING id::text
  `);
  if (result.rows.length !== 1) throw new Error("Dashboard rule not found.");
}
