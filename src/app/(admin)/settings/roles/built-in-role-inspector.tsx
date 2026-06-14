"use client";

import { useState } from "react";
import { Lock, ShieldCheck, FileText, KeyRound, Eye } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BaselineGroup } from "./roles-overview-data";

/**
 * READ-ONLY inspector for a built-in (locked) role's canonical baseline.
 *
 * Renders the role's baseline tokens (from `ROLE_BASELINES`, code-defined and
 * immutable) grouped by domain as DISABLED badges, with a clear "Locked"
 * banner. There are no editable controls — the owner forbids changing what a
 * built-in role grants; `updateRolePermissions` rejects built-ins server-side.
 *
 * `admin` is the total-bypass sentinel (its baseline is intentionally `[]`):
 * we show a distinct full-access note instead of an empty token grid.
 *
 * All data is serializable (no function props cross the RSC boundary).
 */
export function BuiltInRoleInspector({
  roleLabel,
  groups,
  pageCount,
  capabilityCount,
  bypass,
  triggerClassName,
}: {
  roleLabel: string;
  groups: BaselineGroup[];
  pageCount: number;
  capabilityCount: number;
  bypass: boolean;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn("h-8 gap-1.5", triggerClassName)}
          />
        }
      >
        <Eye className="size-3.5" />
        View baseline
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b p-4 sm:p-5">
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-600 ring-1 ring-inset ring-white/5 dark:text-amber-400">
              <Lock className="size-4" />
            </span>
            {roleLabel} baseline
            <Badge
              variant="outline"
              className="ml-1 gap-1 border-amber-500/30 bg-amber-500/10 text-[10px] font-medium text-amber-600 dark:text-amber-400"
            >
              <Lock className="size-3" />
              Locked
            </Badge>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Read-only inspector showing the canonical permission baseline for
            the {roleLabel} built-in role.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[calc(85vh-5rem)] space-y-4 overflow-y-auto p-4 sm:p-5">
          {/* Locked banner — explicit, can't be missed. */}
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            <Lock className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-amber-700 dark:text-amber-300/90">
              Locked — built-in role baselines can&apos;t be changed. To grant
              different access, create a custom role or set per-user access on a
              user&apos;s profile.
            </p>
          </div>

          {bypass ? (
            // admin: total bypass, no token list to show.
            <div className="rounded-lg border border-dashed bg-muted/40 p-4 text-sm text-muted-foreground">
              <p className="flex items-center gap-2 font-medium text-foreground">
                <ShieldCheck className="size-4 text-emerald-500" />
                Full access (gate bypass)
              </p>
              <p className="mt-1.5">
                The {roleLabel} role bypasses every page and capability check —
                its baseline is intentionally empty. Holders can reach every
                surface in the admin regardless of any page list.
              </p>
            </div>
          ) : groups.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/40 p-4 text-sm text-muted-foreground">
              This role grants nothing by default. Access for a holder is set
              per-user on their profile.
            </div>
          ) : (
            <>
              {/* Token-count summary chips. */}
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <FileText className="size-3.5 text-blue-500" />
                  {pageCount} page{pageCount === 1 ? "" : "s"}
                </span>
                <span className="text-border">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound className="size-3.5 text-amber-500" />
                  {capabilityCount} capabilit
                  {capabilityCount === 1 ? "y" : "ies"}
                </span>
              </div>

              {/* Grouped, disabled badges — read-only. */}
              <div className="space-y-4">
                {groups.map((group) => (
                  <div key={group.group} className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.group}
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {group.tokens.map((t) => (
                        <Badge
                          key={t.token}
                          variant="outline"
                          aria-disabled
                          title={t.token}
                          className={cn(
                            "cursor-default gap-1 font-normal",
                            t.kind === "page"
                              ? "border-blue-500/30 bg-blue-500/5 text-blue-600 dark:text-blue-400"
                              : t.kind === "value"
                                ? "border-purple-500/30 bg-purple-500/5 text-purple-600 dark:text-purple-400"
                                : "border-border bg-muted/40 text-foreground/80",
                          )}
                        >
                          {t.kind === "page" ? (
                            <FileText className="size-3" />
                          ) : (
                            <KeyRound className="size-3" />
                          )}
                          {t.label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
