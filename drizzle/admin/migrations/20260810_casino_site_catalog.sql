-- ADMIN database only. Canonical casino identity and currency metadata used by Discord deal scans.
CREATE TABLE IF NOT EXISTS casino_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  tokens_per_usd numeric(20, 8),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT casino_sites_slug_check CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT casino_sites_display_name_check CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  CONSTRAINT casino_sites_tokens_per_usd_check CHECK (tokens_per_usd IS NULL OR tokens_per_usd > 0)
);

CREATE TABLE IF NOT EXISTS casino_site_aliases (
  site_id uuid NOT NULL REFERENCES casino_sites(id) ON DELETE CASCADE,
  alias text NOT NULL,
  alias_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, alias_key),
  CONSTRAINT casino_site_aliases_alias_check CHECK (length(btrim(alias)) BETWEEN 1 AND 80),
  CONSTRAINT casino_site_aliases_key_check CHECK (alias_key ~ '^[a-z0-9]+(?: [a-z0-9]+)*$')
);

CREATE TABLE IF NOT EXISTS casino_site_domains (
  site_id uuid NOT NULL REFERENCES casino_sites(id) ON DELETE CASCADE,
  domain text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT casino_site_domains_domain_check CHECK (
    domain = lower(domain)
    AND domain !~ '[/:]'
    AND domain ~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$'
  )
);

INSERT INTO casino_sites (slug, display_name, tokens_per_usd)
VALUES
  ('diceblox', 'Diceblox', 500),
  ('rustmagic', 'Rustmagic', 1.45),
  ('bloxflip', 'Bloxflip', NULL),
  ('csgogem', 'CSGOGEM', 1.66),
  ('skinrave', 'Skinrave', 2),
  ('rain-gg', 'Rain.GG', 1.42),
  ('csgoroll', 'CSGOROLL', 1.42),
  ('csgowin', 'CSGOWIN', 1.61),
  ('csdrop', 'CSDROP', 1.42),
  ('csbattle', 'CSBATTLE', 1.55),
  ('roobet', 'Roobet', NULL),
  ('clash', 'Clash', 1.46),
  ('b-site', 'B.site', NULL),
  ('chicken', 'Chicken', 2),
  ('krush-gg', 'Krush.GG', NULL),
  ('csgobig', 'BIG', 1.69),
  ('shuffle', 'Shuffle', NULL),
  ('cases', 'Cases', NULL)
ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  tokens_per_usd = EXCLUDED.tokens_per_usd,
  active = true,
  updated_at = now();

WITH aliases(slug, alias, alias_key) AS (
  VALUES
    ('diceblox', 'diceblox', 'diceblox'), ('diceblox', 'dice blox', 'dice blox'), ('diceblox', 'dice', 'dice'),
    ('rustmagic', 'rustmagic', 'rustmagic'), ('rustmagic', 'rust magic', 'rust magic'),
    ('rustmagic', 'rustmatic', 'rustmatic'), ('rustmagic', 'rustmaged', 'rustmaged'),
    ('bloxflip', 'bloxflip', 'bloxflip'), ('bloxflip', 'blox flip', 'blox flip'),
    ('csgogem', 'csgogem', 'csgogem'), ('csgogem', 'csgo gem', 'csgo gem'),
    ('skinrave', 'skinrave', 'skinrave'), ('skinrave', 'skin rave', 'skin rave'),
    ('rain-gg', 'rain.gg', 'rain gg'), ('rain-gg', 'rain', 'rain'),
    ('csgoroll', 'csgoroll', 'csgoroll'), ('csgoroll', 'csgo roll', 'csgo roll'),
    ('csgowin', 'csgowin', 'csgowin'), ('csgowin', 'csgo win', 'csgo win'),
    ('csdrop', 'csdrop', 'csdrop'), ('csdrop', 'cs drop', 'cs drop'),
    ('csbattle', 'csbattle', 'csbattle'), ('csbattle', 'cs battle', 'cs battle'),
    ('roobet', 'roobet', 'roobet'),
    ('clash', 'clash.gg', 'clash gg'), ('clash', 'clash', 'clash'),
    ('b-site', 'b.site', 'b site'),
    ('chicken', 'chicken.gg', 'chicken gg'), ('chicken', 'chicken', 'chicken'),
    ('krush-gg', 'krush.gg', 'krush gg'), ('krush-gg', 'krush', 'krush'),
    ('csgobig', 'csgobig', 'csgobig'), ('csgobig', 'csgo big', 'csgo big'),
    ('csgobig', 'big.gg', 'big gg'), ('csgobig', 'big', 'big'),
    ('shuffle', 'shuffle', 'shuffle'),
    ('cases', 'cases.gg', 'cases gg'), ('cases', 'cases', 'cases')
)
INSERT INTO casino_site_aliases (site_id, alias, alias_key)
SELECT site.id, aliases.alias, aliases.alias_key
FROM aliases
JOIN casino_sites AS site USING (slug)
ON CONFLICT (alias_key) DO UPDATE SET
  site_id = EXCLUDED.site_id,
  alias = EXCLUDED.alias;

WITH domains(slug, domain) AS (
  VALUES
    ('rain-gg', 'rain.gg'),
    ('clash', 'clash.gg'),
    ('b-site', 'b.site'),
    ('chicken', 'chicken.gg'),
    ('krush-gg', 'krush.gg'),
    ('csgobig', 'big.gg'),
    ('cases', 'cases.gg')
)
INSERT INTO casino_site_domains (site_id, domain)
SELECT site.id, domains.domain
FROM domains
JOIN casino_sites AS site USING (slug)
ON CONFLICT (domain) DO UPDATE SET site_id = EXCLUDED.site_id;
