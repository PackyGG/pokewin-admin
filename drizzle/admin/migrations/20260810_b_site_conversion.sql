-- ADMIN database only. Confirmed B.site token conversion: 1 USD = 1.42 tokens.
UPDATE casino_sites
SET tokens_per_usd = 1.42, updated_at = now()
WHERE slug = 'b-site';
