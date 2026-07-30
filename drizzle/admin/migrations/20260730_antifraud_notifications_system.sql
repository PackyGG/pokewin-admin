-- Fraud-only dashboard notification rules and expanded Discord error catalog.
-- Rules are deliberately not seeded: automatic on-site alerts remain off until
-- an owner/admin creates and enables one in the Fraud workspace.

CREATE TABLE IF NOT EXISTS antifraud_dashboard_notification_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL
    REFERENCES discord_notification_events(event_key) ON DELETE RESTRICT,
  label TEXT NOT NULL,
  minimum_severity TEXT NOT NULL DEFAULT 'medium',
  target_groups TEXT[] NOT NULL,
  title_template TEXT NOT NULL,
  body_template TEXT NOT NULL DEFAULT '',
  href_template TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT antifraud_dashboard_notification_rules_label_check
    CHECK (length(label) BETWEEN 2 AND 100),
  CONSTRAINT antifraud_dashboard_notification_rules_severity_check
    CHECK (minimum_severity IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT antifraud_dashboard_notification_rules_groups_check
    CHECK (
      cardinality(target_groups) BETWEEN 1 AND 7
      AND target_groups <@ ARRAY[
        'owner', 'admin', 'support', 'marketing',
        'creator_manager', 'creator', 'pack_creator'
      ]::TEXT[]
    ),
  CONSTRAINT antifraud_dashboard_notification_rules_title_check
    CHECK (length(title_template) BETWEEN 3 AND 120),
  CONSTRAINT antifraud_dashboard_notification_rules_body_check
    CHECK (length(body_template) <= 1000),
  CONSTRAINT antifraud_dashboard_notification_rules_href_check
    CHECK (
      href_template IS NULL
      OR (
        length(href_template) <= 500
        AND href_template LIKE '/%'
        AND href_template NOT LIKE '//%'
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS antifraud_dashboard_notification_rules_event_label_idx
  ON antifraud_dashboard_notification_rules(event_key, lower(label));
CREATE INDEX IF NOT EXISTS antifraud_dashboard_notification_rules_dispatch_idx
  ON antifraud_dashboard_notification_rules(event_key, minimum_severity)
  WHERE enabled;

INSERT INTO discord_notification_events
  (event_key, label, description, category, is_custom, enabled)
VALUES
  ('antifraud.error.general', 'General error', 'A general Fraud operation failed.', 'Errors', false, true),
  ('antifraud.error.code', 'Code error', 'A Fraud code path raised an actionable error.', 'Errors', false, true),
  ('antifraud.error.failed_action', 'Failed action', 'A Fraud user or system action failed after validation.', 'Errors', false, true),
  ('antifraud.error.timeout', 'Timeout', 'A Fraud dependency or operation timed out.', 'Errors', false, true)
ON CONFLICT (event_key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  is_custom = false,
  updated_at = now();
