#!/usr/bin/env node
// Smoke test for the dashboard changes:
//   • "Deposits" live feed replaces "Live Pulls"
//   • the top-bar online-users indicator is gone
// Mints an admin session JWT and inspects the SSR HTML of /dashboard.
// Run against a running prod build on $SMOKE_URL (default :3102).
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

const base = process.env.SMOKE_URL || "http://localhost:3102";
const res = await fetch(`${base}/dashboard`, {
  headers: { cookie: `admin_session=${token}` },
  redirect: "manual",
});
const html = await res.text();

// Assertions. The online indicator rendered an aria-label "Live users
// online" — its absence proves the top-bar count is gone. "Live
// Deposits" is the new card's internal header; "Live Pulls" must be
// gone entirely.
const checks = [
  ["HTTP 200", res.status === 200],
  ["Deposits feed present (Live Deposits)", html.includes("Live Deposits")],
  ["Last 24h deposited copy present", html.includes("Last 24h deposited")],
  ["Live Pulls removed", !html.includes("Live Pulls")],
  [
    "Online-users indicator removed",
    !html.includes("Live users online") && !html.includes("aria-label=\"Live users online\""),
  ],
];

let allOk = true;
for (const [label, ok] of checks) {
  if (!ok) allOk = false;
  console.log(`  ${ok ? "✅" : "❌"}  ${label}`);
}
console.log(
  `\n/dashboard → ${res.status} (${html.length} bytes)\n${allOk ? "✅ ALL PASSED" : "❌ FAILED"}`,
);
process.exit(allOk ? 0 : 1);
