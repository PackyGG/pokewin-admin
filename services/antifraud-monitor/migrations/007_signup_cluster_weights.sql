INSERT INTO score_weights(key, points)
VALUES
  ('shared_device_ten_plus_accounts', 140),
  ('shared_device_twenty_five_plus_accounts', 200),
  ('ip_velocity_30m_ten_plus', 120),
  ('ip_velocity_30m_twenty_five_plus', 200),
  ('disposable_email', 60),
  ('affiliate_ip_chain_three_plus', 50),
  ('affiliate_ip_chain_ten_plus', 100),
  ('affiliate_cluster_three_plus', 10),
  ('affiliate_cluster_ten_plus', 25),
  ('country_cluster_ten_plus', 10),
  ('country_cluster_twenty_five_plus', 25)
ON CONFLICT (key) DO NOTHING;
