-- Recover the analyst for legacy In Review cases created before startReview()
-- assigned the acting staff member atomically. The existing status-change
-- audit is authoritative: use the latest audited transition into In Review.
WITH candidate AS (
  SELECT DISTINCT ON (r.id)
    r.id AS review_id,
    a.admin_user_id
  FROM antifraud_reviews AS r
  JOIN admin_audit_events AS a
    ON a.event_type = 'antifraud_review_status_changed'
   AND a.metadata ->> 'reviewId' = r.id::text
   AND a.metadata ->> 'to' = 'in_review'
   AND a.admin_user_id IS NOT NULL
  WHERE r.status = 'in_review'
    AND r.assigned_to IS NULL
  ORDER BY r.id, a.created_at DESC, a.id DESC
)
UPDATE antifraud_reviews AS r
SET assigned_to = candidate.admin_user_id,
    updated_at = now()
FROM candidate
WHERE r.id = candidate.review_id
  AND r.status = 'in_review'
  AND r.assigned_to IS NULL;
