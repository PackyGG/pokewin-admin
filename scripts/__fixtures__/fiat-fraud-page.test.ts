import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("the permission-gated Fiat Fraud route remains available without duplicate nav", () => {
  const adminPage = read("src/app/(admin)/transactions/deposits/page.tsx");
  const page = read("src/app/(antifraud)/antifraud/fiat-fraud/page.tsx");
  const sidebar = read(
    "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
  );
  const hosts = read("src/lib/app-hosts.ts");
  assert.match(page, /requireAntifraudPageAccess\(\)/);
  assert.match(page, /<FiatFraudContent/);
  assert.doesNotMatch(sidebar, /label: "Fiat Fraud"/);
  assert.doesNotMatch(sidebar, /href: "\/antifraud\/fiat-fraud"/);
  assert.match(hosts, /"fiat-fraud"/);
  assert.doesNotMatch(adminPage, /value: "fiat-fraud"/);
  assert.doesNotMatch(adminPage, /<FiatFraud(?:Tab|Content)/);
});

test("The retired Admin deep link redirects to Fraud with query state intact", () => {
  const adminPage = read("src/app/(admin)/transactions/deposits/page.tsx");
  const middleware = read("src/middleware.ts");
  assert.match(adminPage, /retiredFraudTab === "fiat-fraud"/);
  assert.match(adminPage, /absoluteOriginForBasePath\("\/antifraud"\)/);
  assert.match(
    adminPage,
    /retiredFraudTab === "refunds" \? "\/refunds" : "\/fiat-fraud"/,
  );
  assert.match(adminPage, /key === "tab"/);
  assert.match(adminPage, /destination\.searchParams\.append\(key, value\)/);
  assert.match(adminPage, /redirect\(destination\.toString\(\)\)/);
  assert.match(middleware, /pathname === "\/transactions\/deposits"/);
  assert.match(middleware, /retiredTransactionsTab === "fiat-fraud"/);
  assert.match(middleware, /fraudTransactionsRoute/);
  assert.match(middleware, /entry\.basePath === "\/antifraud"/);
  assert.match(middleware, /key !== "tab"/);
  assert.match(middleware, /NextResponse\.redirect\(url, 308\)/);
});

test("The retired Admin URL returns an HTTP redirect before any page mounts", async () => {
  process.env.SESSION_SECRET ??=
    "fiat-fraud-route-regression-only-secret-32-bytes";
  const [{ NextRequest }, { encrypt }, { middleware }] = await Promise.all([
    import("next/server"),
    import("../../src/lib/session"),
    import("../../src/middleware"),
  ]);
  const token = await encrypt({
    userId: "route-regression",
    role: "admin",
    roles: ["admin"],
    email: "route-regression@packy.gg",
    username: "route-regression",
    isOwner: false,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const request = new NextRequest(
    "https://packydash.com/transactions/deposits?tab=fiat-fraud&page=2&perPage=10&riskType=suspicious_deposit_cluster&source=whop_checkout&lockStatus=locked&search=route-regression",
    {
      headers: {
        cookie: `admin_session=${token}`,
        host: "packydash.com",
      },
    },
  );

  const response = await middleware(request);
  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get("location"),
    "https://fraud.packydash.com/fiat-fraud?page=2&perPage=10&riskType=suspicious_deposit_cluster&source=whop_checkout&lockStatus=locked&search=route-regression",
  );
  assert.equal(response.headers.get("x-middleware-rewrite"), null);
});

test("Fiat Fraud reads durable caught history with server-side controls", () => {
  const api = read("src/lib/antifraud/fiat-email-catches-api.ts");
  const content = read(
    "src/app/(antifraud)/antifraud/fiat-fraud/fiat-fraud-content.tsx",
  );
  const table = read(
    "src/app/(antifraud)/antifraud/fiat-fraud/fiat-fraud-table.tsx",
  );

  assert.match(api, /\/v1\/fiat-email-catches/);
  assert.match(api, /\/v1\/fiat-email-catch-users/);
  assert.match(api, /catchCount: z\.number\(\)\.int\(\)\.nonnegative\(\)/);
  assert.match(api, /withdrawalsLocked: z\.boolean\(\)/);
  assert.match(api, /userId: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(200\)/);
  assert.match(
    api,
    /depositIntentId: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(200\)\.nullable\(\)/,
  );
  assert.match(api, /page: String/);
  assert.match(api, /limit: String/);
  assert.match(api, /pagination: z\.object/);
  assert.match(api, /Math\.min\(10_000/);
  assert.match(api, /Math\.min\(100/);
  assert.match(api, /slice\(0, 100\)/);
  assert.match(api, /searchParams\.set\("search"/);
  assert.match(api, /searchParams\.set\("riskType"/);
  assert.match(api, /searchParams\.set\("source"/);
  assert.match(api, /"whop_checkout"/);
  assert.match(api, /"signup"/);
  assert.match(api, /searchParams\.set\("lockStatus"/);
  assert.match(api, /cache: "no-store"/);
  assert.match(content, /<Suspense/);
  assert.match(content, /h-72 w-full rounded-2xl/);
  assert.match(content, /DataTablePagination/);
  assert.match(table, /No fraudulent fiat deposits found/);
  assert.match(content, /Fiat fraud history is unavailable/);
  assert.match(content, /Durable fraud catches remain here/);
  assert.match(content, /getFiatEmailCatchUsers/);
  assert.match(content, /getFiatFraudUserDepositTotals/);
});

test("Fiat Fraud groups catches per user with total fiat deposits", () => {
  const table = read(
    "src/app/(antifraud)/antifraud/fiat-fraud/fiat-fraud-table.tsx",
  );
  const query = read("src/lib/queries/fiat-fraud.ts");

  assert.match(table, /key=\{row\.userId\}/);
  assert.match(
    table,
    /new Map\(rows\.map\(\(row\) => \[row\.userId, row\]\)\)/,
  );
  assert.match(table, /<FiatFraudCard key=\{row\.userId\}/);
  assert.doesNotMatch(table, /<Table(?:Head|Body|Row|Cell)?\b/);
  assert.match(table, /rounded-2xl border border-border\/70 bg-card shadow-sm/);
  assert.doesNotMatch(table, /h-1 bg-rose-500/);
  assert.match(table, /Total fiat deposits/);
  assert.match(table, /row\.catchCount/);
  assert.match(table, /paidTotalCents \/ 100/);
  assert.match(query, /GROUP BY user_id/);
  assert.match(query, /FILTER \(WHERE paid_at IS NOT NULL\)/);
});

test("Fiat Fraud rows link to exact users and deposits without MAIN writes", () => {
  const table = read(
    "src/app/(antifraud)/antifraud/fiat-fraud/fiat-fraud-table.tsx",
  );
  const query = read("src/lib/queries/fiat-fraud.ts");

  assert.match(table, /`https:\/\/\$\{ROOT_DOMAIN\}\$\{path\}`/);
  assert.match(table, /adminHref\(`\/users\/\$\{row\.userId\}`\)/);
  assert.match(
    table,
    /adminHref\(\s*`\/transactions\/card-payments\/\$\{row\.latestDepositIntentId\}`/,
  );
  assert.match(table, /Blocked email domain/);
  assert.match(table, /Suspicious deposit cluster/);
  assert.match(query, /getReadDrizzleDb/);
  assert.match(query, /fiat_deposit_intents/);
  assert.match(query, /slice\(0, 200\)/);
  assert.doesNotMatch(query, /\b(INSERT|UPDATE|DELETE)\b/);
});
