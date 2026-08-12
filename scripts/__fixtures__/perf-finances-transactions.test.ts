import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Read-only source guardrails for the /finances and /transactions read
 * paths. Every MAIN read passes through a process-wide admission semaphore
 * sized to the mirror pool, so the thing that actually decides whether a
 * page paints or renders "Couldn't load this section" is the NUMBER of
 * reads a render issues and how many of them are strictly serial. These
 * tests pin those structural invariants — never a tuning number (pool
 * size, timeout), which is free to move.
 *
 * Source is read with `readFileSync` rather than imported: these modules
 * pull in server-only DB clients, and a fixture must stay importable in a
 * bare `node --test` run.
 */
const read = (path: string) => readFileSync(path, "utf8");

const TRANSACTIONS_QUERY = "src/lib/queries/transactions.ts";
const FINANCES_PAGE = "src/app/(admin)/finances/page.tsx";

/**
 * The transaction-detail read already SELECTs the session row (game_type,
 * game_id) and every PF row (including `battle_id`) for the session it
 * resolves. The battle-link resolution used to re-SELECT exactly those
 * facts for `tx.game_session_id`, so a normal pack/battle detail paid two
 * round trips for one row. That correlated `battle_id` subquery must exist
 * in exactly ONE place — the narrow fallback used only when the fan-out
 * did not cover that session id.
 */
test("transaction detail keeps one battle-link lookup, used as a fallback only", () => {
  const source = read(TRANSACTIONS_QUERY);

  const subqueryOccurrences = source.split(
    "SELECT pf.battle_id",
  ).length - 1;
  assert.equal(
    subqueryOccurrences,
    1,
    "the correlated battle_id subquery is duplicated — the detail fan-out is re-reading a session row it already has",
  );

  // …and the detail path must actually hand its loaded facts over, rather
  // than always forcing the fallback query.
  assert.match(
    source,
    /battleInfoPromise = resolveBattleInfo\(\s*tx\.game_session_id,\s*tx\.metadata,\s*knownBattleLink,\s*\)/,
    "the detail fan-out no longer passes its already-loaded session facts to resolveBattleInfo",
  );
  assert.match(
    source,
    /resolvedSessionId === tx\.game_session_id/,
    "the reuse guard that proves the loaded session covers tx.game_session_id is gone",
  );
});

/**
 * The battle read must not be a strictly serial tail wave. It is started as
 * soon as the session facts are known so it overlaps the packs / related /
 * cards waves, and awaited once at the end.
 */
test("transaction detail overlaps the battle read instead of tailing it", () => {
  const source = read(TRANSACTIONS_QUERY);

  const kickoffAt = source.indexOf("battleInfoPromise = resolveBattleInfo(");
  const awaitAt = source.indexOf("await (battleInfoPromise ??");
  assert.ok(kickoffAt > 0, "the battle lookup is no longer started early");
  assert.ok(awaitAt > 0, "the battle lookup is no longer awaited via its handle");
  assert.ok(
    kickoffAt < awaitAt,
    "the battle lookup must be started before the heavy waves and awaited after them",
  );

  // An early rejection must stay handled, or a later wave throwing first
  // turns this into an unhandled rejection.
  assert.match(
    source,
    /battleInfoPromise\.catch\(\(\) => \{\}\)/,
    "the early-started battle promise has no attached catch",
  );
});

/**
 * The transactions list enriches the visible page with three lookups
 * (battle borrow %, per-session voucher excess, upgrader targets). All
 * three derive from the already-fetched rows and none consumes another's
 * output, so they must go out as ONE parallel wave. Serialised, they add
 * three round trips to the tail of a read that is already competing for
 * globally capped mirror slots.
 */
test("transactions list batches its auxiliary lookups into one wave", () => {
  const source = read(TRANSACTIONS_QUERY);

  assert.match(
    source,
    /await Promise\.all\(\[\s*loadBattleBorrowMap\([^)]*\),\s*loadVoucherValueBySession\([^)]*\),[\s\S]{0,200}?fetchUpgraderTargetByLedgerTxIds\(/,
    "the borrow / voucher / upgrader lookups are no longer issued as a single parallel wave",
  );

  // Each auxiliary lookup owns its failure: the ledger rows are the page,
  // the badges are decoration. A throw must not take the table down.
  for (const loader of ["loadBattleBorrowMap", "loadVoucherValueBySession"]) {
    const body = source.slice(
      source.indexOf(`async function ${loader}(`),
      source.indexOf(`async function ${loader}(`) + 1400,
    );
    assert.ok(
      body.includes("try {") && body.includes("catch"),
      `${loader} lost its graceful-degrade guard`,
    );
  }
});

/**
 * The four finance tiles have very different costs (one Admin-DB aggregate
 * vs a MAIN-mirror reward/creator fan-out). Awaiting them together made
 * every tile wait for the slowest, and a leg burning its full safeQuery
 * budget held the whole grid blank before painting three good tiles next
 * to one failure band. Each tile owns its own boundary now.
 */
test("finances streams each tile on its own boundary", () => {
  const source = read(FINANCES_PAGE);

  assert.doesNotMatch(
    source,
    /await Promise\.all\(/,
    "the finance tiles are batched into one await again — one slow leg blanks the whole grid",
  );

  const boundaries = source.split("<Suspense").length - 1;
  assert.ok(
    boundaries >= 5,
    `expected a boundary per finance tile, found ${boundaries}`,
  );
});

/**
 * The overview component must stay SYNCHRONOUS. The moment it awaits
 * anything, the static Profit header — which carries the period chips, the
 * control the admin uses to switch windows — goes back behind the data
 * boundary and disappears on every switch.
 */
test("finances renders its period control without waiting on a read", () => {
  const source = read(FINANCES_PAGE);

  assert.doesNotMatch(
    source,
    /async function FinancesOverview/,
    "FinancesOverview became async — the period chips are gated on data again",
  );

  const overviewAt = source.indexOf("function FinancesOverview");
  const chipsAt = source.indexOf("<PeriodChips");
  const contentBoundaryAt = source.indexOf("<ProfitCardContent");
  assert.ok(overviewAt > 0 && chipsAt > overviewAt, "PeriodChips moved out of the overview");
  assert.ok(
    chipsAt < contentBoundaryAt,
    "PeriodChips must render above the streamed profit content, not inside it",
  );
});

/**
 * Under a global read cap, a duplicated query costs more than a slow one.
 * When the selected window IS the accounting week, both cards want the
 * same number, so they must share one promise rather than issuing a second
 * P&L read.
 */
test("finances does not read the weekly P&L twice when the week is selected", () => {
  const source = read(FINANCES_PAGE);

  assert.match(
    source,
    /period === "7d"\s*\?\s*profitPromise/,
    "the 7d window no longer reuses the selected-period P&L promise — that is a duplicate MAIN read",
  );
});
