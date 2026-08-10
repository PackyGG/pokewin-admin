-- ADMIN database only. Confirmed casino domains supplied by the casino catalog owner.
WITH domains(slug, domain) AS (
  VALUES
    ('clash', 'clash.gg'),
    ('csgogem', 'csgogem.com'),
    ('chicken', 'chicken.gg'),
    ('shuffle', 'shuffle.com'),
    ('cases', 'cases.gg'),
    ('rain-gg', 'rain.gg')
)
INSERT INTO casino_site_domains (site_id, domain)
SELECT site.id, domains.domain
FROM domains
JOIN casino_sites AS site USING (slug)
ON CONFLICT (domain) DO UPDATE SET site_id = EXCLUDED.site_id;
