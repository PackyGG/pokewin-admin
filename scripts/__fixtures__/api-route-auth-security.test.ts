import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const exportRoutePath = "src/app/api/users/export/route.ts";
const imagekitRoutePath = "src/app/api/imagekit-auth/route.ts";

test("fetch-consumed API routes convert DAL redirects to JSON 401s", async () => {
  const [exportRoute, imagekitRoute] = await Promise.all([
    readFile(exportRoutePath, "utf8"),
    readFile(imagekitRoutePath, "utf8"),
  ]);

  for (const route of [exportRoute, imagekitRoute]) {
    assert.match(route, /try\s*\{[\s\S]*requirePageAccess\(/);
    assert.match(
      route,
      /NextResponse\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\)/,
    );
  }
});

test("user export is same-origin guarded before rate limiting", async () => {
  const route = await readFile(exportRoutePath, "utf8");
  const fetchSiteGuard = route.indexOf(
    'request.headers.get("sec-fetch-site") === "cross-site"',
  );
  const originGuard = route.indexOf(
    "originHeader !== new URL(request.url).origin",
  );
  const rateLimitCall = route.indexOf("const rl = await rateLimit(");

  assert.ok(fetchSiteGuard >= 0);
  assert.ok(originGuard > fetchSiteGuard);
  assert.ok(rateLimitCall > originGuard);
});

test("user export uses effective admin and owner roles plus shared permissions", async () => {
  const route = await readFile(exportRoutePath, "utf8");

  assert.match(
    route,
    /if \(!sessionIsAdmin\(session\) && !sessionIsOwner\(session\)\)/,
  );
  assert.match(
    route,
    /const allowedPages = await getUserPermissions\(session\.userId\)/,
  );
  assert.doesNotMatch(route, /if\s*\(\s*session\.role/);
  assert.doesNotMatch(route, /adminDrizzle|admin_users/);
});
