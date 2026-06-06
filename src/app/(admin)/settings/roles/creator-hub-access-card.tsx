"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ux";
import { setCreatorHubAccessToggle } from "./creator-hub-access-actions";

/**
 * One row's static metadata. The role KEY is the `admin_settings` toggle
 * role; label/description are display-only. Passed as plain serializable
 * data from the server card (no function props cross the RSC boundary).
 */
export type CreatorHubAccessRow = {
  role: string;
  label: string;
  description: string;
  /** Whether this role can currently be assigned to a user at all. */
  assignable: boolean;
};

/**
 * Founder-only ("motha") control surface for the two per-role Creator-Hub
 * access toggles. Each switch flips a single ADMIN-DB setting via a server
 * action (audit-logged). Both default OFF → only motha reaches the Hub
 * until an admin flips a toggle. Mirrors the house toggle pattern (shadcn
 * Switch + server action + sonner toast).
 */
export function CreatorHubAccessCard({
  rows,
  initialEnabled,
}: {
  rows: CreatorHubAccessRow[];
  /** role → enabled, the server-loaded current state. */
  initialEnabled: Record<string, boolean>;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState<Record<string, boolean>>(initialEnabled);
  const [pendingRole, setPendingRole] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleToggle(role: string, next: boolean) {
    // Optimistic flip; revert on failure.
    const previous = enabled[role] ?? false;
    setEnabled((prev) => ({ ...prev, [role]: next }));
    setPendingRole(role);
    startTransition(async () => {
      try {
        const res = await setCreatorHubAccessToggle(role, next);
        if (!res.success) {
          setEnabled((prev) => ({ ...prev, [role]: previous }));
          toast.error(res.error);
          return;
        }
        toast.success(
          next
            ? "Creator Hub access enabled for this role"
            : "Creator Hub access disabled for this role",
        );
        // Refresh so the sidebar portal (server-computed) reflects the change.
        router.refresh();
      } catch (err) {
        setEnabled((prev) => ({ ...prev, [role]: previous }));
        toast.error(
          err instanceof Error ? err.message : "Failed to update access",
        );
      } finally {
        setPendingRole(null);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-pink-500/15 text-pink-600 ring-1 ring-inset ring-pink-500/30 dark:text-pink-400">
            <Sparkles className="size-4" />
          </span>
          Creator Hub access
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Controls who can open the Creator Hub sub-app (the portal button and
          the route are gated by these toggles). The founder account
          (&ldquo;motha&rdquo;) always has access. Turn a role on to let every
          user with that role in. Both default to off.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((row) => {
          const isOn = enabled[row.role] ?? false;
          const rowPending = isPending && pendingRole === row.role;
          return (
            <div
              key={row.role}
              className="flex items-start justify-between gap-4 rounded-lg border bg-card/50 p-3"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{row.label}</span>
                  {!row.assignable && (
                    <Badge
                      variant="outline"
                      className="border-amber-500/30 bg-amber-500/10 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                    >
                      Not assignable yet
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {row.description}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 pt-0.5">
                {rowPending && <Spinner size={14} label="Saving…" />}
                <Switch
                  checked={isOn}
                  disabled={rowPending}
                  onCheckedChange={(checked) => handleToggle(row.role, checked)}
                  aria-label={`Toggle Creator Hub access for ${row.label}`}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
