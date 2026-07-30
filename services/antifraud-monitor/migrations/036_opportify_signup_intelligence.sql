INSERT INTO score_weights(key, points, updated_by)
VALUES
  ('opportify_risk_medium', 25, 'migration:036'),
  ('opportify_risk_high', 60, 'migration:036'),
  ('opportify_risk_highest', 100, 'migration:036')
ON CONFLICT (key) DO NOTHING;
