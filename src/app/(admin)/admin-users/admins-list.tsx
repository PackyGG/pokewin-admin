"use client";

import { useEffect } from "react";
import {
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { AdminUsersTable, type AdminUserRow } from "./admin-users-table";
import { AdminUsersGallery } from "./admin-users-gallery";
import {
  ADMINS_VIEW_STORAGE_KEY,
  parseAdminsViewMode,
} from "./view-mode";
import { groupAdminUsersByRole } from "./admin-user-sort";

/**
 * Client wrapper for the Admins list — switches between the Gallery (cards)
 * and Rows (table) presentation based on `?view=gallery|rows`.
 *
 * Source of truth is the URL param (SSR-friendly, default gallery), mirrored
 * to localStorage by the toggle. On mount, when the URL carries no explicit
 * `?view=` but localStorage holds a non-default choice, we re-apply it to the
 * URL so the user's last view sticks even when they return via a bare
 * /admin-users link. The toggle itself lives in the SectionHeading action.
 *
 * Both branches receive the SAME pre-shaped rows — no extra fetch, no DB
 * touch; this is a pure presentation switch.
 */
export function AdminsList({
  rows,
  isCurrentUserAdmin,
  currentUserId,
  rolesColumnExists,
}: {
  rows: AdminUserRow[];
  isCurrentUserAdmin: boolean;
  currentUserId: string;
  rolesColumnExists: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const rawView = searchParams.get("view");
  const view = parseAdminsViewMode(rawView);
  const groups = groupAdminUsersByRole(rows);

  // Re-apply a saved view when the URL has no explicit choice. Runs only when
  // `?view=` is absent, so an explicit URL/share link always wins.
  useEffect(() => {
    if (rawView !== null) return;
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(ADMINS_VIEW_STORAGE_KEY);
    } catch {
      saved = null;
    }
    if (!saved) return;
    const savedView = parseAdminsViewMode(saved);
    // Only push to the URL if it differs from the SSR default — avoids a
    // redundant replace when the saved value already matches gallery.
    if (savedView === view) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", savedView);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawView]);

  if (rows.length === 0) {
    return (
      <AdminUsersTable
        rows={rows}
        isCurrentUserAdmin={isCurrentUserAdmin}
        currentUserId={currentUserId}
        rolesColumnExists={rolesColumnExists}
      />
    );
  }

  return (
    <div className="space-y-8">
      {groups.map((group) => {
        const headingId = `admin-group-${group.key}`;

        return (
          <section
            key={group.key}
            aria-labelledby={headingId}
            className="space-y-3"
          >
            <div className="flex items-center gap-2 border-b border-border/60 pb-2">
              <h3
                id={headingId}
                className="text-xs font-semibold uppercase tracking-[0.14em] text-foreground"
              >
                {group.label}
              </h3>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                {group.rows.length}
              </span>
            </div>

            {view === "rows" ? (
              <AdminUsersTable
                rows={group.rows}
                isCurrentUserAdmin={isCurrentUserAdmin}
                currentUserId={currentUserId}
                rolesColumnExists={rolesColumnExists}
              />
            ) : (
              <AdminUsersGallery
                rows={group.rows}
                isCurrentUserAdmin={isCurrentUserAdmin}
                currentUserId={currentUserId}
                rolesColumnExists={rolesColumnExists}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}
