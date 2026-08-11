import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("user fiat deposits bind checkout email through the exact intent", () => {
  const query = source("src/lib/queries/users-transactions.ts");

  assert.match(
    query,
    /requested\.ledger_id = i\.completed_ledger_id/,
    "the displayed ledger deposit must resolve its exact fiat intent",
  );
  assert.match(
    query,
    /payload #>> '\{data,metadata,deposit_intent_id\}'[\s\S]*= i\.id::text/,
    "the Whop event must name that exact fiat intent",
  );
  assert.match(query, /pwe\.event_type = 'payment\.created'/);
  assert.match(query, /pwe\.provider = 'whop'/);
  assert.match(
    query,
    /WHERE i\.user_id = \$\{userId\}/,
    "the intent must also belong to the viewed user",
  );
  assert.doesNotMatch(
    query.match(
      /async function fetchWhopCheckoutEmailsByLedgerId[\s\S]*?\n}\n/,
    )?.[0] ?? "",
    /provider_payment_id|provider_checkout_id|created_at\s*[<>=]/,
    "email enrichment must not guess by another provider id or timestamp",
  );
});

test("user transaction UI renders exact email and missing-email states", () => {
  const table = source("src/app/(admin)/users/[id]/user-tabs-transactions.tsx");
  const modal = source(
    "src/app/(admin)/users/[id]/transaction-detail-modal.tsx",
  );
  const types = source("src/app/(admin)/users/[id]/user-tabs-types.ts");

  assert.match(types, /whopCheckoutEmail\?: string \| null/);
  assert.match(table, /tx\.type === "deposit"/);
  assert.match(table, /tx\.whopCheckoutEmail !== undefined/);
  assert.match(table, /Whop email/);
  assert.match(table, /Unavailable/);
  assert.match(modal, /Whop checkout email/);
  assert.match(modal, /Unavailable/);
});

test("paid Fiat intents appear before ledger credit and expose review state", () => {
  const query = [
    source("src/lib/queries/users-transactions.ts"),
    source("src/lib/queries/users-fiat-intents.ts"),
  ].join("\n");
  const table = source("src/app/(admin)/users/[id]/user-tabs-transactions.tsx");
  const modal = source(
    "src/app/(admin)/users/[id]/transaction-detail-modal.tsx",
  );
  const types = source("src/app/(admin)/users/[id]/user-tabs-types.ts");

  assert.match(query, /FROM fiat_deposit_intents i/);
  assert.match(query, /i\.completed_ledger_id IS NULL/);
  assert.match(
    query,
    /i\.paid_at IS NOT NULL[\s\S]*provider_payment_status[\s\S]*'paid'/,
  );
  assert.match(query, /'ledger'::text AS source/);
  assert.match(query, /'fiat'::text AS source/);
  assert.match(query, /syntheticKind: "fiat_deposit"/);
  assert.match(query, /status === "review"/);
  assert.match(types, /return "In credit review"/);
  assert.match(table, /fiatDepositCreditLabel\(t\.fiatDepositIntentStatus\)/);
  assert.match(modal, /Fiat Deposit Details/);
  assert.match(modal, /Crediting status/);
  assert.match(modal, /Payment received/);
});
