import assert from "node:assert/strict";
import test from "node:test";
import type { AdminRole } from "../../src/lib/admin-roles";
import {
  compareAdminUsersByRole,
  groupAdminUsersByRole,
} from "../../src/app/(admin)/admin-users/admin-user-sort";

type FixtureAdmin = {
  name: string;
  isOwner: boolean;
  roles: AdminRole[];
};

test("sorts admin users by the requested role hierarchy", () => {
  const users: FixtureAdmin[] = [
    { name: "support", isOwner: false, roles: ["support"] },
    { name: "pack builder", isOwner: false, roles: ["pack_creator"] },
    { name: "marketing", isOwner: false, roles: ["marketing"] },
    { name: "admin", isOwner: false, roles: ["admin"] },
    { name: "owner", isOwner: true, roles: ["admin"] },
  ];

  assert.deepEqual(
    users.sort(compareAdminUsersByRole).map((user) => user.name),
    ["owner", "admin", "marketing", "pack builder", "support"],
  );
});

test("uses the highest-ranked role and leaves additional roles after support", () => {
  const users: FixtureAdmin[] = [
    { name: "creator", isOwner: false, roles: ["creator"] },
    { name: "support", isOwner: false, roles: ["support"] },
    {
      name: "marketing and support",
      isOwner: false,
      roles: ["support", "marketing"],
    },
  ];

  assert.deepEqual(
    users.sort(compareAdminUsersByRole).map((user) => user.name),
    ["marketing and support", "support", "creator"],
  );
});

test("builds visible non-empty role sections in the requested hierarchy", () => {
  const users: FixtureAdmin[] = [
    { name: "support", isOwner: false, roles: ["support"] },
    { name: "creator", isOwner: false, roles: ["creator"] },
    { name: "admin", isOwner: false, roles: ["admin"] },
    { name: "owner", isOwner: true, roles: ["admin"] },
    {
      name: "marketing and support",
      isOwner: false,
      roles: ["support", "marketing"],
    },
  ];

  assert.deepEqual(
    groupAdminUsersByRole(users).map(({ label, rows }) => ({
      label,
      users: rows.map((user) => user.name),
    })),
    [
      { label: "Owners", users: ["owner"] },
      { label: "Admins", users: ["admin"] },
      { label: "Marketing", users: ["marketing and support"] },
      { label: "Support", users: ["support"] },
      { label: "Other staff", users: ["creator"] },
    ],
  );
});
