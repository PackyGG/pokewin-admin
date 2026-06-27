"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ux";
import { setPackStudioUserAccess } from "../_actions/user-access";

/**
 * One row in the per-username Pack Studio access card. The server resolves the
 * current state (allowlisted, denylisted, role-default) and the display label;
 * the client just flips the switch via the server action.
 *
 * All fields are serializable primitives — no function props cross the RSC
 * boundary (Next.js 15 / RSC rule).
 */
export type PackStudioUserAccessRow = {
  /** Lowercased username (matches the stored override list). */
  username: string;
  /** Display label (preferred display name, falls back to username). */
  displayName: string;
  /** Whether the admin currently has admin-role default access. */
  hasAdminRole: boolean;
  /** Whether the admin is an owner (cannot be revoked). */
  isOwner: boolean;
  /** Whether the admin is on the explicit allowlist. */
  allowlisted: boolean;
  /** Whether the admin is on the explicit denylist (overrides everything below owner). */
  denylisted: boolean;
};

/**
 * Owner-only ("motha" + any `is_owner=true`) control surface for the
 * per-username Pack Studio access overrides. Each switch flips a single
 * ADMIN-DB setting via a server action (audit-logged). The denylist always
 * wins, so flipping a row OFF revokes a user's Studio access in one click
 * even if their admin role would otherwise grant it.
 *
 * Owners can never be denied — those rows are rendered read-only as a
 * locked, always-on switch with an explanatory badge.
 *
 * Mirrors the Creator Hub access card (shadcn Switch + server action +
 * sonner toast + optimistic flip with revert on failure).
 */
export function PackStudioUserAccessCard({
  rows: initialRows,
}: {
  rows: PackStudioUserAccessRow[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<PackStudioUserAccessRow[]>(initialRows);
  const [pendingUsername, setPendingUsername] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleToggle(username: string, next: boolean) {
    const before = rows;
    // Optimistic flip: ON = allowlisted (denylisted false); OFF = denylisted
    // (allowlisted false). Mirrors the server action's transition exactly.
    setRows((prev) =>
      prev.map((row) =>
        row.username === username
          ? {
              ...row,
              allowlisted: next,
              denylisted: !next,
            }
          : row,
      ),
    );
    setPendingUsername(username);
    startTransition(async () => {
      try {
        const res = await setPackStudioUserAccess(username, next);
        if (!res.success) {
          setRows(before);
          toast.error(res.error);
          return;
        }
        toast.success(
          next
            ? `Pack Studio access enabled for ${username}`
            : `Pack Studio access revoked for ${username}`,
        );
        // Refresh so the sidebar portal (server-computed) reflects the change.
        router.refresh();
      } catch (err) {
        setRows(before);
        toast.error(
          err instanceof Error ? err.message : "Failed to update access",
        );
      } finally {
        setPendingUsername(null);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-purple-500/15 text-purple-600 ring-1 ring-inset ring-purple-500/30 dark:text-purple-400">
            <ShieldCheck className="size-4" />
          </span>
          Pack Studio access
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Owner-only. Flip a switch to grant or revoke Pack Studio access for a
          specific admin. The deny list overrides the admin-role default, so
          you can revoke an admin&rsquo;s Studio access with one click without
          touching their role. Owners always have access and cannot be denied.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tracked accounts yet.
          </p>
        ) : (
          rows.map((row) => {
            const rowPending = isPending && pendingUsername === row.username;
            // Effective access state: owners always on; otherwise denylist
            // wins, then allowlist, then role default.
            const effectiveOn = row.isOwner
              ? true
              : row.denylisted
                ? false
                : row.allowlisted || row.hasAdminRole;
            const tag = row.isOwner
              ? { text: "Owner", tint: "amber" as const }
              : row.denylisted
                ? { text: "Revoked", tint: "rose" as const }
                : row.allowlisted
                  ? { text: "Granted", tint: "emerald" as const }
                  : row.hasAdminRole
                    ? { text: "Admin role default", tint: "blue" as const }
                    : { text: "No access", tint: "rose" as const };
            const tagClass =
              tag.tint === "emerald"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : tag.tint === "rose"
                  ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                  : tag.tint === "amber"
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    : "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400";
            return (
              <div
                key={row.username}
                className="flex items-start justify-between gap-4 rounded-lg border bg-card/50 p-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{row.displayName}</span>
                    <Badge variant="outline" className={`${tagClass} text-[10px] font-medium`}>
                      {tag.text}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    @{row.username}
                    {row.hasAdminRole ? " · admin role" : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2 pt-0.5">
                  {rowPending && <Spinner size={14} label="Saving…" />}
                  <Switch
                    checked={effectiveOn}
                    disabled={rowPending || row.isOwner}
                    onCheckedChange={(checked) =>
                      handleToggle(row.username, checked)
                    }
                    aria-label={`Toggle Pack Studio access for ${row.displayName}`}
                  />
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
