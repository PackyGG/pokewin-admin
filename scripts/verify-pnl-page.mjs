#!/usr/bin/env node
// Smoke test for the P&L feature:
//   • new /pnl page renders (hero, KPI strip, breakdown, explainer)
//   • /analytics still renders the shared PnlBreakdown (extraction
//     regression guard)
//   • /dashboard still renders (24h GGR box added to the primary row)
// Mints an admin session JWT and inspects the SSR HTML.
// Run against a running prod build on $SMOKE_URL (default :3105).
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

const base = process.env.SMOKE_URL || "http://localhost:3105";

async function get(path) {
  const res = await fetch(`${base}${path}`, {
    headers: { cookie: `admin_session=${token}` },
    redirect: "manual",
  });
  return { status: res.status, html: await res.text() };
}

// Note: JSX writes "P&amp;L", so the SSR HTML source contains the
// escaped "&amp;". Assertions avoid the ampersand entirely and match
// on the unambiguous surrounding text instead.
const pnl = await get("/pnl");
const analytics = await get("/analytics");
const dashboard = await get("/dashboard");

const checks = [
  ["/pnl → 200", pnl.status === 200],
  ["/pnl breakdown panel present", pnl.html.includes("comes from")],
  ["/pnl explainer present", pnl.html.includes("How to read this")],
  ["/pnl KPI tile 'Owed to Users' present", pnl.html.includes("Owed to Users")],
  [
    "/analytics → 200 (shared PnlBreakdown regression)",
    analytics.status === 200,
  ],
  [
    "/analytics still renders the breakdown",
    analytics.html.includes("comes from"),
  ],
  ["/dashboard → 200 (24h GGR box regression)", dashboard.status === 200],
];

let allOk = true;
for (const [label, ok] of checks) {
  if (!ok) allOk = false;
  console.log(`  ${ok ? "✅" : "❌"}  ${label}`);
}
console.log(
  `\n/pnl ${pnl.status} (${pnl.html.length}b) · /analytics ${analytics.status} · /dashboard ${dashboard.status}`,
);
console.log(allOk ? "✅ ALL PASSED" : "❌ FAILED");
process.exit(allOk ? 0 : 1);
