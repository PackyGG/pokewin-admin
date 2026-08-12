import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Guardrails for the rewards/community route area: /rain/[id], /chat-raffle,
 * /chat-raffle/[id], /vips, /vouchers, /promo-codes/[id], plus the client
 * pickers under /challenges and /vouchers.
 *
 * Source is READ, never imported: these are Next Server Components (and this
 * fixture runs from the repo root, where only root dependencies exist — a
 * runtime import of a service workspace would break the Vercel build).
 *
 * The invariants pinned here are SHAPES, not tuning numbers. No pool size,
 * permit count or timeout value is asserted — only that a read is bounded,
 * guarded and streamed.
 */
const read = (relativePath: string) =>
  readFileSync(path.join(process.cwd(), relativePath), "utf8");

const ADMIN = "src/app/(admin)";

const promoDetail = read(`${ADMIN}/promo-codes/[id]/page.tsx`);
const rainDetail = read(`${ADMIN}/rain/[id]/page.tsx`);
const raffleDetail = read(`${ADMIN}/chat-raffle/[id]/page.tsx`);
const rafflePage = read(`${ADMIN}/chat-raffle/page.tsx`);
const vipsPage = read(`${ADMIN}/vips/page.tsx`);
const vouchersPage = read(`${ADMIN}/vouchers/page.tsx`);
const cardSummary = read(`${ADMIN}/challenges/challenge-card-summary.tsx`);
const itemPicker = read(`${ADMIN}/challenges/item-picker.tsx`);
const voucherDialog = read(`${ADMIN}/vouchers/create-dialog.tsx`);

const SERVER_PAGES: [string, string][] = [
  ["promo-codes/[id]", promoDetail],
  ["rain/[id]", rainDetail],
  ["chat-raffle/[id]", raffleDetail],
  ["chat-raffle", rafflePage],
  ["vips", vipsPage],
  ["vouchers", vouchersPage],
];

/**
 * Auth/session helpers are not data reads — they are the DAL's own gate and
 * must stay on the critical path. Everything else beginning `get…` is a query.
 */
const DAL_AWAIT_ALLOWLIST = /^await (?:getUserPermissions|getDefaultRoute)\b/;

test("no page read escapes safeQuery — a slow leg degrades its own section", () => {
  // A wrapped read is passed as a THUNK — `safeQuery(() => getX(...))` — so a
  // literal `await getX(` is by construction an UNWRAPPED read. Unwrapped reads
  // are what produce the whole-route failures the owner sees: <Suspense>
  // catches suspension, not errors, so a throw inside a streamed child skips
  // every rendered sibling and lands on the segment error boundary.
  for (const [name, source] of SERVER_PAGES) {
    const bare = [...source.matchAll(/await get[A-Z]\w*\(/g)]
      .map((m) => m[0])
      .filter((m) => !DAL_AWAIT_ALLOWLIST.test(m));
    assert.deepEqual(
      bare,
      [],
      `${name}: these reads are awaited directly instead of through safeQuery/safeQueryOrNull`,
    );
  }
});

test("a transient read failure can never render as a 404 on a detail route", () => {
  // `notFound()` after a bare `await` conflates "this row does not exist" with
  // "the mirror was busy". Each detail route must resolve its critical read
  // through safeQueryOrNull and 404 ONLY on a clean null.
  for (const [name, source] of [
    ["promo-codes/[id]", promoDetail],
    ["rain/[id]", rainDetail],
    ["chat-raffle/[id]", raffleDetail],
  ] as [string, string][]) {
    assert.match(
      source,
      /safeQueryOrNull\(/,
      `${name}: critical detail read must go through safeQueryOrNull`,
    );
    assert.match(
      source,
      /if\s*\(!error\)\s*notFound\(\);/,
      `${name}: notFound() must be reachable only when the read succeeded and returned nothing`,
    );
    assert.match(
      source,
      /InlineError/,
      `${name}: a degraded critical read must render a retryable band, not a 404`,
    );
  }
});

test("detail routes are shell-first — the hero never waits on a query", () => {
  // CLAUDE.md §2: PageHero + static controls paint immediately and data loads
  // in an async child behind <Suspense>. The page body may only await the
  // route's own params and the access gate.
  for (const [name, source] of [
    ["promo-codes/[id]", promoDetail],
    ["rain/[id]", rainDetail],
    ["chat-raffle/[id]", raffleDetail],
  ] as [string, string][]) {
    const start = source.indexOf("export default async function");
    assert.ok(start > 0, `${name}: no default-exported page component`);
    // The page body ends where the first module-level `async function` helper
    // begins; helpers are the streamed children and may await freely.
    const nextDecl = source.indexOf("\nasync function ", start);
    const body = source.slice(start, nextDecl > 0 ? nextDecl : undefined);

    const heroAt = body.indexOf("<PageHero>");
    assert.ok(heroAt > 0, `${name}: page body must render <PageHero> itself`);
    assert.match(
      body,
      /<Suspense/,
      `${name}: page body must stream its data behind <Suspense>`,
    );

    const awaits = [...body.matchAll(/await\s+([A-Za-z_$][\w$]*)/g)].map(
      (m) => m[1],
    );
    for (const call of awaits) {
      assert.ok(
        ["params", "searchParams", "requirePageAccess"].includes(call),
        `${name}: page body awaits ${call}() before the shell — move it into the streamed child`,
      );
    }
  }
});

test("every detail route ships a matching loading.tsx shell", () => {
  for (const route of [
    "promo-codes/[id]",
    "rain/[id]",
    "chat-raffle/[id]",
    "chat-raffle",
    "vips",
    "vouchers",
  ]) {
    const loading = read(`${ADMIN}/${route}/loading.tsx`);
    assert.match(
      loading,
      /export default function/,
      `${route}: loading.tsx must export a shell component`,
    );
  }
});

test("only the active tab's list read runs on /vouchers", () => {
  // Active-tab-only (CLAUDE.md): hovering the other tab must not warm the
  // claimed-list read plus its FTD enrichment.
  assert.match(vouchersPage, /prefetch=\{false\}/);
  // The list read is keyed on every query input so a tab/filter flip re-shows
  // the skeleton instead of blocking on the previous render.
  assert.match(vouchersPage, /<Suspense\s+key=\{`\$\{tab\}/);
});

test("client pickers guard against an out-of-order response", () => {
  // Under the mirror's read admission cap a slower earlier request can resolve
  // AFTER a newer one. Without a request-id guard the dropdown/summary repaints
  // with results for a query the operator has already moved past — and both of
  // these feed a decision that mints real value (a voucher's recipient, a
  // challenge prize sized against a card's odds).
  for (const [name, source] of [
    ["challenges/challenge-card-summary", cardSummary],
    ["challenges/item-picker", itemPicker],
    ["vouchers/create-dialog", voucherDialog],
  ] as [string, string][]) {
    assert.match(
      source,
      /requestIdRef/,
      `${name}: async result must be discarded when a newer request superseded it`,
    );
    assert.match(
      source,
      /reqId\s*[=!]==\s*requestIdRef\.current/,
      `${name}: the guard must actually compare the captured id against the latest`,
    );
  }
});

test("the challenge item pickers stay lazy and debounced", () => {
  // The pack/card search is a leading-wildcard scan on MAIN. It must only run
  // while the popover is OPEN (drawers/modals run no heavy query before they
  // open) and must be debounced rather than firing per keystroke.
  assert.match(itemPicker, /if\s*\(!open\)\s*return;/);
  assert.match(itemPicker, /DEBOUNCE_MS/);
  assert.match(voucherDialog, /if \(query\.length < 2\)/);
});
