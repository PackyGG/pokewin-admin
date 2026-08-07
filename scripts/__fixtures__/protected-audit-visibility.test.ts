import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("hifoen audit activity is protected by the shared owner-only boundary", () => {
  const boundary = read("src/lib/audit-visibility.ts");
  assert.match(boundary, /PROTECTED_AUDIT_ACTOR_USERNAMES = \["hifoen"\]/);
  assert.match(boundary, /return isOwner\(session\)/);
  assert.match(boundary, /NOT EXISTS/);
  assert.match(boundary, /lower\(protected_audit_actor\.username\) = ANY/);
});

test("every audit display query applies the protected-actor predicate", () => {
  const displayQueries = [
    "src/lib/queries/admin-users.ts",
    "src/lib/queries/users-admin-audit.ts",
    "src/lib/antifraud/staff-audit.ts",
    "src/lib/queries/creators-changelog.ts",
    "src/app/(admin)/notifications/_queries/direct-history.ts",
    "src/app/(creator-hub)/creator-hub/creators/[id]/_queries/creator-metadata.ts",
  ];

  for (const path of displayQueries) {
    assert.match(
      read(path),
      /(?:auditActorVisibilityPredicate|adminAuditEventVisibilityPredicate)/,
      `${path} must filter protected actors server-side`,
    );
  }

  assert.match(
    read("src/lib/antifraud/security-audit.ts"),
    /antifraudSecurityAuditActorVisibilityPredicate/,
  );
});

test("audit pages derive the bypass only from the DB-fresh owner session", () => {
  const pages = [
    "src/app/(admin)/admin-users/[id]/page.tsx",
    "src/app/(admin)/users/[id]/page.tsx",
    "src/app/(antifraud)/antifraud/audit/page.tsx",
    "src/app/(admin)/creators/changelog/page.tsx",
    "src/app/(admin)/notifications/page.tsx",
    "src/app/(creator-hub)/creator-hub/creators/[id]/page.tsx",
  ];

  for (const path of pages) {
    assert.match(
      read(path),
      /canViewProtectedAuditActivity\(session\)/,
      `${path} must derive visibility from the verified session`,
    );
  }
});
