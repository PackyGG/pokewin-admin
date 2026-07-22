"use client";

/**
 * Bulk-ban control for /users. Admin/owner only — the parent decides whether
 * to render it, and `bulkBanFilteredUsers` re-checks server-side because a
 * render gate is not a security boundary.
 *
 * There is no delete counterpart, by design: deleting would orphan ledger
 * rows, break the hash-chained audit trail, and null out `fingerprints.user_id`
 * — destroying the alt-detection evidence that justifies the ban in the first
 * place. Ban is reversible; delete is not.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bulkBanFilteredUsers } from "./actions";

/** Typed verbatim to arm the button — a deliberate speed bump. */
const CONFIRM_PHRASE = "BAN";

export type BulkBanFilters = {
  role?: string;
  status?: string;
  deposited?: string;
  provider?: string;
  sharedIp?: string;
  sharedDevice?: string;
  freeOnly?: string;
  affiliateCode?: string;
  affiliateOwnerId?: string;
};

export function BulkBanButton({
  filters,
  matchCount,
}: {
  filters: BulkBanFilters;
  /**
   * Rows the CURRENT filter matched. Sent back to the server, which aborts
   * if its own count disagrees — so a signup landing between preview and
   * confirm can't silently widen the blast radius.
   */
  matchCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const activeFilters = Object.entries(filters).filter(([, v]) => !!v);
  const armed =
    reason.trim().length > 0 &&
    confirm === CONFIRM_PHRASE &&
    matchCount > 0 &&
    activeFilters.length > 0 &&
    !pending;

  const submit = () => {
    if (!armed) return;
    startTransition(async () => {
      const result = await bulkBanFilteredUsers({
        filters,
        reason: reason.trim(),
        expectedCount: matchCount,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `Banned ${result.data.bannedCount.toLocaleString()} account${result.data.bannedCount === 1 ? "" : "s"}.`,
      );
      setOpen(false);
      setReason("");
      setConfirm("");
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setReason("");
          setConfirm("");
        }
      }}
    >
      {/* Base UI (not Radix): Trigger renders its own <button>, so the
          styles go straight on it — there is no `asChild`. */}
      <DialogTrigger className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 text-xs font-medium text-rose-600 transition-colors hover:bg-rose-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-rose-400">
        <Ban className="size-3.5" />
        Bulk ban
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogTitle className="flex items-center gap-2">
          <Ban className="size-4 text-rose-500" />
          Ban {matchCount.toLocaleString()} account
          {matchCount === 1 ? "" : "s"}
        </DialogTitle>
        <DialogDescription>
          Every account matching the current filter is banned and signed out
          immediately. Already-banned accounts, admins and support are skipped.
          Nothing is deleted — this is reversible.
        </DialogDescription>

        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
          <div className="mb-1.5 font-medium text-muted-foreground">
            Matching on
          </div>
          {activeFilters.length === 0 ? (
            <p className="text-rose-500">
              No filters active — select at least one first.
            </p>
          ) : (
            <ul className="space-y-0.5 font-mono text-muted-foreground">
              {activeFilters.map(([k, v]) => (
                <li key={k}>
                  {k} = {v}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="bulk-ban-reason">Reason</Label>
          <Input
            id="bulk-ban-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="bulk:signup-farm-2026-06-12"
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Stored on every account — make it a marker you can search and undo
            by later.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="bulk-ban-confirm">
            Type <span className="font-mono">{CONFIRM_PHRASE}</span> to confirm
          </Label>
          <Input
            id="bulk-ban-confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="h-9 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!armed}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-rose-600 px-3 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            {pending ? "Banning…" : `Ban ${matchCount.toLocaleString()}`}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
