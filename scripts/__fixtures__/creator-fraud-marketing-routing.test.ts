import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("Creator Fraud lives only in the Marketing workspace", () => {
  const oldRoot = "src/app/(antifraud)/antifraud/creator-fraud";
  const newRoot = "src/app/(creator-hub)/creator-hub/creator-fraud";

  assert.equal(existsSync(`${oldRoot}/page.tsx`), false);
  assert.equal(existsSync(`${newRoot}/page.tsx`), true);
  assert.equal(existsSync(`${newRoot}/[creatorId]/page.tsx`), true);

  const listPage = source(`${newRoot}/page.tsx`);
  const detailPage = source(`${newRoot}/[creatorId]/page.tsx`);
  const actions = source(`${newRoot}/actions.ts`);
  const marketingNav = source(
    "src/app/(creator-hub)/creator-hub/_components/creator-hub-sidebar.tsx",
  );
  const antifraudNav = source(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );

  assert.match(listPage, /requireCreatorHubPageAccess\(\)/);
  assert.match(detailPage, /requireCreatorHubPageAccess\(\)/);
  assert.doesNotMatch(listPage, /requireAntifraudPageAccess/);
  assert.doesNotMatch(detailPage, /requireAntifraudPageAccess/);
  assert.match(actions, /requireCreatorHubAccess\(\)/);
  assert.match(
    actions,
    /revalidatePath\(`\/creator-hub\/creator-fraud\/\$\{parsed\.data\.creatorId\}`\)/,
  );
  assert.match(marketingNav, /href:\s*"\/creator-hub\/creator-fraud"/);
  assert.doesNotMatch(antifraudNav, /\/antifraud\/creator-fraud/);
});

test("old Creator Fraud URLs redirect to Marketing with their suffix and query", () => {
  const middleware = source("src/middleware.ts");

  assert.match(
    middleware,
    /appHost\?\.basePath === "\/antifraud"[\s\S]*?pathname\.startsWith\("\/creator-fraud\/"\)/,
  );
  assert.match(
    middleware,
    /pathname\.startsWith\("\/antifraud\/creator-fraud\/"\)/,
  );
  assert.match(middleware, /creatorHub\.host\}\$\{legacyCreatorFraudPath\}/);
  assert.match(middleware, /url\.search = request\.nextUrl\.search/);
});
