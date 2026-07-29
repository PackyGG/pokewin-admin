import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("Leaderboards live in the Creators app, not the Admin sidebar", () => {
  const nav = source("src/lib/nav-config.ts");
  const creatorSidebar = source(
    "src/app/(creator-hub)/creator-hub/_components/creator-hub-sidebar.tsx",
  );
  const creatorPage = source(
    "src/app/(creator-hub)/creator-hub/leaderboards/page.tsx",
  );

  assert.doesNotMatch(nav, /id:\s*"nav\.creators\.leaderboards"/);
  assert.match(
    creatorSidebar,
    /label:\s*"Leaderboards"[\s\S]*?href:\s*"\/creator-hub\/leaderboards"/,
  );
  assert.match(
    creatorPage,
    /requireCreatorHubPageAccess\(\)/,
  );
  assert.doesNotMatch(
    nav,
    /href:\s*"\/creators\/leaderboards"[\s\S]*?inSidebar:\s*true/,
  );
});
