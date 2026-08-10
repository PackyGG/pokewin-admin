import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("casino catalog is normalized, scoped, guild-pinned, and safely seeded", async () => {
  const [migration, schema, service, route, endpoints] = await Promise.all([
    read("drizzle/admin/migrations/20260810_casino_site_catalog.sql"),
    read("src/lib/db-schema/admin/schema.ts"),
    read("src/lib/discord-casino-catalog.ts"),
    read("src/app/api/v1/discord/casino-sites/catalog/route.ts"),
    read("src/lib/api-auth/endpoints.ts"),
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS casino_sites/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS casino_site_aliases/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS casino_site_domains/);
  assert.match(migration, /REFERENCES casino_sites\(id\) ON DELETE CASCADE/g);
  assert.match(migration, /\('krush-gg', 'Krush\.GG', NULL\)/);
  assert.match(migration, /\('krush-gg', 'krush\.gg'\)/);
  assert.doesNotMatch(migration, /rubixrefs/i);
  for (const value of ["500", "1.45", "1.46", "1.66", "1.69", "1.42"]) {
    assert.match(migration, new RegExp(`, ${value.replace(".", "\\.")}\\)`));
  }

  assert.match(schema, /export const casino_sites = pgTable/);
  assert.match(schema, /export const casino_site_aliases = pgTable/);
  assert.match(schema, /export const casino_site_domains = pgTable/);
  assert.match(service, /WHERE site\.active = true/);
  assert.match(service, /LIMIT 250/);
  assert.match(route, /scopes: \["discord:creator:setup"\]/);
  assert.match(route, /rejectWrongGuild/);
  assert.match(route, /BodySchema = z\.object\(\{ guildId: DiscordIdSchema \}\)\.strict\(\)/);
  assert.match(endpoints, /path: "\/api\/v1\/discord\/casino-sites\/catalog"/);
});
