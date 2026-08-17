import assert from "node:assert/strict";
import test from "node:test";

import { parsePaginatedSuccess } from "../../src/lib/backend-api/paginated-response";

test("creator session pages unwrap a valid backend success envelope", () => {
  const session = { id: "session-1" };
  assert.deepEqual(
    parsePaginatedSuccess(
      {
        success: true,
        data: { data: [session], total: 1, offset: 0, limit: 100 },
      },
      "Creator session list",
    ),
    { data: [session], total: 1, offset: 0, limit: 100 },
  );
});

test("creator session pages reject malformed 200 responses at the client boundary", () => {
  for (const payload of [
    undefined,
    {},
    { success: false },
    {
      success: false,
      data: { data: [], total: 0, offset: 0, limit: 100 },
    },
    { success: true, data: {} },
    {
      success: true,
      data: { data: undefined, total: 1, offset: 0, limit: 100 },
    },
  ]) {
    assert.throws(
      () => parsePaginatedSuccess(payload, "Creator session list"),
      TypeError,
    );
  }
});

test("the session read client catches response contract failures before paging", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile("src/lib/backend-api/creators.ts", "utf8"),
  );
  const sessionRead = source.slice(
    source.indexOf("listSessions: async"),
    source.indexOf("forceEndSession:"),
  );

  assert.match(sessionRead, /try\s*\{/);
  assert.match(sessionRead, /parsePaginatedSuccess<CreatorSessionResponse>/);
  assert.match(sessionRead, /catch \(error\)/);
  assert.match(sessionRead, /logWarn\(/);
  assert.doesNotMatch(sessionRead, /console\.warn/);
  assert.doesNotMatch(sessionRead, /failed for \$\{userId\}/);
  assert.match(sessionRead, /listCreatorSessionsFromPostgres\(userId, query\)/);
});
