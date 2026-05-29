#!/usr/bin/env node
// Smoke test for the /creators "Active" + "Live" indicators.
//
// What it does:
//   1. Reads SESSION_SECRET from .env and mints a 12h admin session
//      JWT (same shape `lib/session.ts:encrypt()` produces).
//   2. Picks a real admin row from the admin DB to put in the payload
//      (the page calls `requirePageAccess("/creators")` which verifies
//      the row is active).
//   3. Fetches the locally-running prod server's /creators HTML with
//      the admin_session cookie set.
//   4. Greps the HTML for the indicators + dumps a per-creator
//      summary so we can verify the markup renders for creators who
//      should have Active / Live based on the API response.
//
// Pre-reqs: `npm run start` running on localhost:3000.

import "dotenv/config";
import { SignJWT } from "jose";
import pg from "pg";

const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_DATABASE_URL = process.env.ADMIN_DATABASE_URL;
const SERVER_URL = process.env.SMOKE_URL || "http://localhost:3000";

if (!SESSION_SECRET) {
  console.error("Missing SESSION_SECRET");
  process.exit(1);
}
if (!ADMIN_DATABASE_URL) {
  console.error("Missing ADMIN_DATABASE_URL");
  process.exit(1);
}

// Pick an active admin row.
const client = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
await client.connect();
const adminRes = await client.query(
  `SELECT id, email, username, role
     FROM admin_users
    WHERE is_active = true AND role = 'admin'
    ORDER BY created_at ASC
    LIMIT 1`,
);
await client.end();

const admin = adminRes.rows[0];
if (!admin) {
  console.error("No active admin found in admin_users.");
  process.exit(1);
}

console.log(
  `→ Minting session for ${admin.username} (${admin.email}, ${admin.role})`,
);

// Same encrypt() shape as src/lib/session.ts
const encodedKey = new TextEncoder().encode(SESSION_SECRET);
const payload = {
  userId: admin.id,
  role: admin.role,
  email: admin.email,
  username: admin.username,
  expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
};
const token = await new SignJWT(payload)
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("12h")
  .sign(encodedKey);

console.log(`→ Fetching ${SERVER_URL}/creators ...`);

const res = await fetch(`${SERVER_URL}/creators`, {
  headers: {
    cookie: `admin_session=${token}`,
  },
  redirect: "manual",
});

console.log(`  status: ${res.status}`);
if (res.status === 307 || res.status === 302) {
  console.log(`  redirect → ${res.headers.get("location")}`);
  console.error("Got a redirect — JWT probably rejected. Check session vars.");
  process.exit(1);
}
const html = await res.text();
console.log(`  bytes: ${html.length}`);

// Grep for the indicator markup. We render two distinct shapes:
//   • "Active" pill   →  `rounded-full border border-emerald-500/30 bg-emerald-500/10 ... Active`
//   • "Live"   badge  →  `animate-ping rounded-full bg-emerald-500/... Live`
//
// We also want to know how MANY of each rendered on the page so we
// can compare against the API's truth (counts of active deals + live
// sessions).

// Loose matchers — count any occurrence of the WORD "Active" or
// "Live" in close proximity to an emerald class. This catches the
// real markup regardless of Tailwind class-order shuffling.
const activeWordMatches = html.match(/\bActive\b/g);
const liveWordMatches = html.match(/\bLive\b/g);

console.log(`\nWord counts in rendered HTML:`);
console.log(`  "Active" occurrences: ${activeWordMatches?.length ?? 0}`);
console.log(`  "Live"   occurrences: ${liveWordMatches?.length ?? 0}`);

// What creators actually rendered? Pull every link to /creators/[id]
// — creator IDs are arbitrary strings (packy.gg user_ids), not uuids.
const creatorIdMatches = [
  ...html.matchAll(/\/creators\/([A-Za-z0-9_-]{8,})/g),
];
const uniqueCreatorIds = [...new Set(creatorIdMatches.map((m) => m[1]))];
console.log(
  `  Creator IDs linked on this page: ${uniqueCreatorIds.length}`,
);
console.log(`  First 5 IDs: ${uniqueCreatorIds.slice(0, 5).join(", ")}`);

// `kickcvrsify` was the user's example — pull the card snippet for
// that one creator if it's on this page so we can see the exact
// markup that rendered around their username.
const kickIdx = html.indexOf("kickcvrsify");
if (kickIdx >= 0) {
  console.log(
    `\nMarkup around 'kickcvrsify' (idx=${kickIdx}):\n${"─".repeat(60)}`,
  );
  console.log(html.slice(Math.max(0, kickIdx - 600), kickIdx + 1200));
  console.log("─".repeat(60));
} else {
  console.log("\n‼ 'kickcvrsify' is NOT on this page (probably page 2+).");
}

// Cross-check: ask the backend API directly what state each creator
// is in, so we can compare the truth against the rendered output.
console.log(`\n→ Cross-checking backend API for creator state ...`);
const apiUrl =
  (process.env.BACKEND_API_URL_PROD ?? process.env.BACKEND_API_URL)?.replace(
    /\/$/,
    "",
  ) + "/admin/creators?limit=100";
const apiKey =
  process.env.BACKEND_ADMIN_KEY_PROD ?? process.env.BACKEND_API_KEY;
if (apiUrl && apiKey) {
  try {
    const apiRes = await fetch(apiUrl, {
      headers: { "x-api-key": apiKey },
    });
    if (apiRes.ok) {
      const body = await apiRes.json();
      const creators = body?.data?.data ?? body?.data ?? [];
      const liveCreators = creators.filter(
        (c) => c.active_session_id !== null,
      );
      const activeDealCreators = creators.filter(
        (c) => c?.current_deal?.status === "active",
      );
      const scheduledDealCreators = creators.filter(
        (c) => c?.current_deal?.status === "scheduled",
      );
      console.log(`  Total creators (API):    ${creators.length}`);
      console.log(`  active_session_id≠null:  ${liveCreators.length}`);
      console.log(`  current_deal=active:     ${activeDealCreators.length}`);
      console.log(`  current_deal=scheduled:  ${scheduledDealCreators.length}`);
      console.log(`\n  First 5 active-deal creators:`);
      for (const c of activeDealCreators.slice(0, 5)) {
        console.log(
          `    ${c.username ?? "(no username)"} — deal=${c.current_deal?.status} live=${c.active_session_id !== null}`,
        );
      }
      console.log(`\n  First 5 live creators:`);
      for (const c of liveCreators.slice(0, 5)) {
        console.log(
          `    ${c.username ?? "(no username)"} — deal=${c.current_deal?.status ?? "null"} live=${c.active_session_id !== null}`,
        );
      }
      const kick = creators.find((c) => c.username === "kickcvrsify");
      if (kick) {
        console.log(
          `\n  kickcvrsify (API): deal.status=${kick.current_deal?.status ?? "null"}, active_session_id=${kick.active_session_id ?? "null"}`,
        );
      }
    } else {
      console.log(`  Backend API call failed: HTTP ${apiRes.status}`);
    }
  } catch (e) {
    console.log(`  Backend API call threw: ${e.message}`);
  }
}

console.log("\n→ Done.");
