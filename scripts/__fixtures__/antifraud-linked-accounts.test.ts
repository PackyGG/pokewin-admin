import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("Account Review surfaces exact-IP and high-confidence device links", async () => {
  const [query, workspace, dialog] = await Promise.all([
    read("src/lib/queries/user-fingerprint-alts.ts"),
    read("src/app/(antifraud)/antifraud/reviews/_components/review-case-workspace.tsx"),
    read("src/app/(antifraud)/antifraud/reviews/_components/linked-accounts-dialog.tsx"),
  ]);

  assert.match(query, /NULLIF\(BTRIM\(u\.signup_ip\), ''\) = source\.signup_ip/);
  assert.match(query, /f\.confidence >= 0\.9/);
  assert.match(query, /totalWithdrawn/);
  assert.match(workspace, /<LinkedAccountsDialog reviewId=\{review\.id\}/);
  assert.match(dialog, /Shared IP and fingerprint accounts/);
  assert.match(dialog, /evidence—not proof/);
  for (const fact of ["Deposited", "Withdrawn", "Wagered"]) {
    assert.match(dialog, new RegExp(`label="${fact}"`));
  }
});

test("linked-account mass ban is selected, protected, stepped-up, and identifier-safe", async () => {
  const actions = await read(
    "src/app/(antifraud)/antifraud/reviews/actions.ts",
  );
  const start = actions.indexOf("export async function massBanReviewLinkedAccounts");
  const end = actions.indexOf("export async function runQuickReviewAccountAction", start);
  const massBan = actions.slice(start, end);

  assert.match(massBan, /requireAntifraudManager\(\)/);
  assert.match(massBan, /require2FA\(session\.userId, parsed\.data\.credential\)/);
  assert.match(massBan, /!liveById\.get\(id\)\?\.canBan/);
  assert.match(massBan, /id = ANY\(/);
  assert.match(massBan, /shared_identifiers_blocked: false/);
  assert.doesNotMatch(massBan, /blockKnownUserIdentifiers\(/);
});
