import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const adminActions = readFileSync(
  join(root, "src/app/(admin)/admin-users/actions.ts"),
  "utf8",
);
const detailActions = readFileSync(
  join(root, "src/app/(admin)/admin-users/[id]/actions.ts"),
  "utf8",
);
const expenseMigration = readFileSync(
  join(
    root,
    "drizzle/admin/migrations/20260729_expenses_created_by_nullable.sql",
  ),
  "utf8",
);

test("admin deletion preserves financial records and audits only after commit", () => {
  const deleteAction = adminActions.slice(
    adminActions.indexOf("export async function deleteAdminUser"),
  );
  const transactionEnd = deleteAction.indexOf("  } catch (err)");
  const auditEvent = deleteAction.indexOf('eventType: "admin_user_deleted"');

  assert.match(
    deleteAction,
    /UPDATE expenses SET created_by_id = NULL WHERE created_by_id = \$\{adminUserId\}::uuid/,
  );
  assert.match(
    deleteAction,
    /UPDATE recurring_expenses SET created_by_id = NULL WHERE created_by_id = \$\{adminUserId\}::uuid/,
  );
  assert.doesNotMatch(deleteAction, /DELETE FROM (?:recurring_)?expenses\b/);
  assert.ok(transactionEnd >= 0 && auditEvent > transactionEnd);
  assert.match(
    expenseMigration,
    /ALTER TABLE expenses\s+ALTER COLUMN created_by_id DROP NOT NULL;/,
  );
  assert.match(
    expenseMigration,
    /ALTER TABLE recurring_expenses\s+ALTER COLUMN created_by_id DROP NOT NULL;/,
  );
});

test("MAIN user search uses the mirror while linking keeps the mutation client", () => {
  const searchStart = detailActions.indexOf(
    "export async function searchMainSiteUsers",
  );
  const linkStart = detailActions.indexOf(
    "export async function linkCreatorToMainUser",
  );
  const searchAction = detailActions.slice(searchStart, linkStart);
  const linkAction = detailActions.slice(linkStart);

  assert.ok(searchStart >= 0 && linkStart > searchStart);
  assert.match(searchAction, /const db = await getReadDrizzleDb\(\);/);
  assert.doesNotMatch(searchAction, /getPrimaryDrizzleDb/);
  assert.match(linkAction, /const db = await getPrimaryDrizzleDb\(\);/);
  assert.match(linkAction, /"__can_link_creator_main_user"/);
});
