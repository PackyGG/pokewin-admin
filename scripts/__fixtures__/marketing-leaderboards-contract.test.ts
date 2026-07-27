import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("Marketing exposes the existing affiliate leaderboard manager", () => {
  const nav = source("src/lib/nav-config.ts");
  const pages = source("src/lib/admin-pages.ts");
  const page = source("src/app/(admin)/creators/leaderboards/page.tsx");
  const hosts = source("src/lib/app-hosts.ts");

  assert.match(
    nav,
    /id:\s*"nav\.creators\.leaderboards"[\s\S]*?href:\s*"\/creators\/leaderboards"[\s\S]*?pageKey:\s*"\/creators\/leaderboards"[\s\S]*?inSidebar:\s*true/,
  );
  assert.match(
    pages,
    /label:\s*"Affiliate Leaderboards"[\s\S]*?key:\s*"\/creators\/leaderboards"/,
  );
  assert.match(page, /requirePageAccess\("\/creators\/leaderboards"\)/);
  assert.match(
    hosts,
    /host:\s*`marketing\.\$\{ROOT_DOMAIN\}`[\s\S]*?allowRoles:\s*\["admin",\s*"marketing"\]/,
  );
});
