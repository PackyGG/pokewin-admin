INSERT INTO score_weights(key, points, updated_by)
VALUES
  ('abstract_ip_vpn', 20, 'migration:035'),
  ('abstract_ip_proxy', 35, 'migration:035'),
  ('abstract_ip_tor', 65, 'migration:035'),
  ('abstract_ip_hosting', 20, 'migration:035'),
  ('abstract_ip_relay', 25, 'migration:035'),
  ('abstract_ip_abuse', 80, 'migration:035'),
  ('abstract_ip_country_mismatch', 30, 'migration:035'),
  ('abstract_email_catchall', 100, 'migration:035'),
  ('abstract_email_undeliverable', 100, 'migration:035'),
  ('abstract_email_unknown_deliverability', 25, 'migration:035'),
  ('abstract_email_invalid_smtp', 70, 'migration:035'),
  ('abstract_email_disposable', 80, 'migration:035'),
  ('abstract_email_suspicious_username', 35, 'migration:035'),
  ('abstract_email_medium_risk', 40, 'migration:035'),
  ('abstract_email_high_risk', 80, 'migration:035'),
  ('abstract_email_risky_tld', 40, 'migration:035'),
  ('abstract_email_low_quality', 50, 'migration:035'),
  ('abstract_email_new_domain', 25, 'migration:035')
ON CONFLICT (key) DO NOTHING;
