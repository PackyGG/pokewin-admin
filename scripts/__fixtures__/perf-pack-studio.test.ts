import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

/**
 * Pack Studio read-budget guardrails.
 *
 * Every MAIN read in this app passes through a process-wide admission
 * semaphore sized to the mirror pool, so the number of reads a render issues —
 * not the speed of any single one — is what decides whether the tail of a page
 * blows its per-leg `safeQuery` budget and renders "Couldn't load this
 * section". These tests pin the read-count INVARIANTS the Pack Studio surfaces
 * were fixed to, not any tuning number (pool sizes / timeouts are deliberately
 * never asserted here).
 *
 * Source is read with `readFileSync` on purpose: these modules pull in the
 * database clients and `server-only`, so importing them from a plain node test
 * would either fail or open real connections.
 */

function read(relPath: string): string {
  return readFileSync(join(root, relPath), "utf8");
}

const SNAPSHOT = "src/app/(pack-studio)/pack-studio/_actions/snapshot.ts";
const HISTORY_PAGE = "src/app/(pack-studio)/pack-studio/history/page.tsx";
const HISTORY_ACTIONS = "src/app/(pack-studio)/pack-studio/history/actions.ts";
const DRAFT_DATA = "src/app/(pack-studio)/pack-studio/builder/draft-data.ts";

/**
 * `snapshotPackRisk` dropped its own `SELECT id FROM packs WHERE …` pre-read
 * and now calls `getPacksPoolComposition()` with no argument, whose DEFAULT
 * scope predicate must select the same packs. That equivalence is the whole
 * justification for removing the read: if the two pack-type scope lists ever
 * diverge, the snapshot would silently start scoring a different fleet.
 */
test("pack-studio snapshot scope == the composition read's default scope", () => {
  const riskConfig = read("src/app/(admin)/packs/_lib/risk-config.ts");
  const packQueries = read("src/lib/queries/packs.ts");

  const studioScope = riskConfig.match(
    /PACK_STUDIO_CASH_PACK_TYPES\s*=\s*\[([^\]]*)\]/,
  )?.[1];
  const repriceScope = packQueries.match(
    /REPRICE_INCLUDED_PACK_TYPES\s*=\s*\[([^\]]*)\]/,
  )?.[1];

  assert.ok(studioScope, "PACK_STUDIO_CASH_PACK_TYPES not found");
  assert.ok(repriceScope, "REPRICE_INCLUDED_PACK_TYPES not found");

  const normalize = (s: string) =>
    s
      .split(",")
      .map((v) => v.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
      .sort();

  assert.deepEqual(
    normalize(studioScope),
    normalize(repriceScope),
    "snapshotPackRisk relies on getPacksPoolComposition()'s default scope being the same pack-type set it scores — restore an explicit id filter before letting these diverge",
  );

  // …and the snapshot must not have grown a second MAIN pre-read back.
  const snapshot = read(SNAPSHOT);
  assert.ok(
    !/SELECT\s+id\s+FROM\s+packs/i.test(snapshot),
    "snapshotPackRisk re-added a separate pack-id read; getPacksPoolComposition() already applies that scope",
  );
});

/**
 * The history timeline resolves pack identity (MAIN), the captured_by admin
 * display names (ADMIN) and per-card identity (MAIN) from one snapshot list.
 * They are mutually independent and must stay in ONE parallel wave — the old
 * shape awaited them one after another, so the timeline cost four serial
 * round-trips before it could paint.
 */
test("history timeline resolves its three joins in one wave", () => {
  const src = read(HISTORY_PAGE);
  const wave = src.match(
    /const\s+\[meta,\s*adminRows,\s*cardMeta\]\s*=\s*await\s+Promise\.all\(\[([\s\S]*?)\]\);/,
  )?.[1];

  assert.ok(
    wave,
    "loadHistory no longer resolves meta / admin names / card meta in a single Promise.all",
  );
  assert.match(wave, /getPackMetaByIds\(/);
  assert.match(wave, /admin_users/);
  assert.match(wave, /getHistoryCardMeta\(/);

  // The empty-scope early return must stay ABOVE that wave: a view that
  // returns `null` should not pay for a pack-meta read it throws away.
  const guardAt = src.indexOf("if (snapshots.length === 0) return null;");
  const waveAt = src.indexOf("const [meta, adminRows, cardMeta]");
  assert.ok(guardAt > -1, "the no-snapshots early return went missing");
  assert.ok(
    guardAt < waveAt,
    "the no-snapshots early return must precede the join wave",
  );
});

/**
 * The "DIFF vs current" drawer reads the live pool ONCE. It used to read
 * `pack_cards ⋈ cards` for value+weight and then probe `cards` a second time
 * for name+image — the same rows, twice, serially.
 */
test("history live-pool diff is a single MAIN read", () => {
  const src = read(HISTORY_ACTIONS);
  assert.ok(
    !/getHistoryCardMeta/.test(src),
    "the live-pool diff re-added the redundant second cards read",
  );
  const selects = src.match(/\bSELECT\b/gi) ?? [];
  assert.equal(
    selects.length,
    1,
    "getLivePackPoolForDiff should issue exactly one SELECT",
  );
  // The one read must still carry every field the drawer renders.
  for (const column of ["pc.card_id", "c.price", "pc.weight", "c.name", "c.image_url"]) {
    assert.ok(
      src.includes(column),
      `the combined live-pool read dropped ${column}`,
    );
  }
});

/**
 * Loading a `?draft=` deep link must not serialize the ADMIN revision list
 * behind the MAIN card-metadata read (or vice versa) — they share no inputs.
 */
test("builder draft load runs its revision + card reads in parallel", () => {
  const src = read(DRAFT_DATA);
  const wave = src.match(
    /const\s+\[history,\s*result\]\s*=\s*await\s+Promise\.all\(\[([\s\S]*?)\]\);/,
  )?.[1];
  assert.ok(
    wave,
    "loadPackBuilderDraft no longer batches the revision list with the card read",
  );
  assert.match(wave, /listPackBuildDraftRevisions\(/);
  assert.match(wave, /FROM cards/);
});

/**
 * Every Pack Studio page must render its shell before any data read — the
 * route-level `loading.tsx` is what makes that visible on a cold navigation.
 */
test("every pack-studio page segment ships a loading.tsx", () => {
  const pages = [
    "",
    "/builder",
    "/builder-drafts",
    "/cards",
    "/cards/[id]",
    "/doctor",
    "/drafts",
    "/history",
    "/new-packs",
    "/packs",
    "/packs/[id]",
    "/retune",
  ];
  for (const segment of pages) {
    const dir = `src/app/(pack-studio)/pack-studio${segment}`;
    assert.doesNotThrow(
      () => read(`${dir}/loading.tsx`),
      `${dir} has a page but no loading.tsx shell`,
    );
  }
});
