UPDATE analysis_rules
SET
  name = CASE key
    WHEN 'creator_network_accounts' THEN 'Connected referred accounts'
    WHEN 'creator_external_accounts' THEN 'External network members'
    WHEN 'creator_signup_burst' THEN 'Referred-account signup burst'
    WHEN 'creator_ip_chain' THEN 'Referred accounts and IP chain'
    WHEN 'creator_country_cluster' THEN 'Referred-account country concentration'
    WHEN 'creator_proxy_ratio' THEN 'Referred-account proxy concentration'
    WHEN 'creator_disposable_ratio' THEN 'Referred-account disposable emails'
    WHEN 'creator_wallet_reuse' THEN 'Referred accounts reuse deposit wallet'
    WHEN 'creator_synchronized_deposits' THEN 'Referred accounts synchronize deposits'
    WHEN 'creator_ggr_shortfall' THEN 'Referred-account GGR shortfall'
    ELSE name
  END,
  description = CASE key
    WHEN 'creator_network_accounts' THEN 'Referred accounts belong to shared IP or device networks.'
    WHEN 'creator_external_accounts' THEN 'Referred accounts connect to accounts outside the affiliate cohort.'
    WHEN 'creator_signup_burst' THEN 'Many referred accounts register inside one hour.'
    WHEN 'creator_ip_chain' THEN 'Several referred accounts share one signup IP.'
    WHEN 'creator_country_cluster' THEN 'A large share of referred accounts comes from one country.'
    WHEN 'creator_proxy_ratio' THEN 'A large share of referred accounts uses anonymous networking.'
    WHEN 'creator_disposable_ratio' THEN 'A large share of referred accounts uses disposable email domains.'
    WHEN 'creator_wallet_reuse' THEN 'Several referred accounts deposit from the same source wallet.'
    WHEN 'creator_synchronized_deposits' THEN 'Several referred accounts deposit in the same second.'
    WHEN 'creator_ggr_shortfall' THEN 'The referred cohort actual value trails expected GGR by a material percentage.'
    ELSE description
  END,
  updated_at = now()
WHERE key IN (
  'creator_network_accounts',
  'creator_external_accounts',
  'creator_signup_burst',
  'creator_ip_chain',
  'creator_country_cluster',
  'creator_proxy_ratio',
  'creator_disposable_ratio',
  'creator_wallet_reuse',
  'creator_synchronized_deposits',
  'creator_ggr_shortfall'
);
