#!/usr/bin/env node
// Verify /creators?sortBy=pnl_desc + pnl_asc render correctly with
// the sort control present. Reuses the same session-minting pattern.
import "dotenv/config";
import { SignJWT } from "jose";
import pg from "pg";

const secret = process.env.SESSION_SECRET;
const dbUrl = process.env.ADMIN_DATABASE_URL;
const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
const r = await client.query(
  `SELECT id, email, username, role FROM admin_users
    WHERE is_active = true AND role = 'admin'
    ORDER BY created_at ASC LIMIT 1`,
);
await client.end();
const admin = r.rows[0];
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
// Each case asserts the CURRENT sort label is rendered in the
// trigger. SelectContent items aren't in the SSR HTML — base-ui
// renders them lazily on popover open — so we only check the
// trigger label, which IS rendered manually inline.
const cases = [
  ["/creators", "Recent (default)"],
  ["/creators?sortBy=pnl_desc", "Highest PnL"],
  ["/creators?sortBy=pnl_asc", "Lowest PnL"],
];

for (const [path, expectedLabel] of cases) {
  const res = await fetch(`${base}${path}`, {
    headers: { cookie: `admin_session=${token}` },
    redirect: "manual",
  });
  const html = await res.text();
  const triggerHasLabel = html.includes(expectedLabel);
  console.log(
    `${path.padEnd(35)} → ${res.status} (${html.length} bytes) — trigger="${expectedLabel}" present: ${triggerHasLabel}`,
  );
}
console.log("\nDone.");
