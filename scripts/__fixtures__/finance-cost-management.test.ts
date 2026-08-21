import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("finance cost pages are owner-gated and read the Admin database", () => {
  const expensesPage = read("src/app/(admin)/finances/expenses/page.tsx");
  const subscriptionsPage = read(
    "src/app/(admin)/finances/subscriptions/page.tsx",
  );
  const query = read("src/lib/queries/finance-costs.ts");

  assert.match(expensesPage, /await requireMotha\(\)/);
  assert.match(subscriptionsPage, /await requireMotha\(\)/);
  assert.match(query, /adminDrizzle/);
  assert.match(query, /\.from\(expenses\)/);
  assert.match(query, /\.from\(recurring_expenses\)/);
  assert.doesNotMatch(query, /mainDb|prodDb|production/i);
});

test("every finance cost mutation authenticates and records an audit event", () => {
  const actions = read("src/app/(admin)/finances/actions.ts");
  const actionNames = [
    "createExpense",
    "updateExpense",
    "deleteExpense",
    "createSubscription",
    "updateSubscription",
    "toggleSubscription",
    "deleteSubscription",
  ];

  for (const [index, name] of actionNames.entries()) {
    const start = actions.indexOf(`export async function ${name}`);
    const end =
      index + 1 < actionNames.length
        ? actions.indexOf(`export async function ${actionNames[index + 1]}`)
        : actions.length;
    assert.ok(start >= 0, `${name} is missing`);
    const body = actions.slice(start, end);
    assert.match(body, /await requireMotha\(\)/, `${name} is not owner-gated`);
    assert.match(body, /createAdminAuditEvent/, `${name} is not audited`);
  }

  assert.match(actions, /revalidatePath\("\/finances\/expenses"\)/);
  assert.match(actions, /revalidatePath\("\/finances\/subscriptions"\)/);
});

test("cost forms expose safe CRUD and recurring status controls", () => {
  const expenses = read(
    "src/app/(admin)/finances/expenses/expenses-client.tsx",
  );
  const subscriptions = read(
    "src/app/(admin)/finances/subscriptions/subscriptions-client.tsx",
  );

  assert.match(expenses, /createExpense\(form\)/);
  assert.match(expenses, /updateExpense\(item\.id, form\)/);
  assert.match(expenses, /deleteExpense\(item\.id\)/);
  assert.match(expenses, /AlertDialogTitle>Delete this expense/);

  assert.match(subscriptions, /createSubscription\(form\)/);
  assert.match(subscriptions, /updateSubscription\(item\.id, form\)/);
  assert.match(
    subscriptions,
    /toggleSubscription\(item\.id, !item\.isActive\)/,
  );
  assert.match(subscriptions, /deleteSubscription\(item\.id\)/);
  assert.match(subscriptions, /AlertDialogTitle>Delete this subscription/);
  assert.doesNotMatch(
    subscriptions,
    /subscription-category|subscription-notes/,
  );
  assert.doesNotMatch(subscriptions, /item\.(?:category|notes)/);
  assert.match(subscriptions, /SUBSCRIPTION_SERVICES\.map/);
  assert.match(subscriptions, /<SelectItem value=\{CUSTOM_SERVICE\}>/);
  assert.match(subscriptions, /<DialogFooter className="static mx-0/);
  assert.doesNotMatch(subscriptions, /sm:grid-cols-\[minmax/);
});

test("subscriptions match common vendors to branded logos", () => {
  const brands = read(
    "src/app/(admin)/finances/subscriptions/subscription-brand.tsx",
  );
  const client = read(
    "src/app/(admin)/finances/subscriptions/subscriptions-client.tsx",
  );

  for (const vendor of [
    "Linear",
    "Google",
    "GitHub",
    "AWS",
    "Vercel",
    "Whop",
    "CoinGecko",
    "Hetzner",
    "ImageKit",
    "Adobe Photoshop",
    "Intercom",
    "X / Twitter",
  ]) {
    assert.match(brands, new RegExp(`label: "${vendor}"`));
  }
  assert.match(brands, /export const SUBSCRIPTION_SERVICES/);
  assert.match(client, /<SubscriptionBrand name=\{item\.name\} \/>/);
});
