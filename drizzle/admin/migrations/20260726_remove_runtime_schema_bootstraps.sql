CREATE TABLE IF NOT EXISTS pack_set_assignments (
  pack_id uuid PRIMARY KEY,
  pack_set text NOT NULL,
  set_by_admin_id uuid,
  created_at timestamptz(6) DEFAULT now() NOT NULL,
  updated_at timestamptz(6) DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS pack_set_assignments_pack_set_idx
  ON pack_set_assignments (pack_set);

CREATE TABLE IF NOT EXISTS admin_changelog_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  published_at timestamptz(6) NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  version text,
  category text NOT NULL,
  changes jsonb DEFAULT '[]'::jsonb NOT NULL,
  author_admin_user_id uuid,
  created_at timestamptz(6) DEFAULT now() NOT NULL,
  updated_at timestamptz(6) DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_changelog_entries_published_at_idx
  ON admin_changelog_entries (published_at DESC);

CREATE TABLE IF NOT EXISTS admin_balance_adjustment_meta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  admin_user_id varchar(36) NOT NULL,
  target_user_id varchar(36) NOT NULL,
  ledger_tx_id varchar(36) NOT NULL,
  category varchar(40) NOT NULL,
  amount_usd numeric(20, 2) NOT NULL,
  coin_type varchar(64),
  tx_hash varchar(255),
  social_link varchar(2048),
  reason_text text,
  lossback_pct numeric(7, 2),
  pnl_7d_usd numeric(20, 2),
  created_at timestamp(6) DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_balance_adjustment_meta_target_user_id_idx
  ON admin_balance_adjustment_meta (target_user_id);
CREATE INDEX IF NOT EXISTS admin_balance_adjustment_meta_created_at_idx
  ON admin_balance_adjustment_meta (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_balance_adjustment_meta_ledger_tx_id_idx
  ON admin_balance_adjustment_meta (ledger_tx_id);
CREATE INDEX IF NOT EXISTS admin_balance_adjustment_meta_category_idx
  ON admin_balance_adjustment_meta (category);

DROP TABLE IF EXISTS salary_wallet;

CREATE TABLE IF NOT EXISTS salary_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  discord_name text NOT NULL,
  eth_address text NOT NULL,
  cadence text DEFAULT 'monthly' NOT NULL,
  salary_usdt numeric(20, 6) NOT NULL,
  max_per_payout numeric(20, 6),
  active boolean DEFAULT true NOT NULL,
  last_paid_at timestamptz(6),
  notes text,
  created_at timestamptz(6) DEFAULT now() NOT NULL,
  updated_at timestamptz(6) DEFAULT now() NOT NULL,
  created_by_id uuid NOT NULL REFERENCES admin_users(id)
);
ALTER TABLE salary_employees
  ADD COLUMN IF NOT EXISTS cadence text DEFAULT 'monthly' NOT NULL;
ALTER TABLE salary_employees
  ADD COLUMN IF NOT EXISTS pay_day_of_week smallint;
ALTER TABLE salary_employees
  ADD COLUMN IF NOT EXISTS pay_day_of_month smallint;
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'salary_employees'
      AND column_name = 'name'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'salary_employees'
      AND column_name = 'discord_name'
  ) THEN
    ALTER TABLE salary_employees RENAME COLUMN name TO discord_name;
  END IF;
END
$migration$;
CREATE INDEX IF NOT EXISTS salary_employees_active_idx
  ON salary_employees (active);

CREATE TABLE IF NOT EXISTS salary_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  employee_id uuid NOT NULL REFERENCES salary_employees(id),
  amount_usdt numeric(20, 6) NOT NULL,
  to_address text NOT NULL,
  tx_hash text UNIQUE,
  status text DEFAULT 'pending' NOT NULL,
  error_message text,
  broadcast_at timestamptz(6),
  confirmed_at timestamptz(6),
  failed_at timestamptz(6),
  paid_by_id uuid NOT NULL REFERENCES admin_users(id),
  created_at timestamptz(6) DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS salary_payouts_employee_id_idx
  ON salary_payouts (employee_id);
CREATE INDEX IF NOT EXISTS salary_payouts_status_idx
  ON salary_payouts (status);
CREATE INDEX IF NOT EXISTS salary_payouts_created_at_idx
  ON salary_payouts (created_at DESC);

CREATE TABLE IF NOT EXISTS salary_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  employee_id uuid NOT NULL REFERENCES salary_employees(id) ON DELETE CASCADE,
  payment_link text NOT NULL,
  paid_at timestamptz(6) DEFAULT now() NOT NULL,
  created_by_id uuid NOT NULL REFERENCES admin_users(id),
  created_at timestamptz(6) DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS salary_payments_employee_id_idx
  ON salary_payments (employee_id);
CREATE INDEX IF NOT EXISTS salary_payments_paid_at_idx
  ON salary_payments (paid_at DESC);
