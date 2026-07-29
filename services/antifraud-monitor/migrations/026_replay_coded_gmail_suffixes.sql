UPDATE source_cursors
SET
  occurred_at = now() - interval '7 days',
  source_id = '',
  updated_at = now()
WHERE stream = 'fiat_gmail_dot_patterns';
