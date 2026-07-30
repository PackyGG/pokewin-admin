# Profile/evidence migration 037

Migration 037 is additive. It does not delete or rewrite cases, risk events,
signup assessments, provider checks, blacklists, account locks, KYC state, or
audit history.

## Compatibility and backfill

- `signup_assessments` remains the compatibility record used by existing API
  consumers. New writes also populate versioned profile history and normalized
  signal rows.
- Existing signup scores are retained in `legacy_score` and `raw_score`.
  The v2 profile projection is capped to 0-100; legacy rows are not silently
  reinterpreted.
- Existing provider checks are copied idempotently. A missing historical check
  is `unknown`, never `success` or clean evidence.
- Provider evidence is append-only per stable check occurrence. Repeating a
  provider and lookup stores another row; retrying the same occurrence is an
  idempotent no-op. `raw_evidence` accepts only the existing sanitized provider
  response, never credentials or unrestricted upstream payloads.
- The migration records pre/post counts, duplicate counts, and assessment
  parity in `antifraud_backfill_runs`.
- Existing withdrawal provenance is copied through a bounded 365-day,
  200-entry-per-assessment projection. Future MAIN-derived relationship and
  funding backfills must use a bounded `(occurred_at, source_id)` cursor and
  the read-only mirror. They must not use cross-database SQL or unbounded scans.

Fiat eligibility is separately fail-closed behind
`FIAT_ELIGIBILITY_GLOBALLY_ENABLED`. Missing, false, or invalid configuration
persists an audited deny with reason `fiat_globally_disabled` and risk score
zero without reading MAIN or calling a provider. Existing API credentials and
source-IP allowlists cannot override the disabled gate.

## Verification

Run these read-only checks against the Antifraud database after migration:

```sql
SELECT stream, version, status, source_count, inserted_count,
       duplicate_count, parity_ok, pre_counts, post_counts
FROM antifraud_backfill_runs
WHERE stream = 'legacy-profile-compatibility' AND version = '037';

SELECT COUNT(*) AS legacy_assessments FROM signup_assessments;
SELECT COUNT(*) AS versioned_legacy_assessments
FROM profile_assessment_history
WHERE assessment_version = 'legacy-v1'
  AND source_ref = 'legacy:signup_assessment';

SELECT user_id, assessment_version, source_ref, COUNT(*)
FROM profile_assessment_history
GROUP BY user_id, assessment_version, source_ref
HAVING COUNT(*) > 1;
```

The two counts must match, the duplicate query must return no rows, and
`parity_ok` must be true.

Representative bounded reads should use:

- `signup_identity_snapshot_fingerprint_idx` for device clustering.
- `profile_provider_evidence_user_time_idx` for a user's latest provider checks.
- `funding_trace_restricted_idx` for restricted-source downstream tracing.

## Recovery

The safe recovery is application rollback first. Old readers continue using
the preserved compatibility tables. Stop v2 writers, deploy the prior service,
and leave the additive tables in place for forensic inspection. If storage
reclamation is later approved, drop only the 037-owned tables after exporting
them; never restore by deleting or rewriting legacy Antifraud data.
