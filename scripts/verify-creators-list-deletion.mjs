#!/usr/bin/env node
// Verify (1) /creators/list returns 404, (2) /creators renders the
// new "Global PnL" tile. Runs against a locally-running prod build.
import "dotenv/config";
import { SignJWT } from "jose";
import pg from "pg";

const secret = process.env.SESSION_SECRET;
const dbUrl = process.env.ADMIN_DATABASE_URL;
const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
const r = await client.query(
  `SELECT id, email, username, role
     FROM admin_users
    WHERE is_active = true AND role = 'admin'
    ORDER BY created_at ASC
    LIMIT 1`,
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

const listRes = await fetch(`${base}/creators/list`, {
  headers: { cookie: `admin_session=${token}` },
  redirect: "manual",
});
console.log(`/creators/list  → ${listRes.status}`);

const cRes = await fetch(`${base}/creators`, {
  headers: { cookie: `admin_session=${token}` },
  redirect: "manual",
});
const html = await cRes.text();
console.log(`/creators       → ${cRes.status} (${html.length} bytes)`);
console.log(`  "Global PnL" tile in HTML:    ${html.includes("Global PnL")}`);
console.log(
  `  "affiliates combined" sub in HTML: ${html.includes("affiliates combined")}`,
);
console.log(
  `  "Deal Estimates" in HTML:    ${html.includes("Deal Estimates")} (should be false — sidebar entry removed)`,
);
