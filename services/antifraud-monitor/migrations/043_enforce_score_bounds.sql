-- The public risk model is always 0-100. Preserve raw evidence in signal
-- points and score_delta, but repair legacy aggregate/after-score rows before
-- enforcing the invariant at the database boundary.

UPDATE signup_assessments
SET score = LEAST(100, GREATEST(0, score))
WHERE score NOT BETWEEN 0 AND 100;

UPDATE cases
SET
  score = LEAST(100, GREATEST(0, score)),
  peak_score = LEAST(100, GREATEST(0, peak_score))
WHERE score NOT BETWEEN 0 AND 100
   OR peak_score NOT BETWEEN 0 AND 100;

UPDATE monitor_sessions
SET
  initial_score = LEAST(100, GREATEST(0, initial_score)),
  current_score = LEAST(100, GREATEST(0, current_score)),
  peak_score = LEAST(100, GREATEST(0, peak_score))
WHERE initial_score NOT BETWEEN 0 AND 100
   OR current_score NOT BETWEEN 0 AND 100
   OR peak_score NOT BETWEEN 0 AND 100;

UPDATE risk_events
SET score_after = LEAST(100, GREATEST(0, score_after))
WHERE score_after NOT BETWEEN 0 AND 100;

ALTER TABLE signup_assessments
  DROP CONSTRAINT IF EXISTS signup_assessments_score_bounds;
ALTER TABLE signup_assessments
  ADD CONSTRAINT signup_assessments_score_bounds
  CHECK (score BETWEEN 0 AND 100);

ALTER TABLE cases
  DROP CONSTRAINT IF EXISTS cases_score_bounds;
ALTER TABLE cases
  ADD CONSTRAINT cases_score_bounds
  CHECK (
    score BETWEEN 0 AND 100
    AND peak_score BETWEEN 0 AND 100
  );

ALTER TABLE monitor_sessions
  DROP CONSTRAINT IF EXISTS monitor_sessions_score_bounds;
ALTER TABLE monitor_sessions
  ADD CONSTRAINT monitor_sessions_score_bounds
  CHECK (
    initial_score BETWEEN 0 AND 100
    AND current_score BETWEEN 0 AND 100
    AND peak_score BETWEEN 0 AND 100
  );

ALTER TABLE risk_events
  DROP CONSTRAINT IF EXISTS risk_events_score_after_bounds;
ALTER TABLE risk_events
  ADD CONSTRAINT risk_events_score_after_bounds
  CHECK (score_after BETWEEN 0 AND 100);
