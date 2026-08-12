import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const STAFF_AUDIT = "src/lib/antifraud/staff-audit.ts";
const AUTO_BANS = "src/lib/antifraud/auto-bans.ts";

test("antifraud staff audit counts against an explicit ceiling", () => {
  const source = read(STAFF_AUDIT);

  // The "Matching actions" KPI used to come from an unbounded COUNT(*) run on
  // every page view. It must stay bounded by a LIMIT-ed row source.
  assert.doesNotMatch(source, /\.select\(\{\s*value:\s*count\(\)/);
  assert.match(source, /const COUNT_CEILING = MAX_PAGE \* PER_PAGE;/);
  assert.match(
    source,
    /SELECT count\(\*\)::text AS total\s*\n\s*FROM \(\s*\n\s*SELECT 1[\s\S]*?LIMIT \$\{COUNT_CEILING\}/,
  );

  // The ceiling has to stay tied to the page clamp: any smaller number would
  // change the count staff read on screen for a set the pager can still walk.
  assert.match(source, /const MAX_PAGE = 10_000;/);
  assert.match(source, /Math\.min\(filters\.page \?\? 1, MAX_PAGE\)/);
});

test("whop auto-ban list bounds its OFFSET and its page count", () => {
  const source = read(AUTO_BANS);

  // `?page=` arrives straight from the URL, so the offset must be clamped.
  assert.match(source, /const MAX_PAGE = 10_000;/);
  assert.match(
    source,
    /Math\.max\(1, Math\.min\(Math\.trunc\(input\.page \?\? 1\) \|\| 1, MAX_PAGE\)\)/,
  );
  assert.match(
    source,
    /pages: Math\.max\(1, Math\.min\(Math\.ceil\(total \/ limit\), MAX_PAGE\)\)/,
  );

  // Substring search is a deliberate choice here (no usable index exists on
  // this table for a prefix form) — see the comment above `searchFilter`.
  assert.match(source, /target_user_id ILIKE \$\{`%\$\{search\}%`\}/);
});
