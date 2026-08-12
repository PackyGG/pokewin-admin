-- Keep dashboard-wide fiat aggregates proportional to user/day dimensions,
-- not to the lifetime number of deposit assessments. The source assessment
-- remains canonical; this table is an exact, transactionally-maintained
-- projection used only for read-heavy dashboard totals.
CREATE TABLE IF NOT EXISTS fiat_deposit_dashboard_rollups (
  bucket_date date NOT NULL,
  user_id text NOT NULL,
  status text NOT NULL,
  verdict text NOT NULL,
  review_status text NOT NULL,
  three_ds_state smallint NOT NULL CHECK (three_ds_state BETWEEN -1 AND 1),
  kyc_required boolean NOT NULL,
  deposit_count bigint NOT NULL CHECK (deposit_count >= 0),
  credited_amount_usd numeric(24,2) NOT NULL,
  PRIMARY KEY (
    bucket_date,
    user_id,
    status,
    verdict,
    review_status,
    three_ds_state,
    kyc_required
  )
);

CREATE INDEX IF NOT EXISTS fiat_dashboard_rollups_status_user_idx
  ON fiat_deposit_dashboard_rollups(status, user_id, bucket_date DESC);

-- Close the backfill/trigger-install race: without this lock, an assessment
-- committed after the backfill snapshot but before CREATE TRIGGER would be
-- permanently absent from the projection. Normal writers resume on commit.
LOCK TABLE fiat_deposit_assessments IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO fiat_deposit_dashboard_rollups (
  bucket_date,
  user_id,
  status,
  verdict,
  review_status,
  three_ds_state,
  kyc_required,
  deposit_count,
  credited_amount_usd
)
SELECT
  (occurred_at AT TIME ZONE 'UTC')::date,
  user_id,
  status,
  verdict,
  review_status,
  CASE
    WHEN three_ds_verified IS NULL THEN -1
    WHEN three_ds_verified THEN 1
    ELSE 0
  END,
  COALESCE((account_evidence->>'kycRequired')::boolean, false),
  COUNT(*),
  SUM(credited_amount_usd)
FROM fiat_deposit_assessments
GROUP BY 1, 2, 3, 4, 5, 6, 7
ON CONFLICT (
  bucket_date,
  user_id,
  status,
  verdict,
  review_status,
  three_ds_state,
  kyc_required
) DO UPDATE SET
  deposit_count = EXCLUDED.deposit_count,
  credited_amount_usd = EXCLUDED.credited_amount_usd;

CREATE OR REPLACE FUNCTION adjust_fiat_deposit_dashboard_rollup(
  assessment fiat_deposit_assessments,
  count_delta bigint,
  amount_delta numeric
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  row_count bigint;
BEGIN
  IF count_delta < 0 THEN
    UPDATE fiat_deposit_dashboard_rollups
    SET
      deposit_count = deposit_count + count_delta,
      credited_amount_usd = credited_amount_usd + amount_delta
    WHERE bucket_date = (assessment.occurred_at AT TIME ZONE 'UTC')::date
      AND user_id = assessment.user_id
      AND status = assessment.status
      AND verdict = assessment.verdict
      AND review_status = assessment.review_status
      AND three_ds_state = CASE
        WHEN assessment.three_ds_verified IS NULL THEN -1
        WHEN assessment.three_ds_verified THEN 1
        ELSE 0
      END
      AND kyc_required = COALESCE(
        (assessment.account_evidence->>'kycRequired')::boolean,
        false
      )
    RETURNING deposit_count INTO row_count;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'missing fiat dashboard rollup for assessment %',
        assessment.deposit_intent_id;
    END IF;
  ELSE
  INSERT INTO fiat_deposit_dashboard_rollups (
    bucket_date,
    user_id,
    status,
    verdict,
    review_status,
    three_ds_state,
    kyc_required,
    deposit_count,
    credited_amount_usd
  ) VALUES (
    (assessment.occurred_at AT TIME ZONE 'UTC')::date,
    assessment.user_id,
    assessment.status,
    assessment.verdict,
    assessment.review_status,
    CASE
      WHEN assessment.three_ds_verified IS NULL THEN -1
      WHEN assessment.three_ds_verified THEN 1
      ELSE 0
    END,
    COALESCE((assessment.account_evidence->>'kycRequired')::boolean, false),
    count_delta,
    amount_delta
  )
  ON CONFLICT (
    bucket_date,
    user_id,
    status,
    verdict,
    review_status,
    three_ds_state,
    kyc_required
  ) DO UPDATE SET
    deposit_count = fiat_deposit_dashboard_rollups.deposit_count
      + EXCLUDED.deposit_count,
    credited_amount_usd = fiat_deposit_dashboard_rollups.credited_amount_usd
      + EXCLUDED.credited_amount_usd
  RETURNING deposit_count INTO row_count;
  END IF;

  IF row_count = 0 THEN
    DELETE FROM fiat_deposit_dashboard_rollups
    WHERE bucket_date = (assessment.occurred_at AT TIME ZONE 'UTC')::date
      AND user_id = assessment.user_id
      AND status = assessment.status
      AND verdict = assessment.verdict
      AND review_status = assessment.review_status
      AND three_ds_state = CASE
        WHEN assessment.three_ds_verified IS NULL THEN -1
        WHEN assessment.three_ds_verified THEN 1
        ELSE 0
      END
      AND kyc_required = COALESCE(
        (assessment.account_evidence->>'kycRequired')::boolean,
        false
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION sync_fiat_deposit_dashboard_rollup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Refresh upserts commonly assign every assessment column even when the
  -- aggregate dimensions did not change. Skip that no-op instead of taking
  -- two rollup row locks for every periodic re-score.
  IF TG_OP = 'UPDATE' AND ROW(
    OLD.user_id,
    OLD.status,
    OLD.verdict,
    OLD.review_status,
    OLD.three_ds_verified,
    OLD.account_evidence->>'kycRequired',
    OLD.credited_amount_usd,
    OLD.occurred_at
  ) IS NOT DISTINCT FROM ROW(
    NEW.user_id,
    NEW.status,
    NEW.verdict,
    NEW.review_status,
    NEW.three_ds_verified,
    NEW.account_evidence->>'kycRequired',
    NEW.credited_amount_usd,
    NEW.occurred_at
  ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM adjust_fiat_deposit_dashboard_rollup(
      OLD,
      -1,
      -OLD.credited_amount_usd
    );
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM adjust_fiat_deposit_dashboard_rollup(
      NEW,
      1,
      NEW.credited_amount_usd
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fiat_deposit_dashboard_rollup_sync
  ON fiat_deposit_assessments;
CREATE TRIGGER fiat_deposit_dashboard_rollup_sync
AFTER INSERT OR DELETE OR UPDATE OF
  user_id,
  status,
  verdict,
  review_status,
  three_ds_verified,
  account_evidence,
  credited_amount_usd,
  occurred_at
ON fiat_deposit_assessments
FOR EACH ROW
EXECUTE FUNCTION sync_fiat_deposit_dashboard_rollup();
