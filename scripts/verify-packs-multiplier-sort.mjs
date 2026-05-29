#!/usr/bin/env node
// End-to-end smoke test for the /transactions/packs "Highest
// Multiplier" sort. Mints an admin session JWT, hits the running
// prod build, and asserts the new sort trigger label appears in
// the SSR HTML. Run against a running `npm run build && npm start`
// instance on $SMOKE_URL (default http://localhost:3100).
//
// Note: base-ui Select renders SelectContent items lazily on
// popover open, so they are NOT in the SSR HTML. We only check the
// trigger label, which IS rendered inline in data-table-toolbar.
import "dotenv/config";
import { SignJWT } from "jose";
import pg from "pg";

const secret = process.env.SESSION_SECRET;
const dbUrl = process.env.ADMIN_DATABASE_URL;
if (!secret) throw new Error("SESSION_SECRET missing in env");
if (!dbUrl) throw new Error("ADMIN_DATABASE_URL missing in env");

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
const r = await client.query(
  `SELECT id, email, username, role FROM admin_users
    WHERE is_active = true AND role = 'admin'
    ORDER BY created_at ASC LIMIT 1`,
);
await client.end();
const admin = r.rows[0];
if (!admin) throw new Error("No active admin user found in admin DB");

const encodedKey = new TextEncoder().encode(secret);
const token = await new SignJWT({
  userId: admin.id,
  role: admin.role,
  email: admin.email,
  username: admin.username,
  expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("12h")
  .sign(encodedKey);

const base = process.env.SMOKE_URL || "http://localhost:3100";

// Each case: URL + the trigger label we expect to find in SSR HTML.
// Cases 1/2/4 → trigger reads "Recent" (default + allLabel + bogus
// fallthrough). Case 3 → trigger reads "Highest Multiplier".
const cases = [
  ["/transactions/packs", "Recent"],
  ["/transactions/packs?sortBy=recent", "Recent"],
  ["/transactions/packs?sortBy=pack_multiplier", "Highest Multiplier"],
  ["/transactions/packs?sortBy=bogus", "Recent"],
];

let allOk = true;
for (const [path, expectedLabel] of cases) {
  const res = await fetch(`${base}${path}`, {
    headers: { cookie: `admin_session=${token}` },
    redirect: "manual",
  });
  const html = await res.text();
  const hasLabel = html.includes(expectedLabel);
  const ok = res.status === 200 && hasLabel;
  if (!ok) allOk = false;
  console.log(
    `${path.padEnd(50)} → ${res.status} (${html.length} bytes) — ` +
      `trigger="${expectedLabel}" found: ${hasLabel}` +
      (ok ? "" : "  ❌"),
  );
}
console.log(`\n${allOk ? "✅ ALL PASSED" : "❌ FAILED"}`);
process.exit(allOk ? 0 : 1);
