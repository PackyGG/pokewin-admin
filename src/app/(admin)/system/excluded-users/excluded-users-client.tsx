"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";

import type { ExcludedUserRow } from "@/lib/excluded-users/fetch";

import { addExcludedUser, removeExcludedUser } from "./actions";

/**
 * Client wrapper for the excluded-users management page. Initial rows
 * come from the server component; mutations go through server actions
 * that revalidate the route, and router.refresh() re-pulls the list.
 *
 * Add and remove both use controlled state — the add form sits above
 * the table and stays open across multiple inserts so an admin can
 * paste several IDs in a row without re-opening anything.
 */
export function ExcludedUsersClient({
  initial,
}: {
  initial: ExcludedUserRow[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");

  function handleAdd() {
    const trimmed = userId.trim();
    if (!trimmed) {
      toast.error("Paste a user ID first");
      return;
    }
    startTransition(async () => {
      try {
        const result = await addExcludedUser({
          userId: trimmed,
          reason: reason.trim() || undefined,
        });
        if (result.inserted === 0) {
          toast.info("That user ID is already excluded");
        } else {
          toast.success("User excluded");
          // Only clear the inputs on a successful insert so a duplicate
          // submission doesn't lose what the admin typed.
          setUserId("");
          setReason("");
        }
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to add");
      }
    });
  }

  return (
    <div className="space-y-4">
      {/* Add form — sits above the table so it's the first thing the
          admin sees. Stays open across inserts (no modal) since this
          flow is typically multiple IDs in a row. */}
      <div className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium">Add a user to the blacklist</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor="excluded-user-id" className="text-xs">
              User ID
            </Label>
            <Input
              id="excluded-user-id"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="R3cqeAyDdNQNbltwnQQJuJUHiqjiNw98"
              className="font-mono text-xs"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAdd();
                }
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="excluded-user-reason" className="text-xs">
              Reason{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="excluded-user-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Internal test account / hand-picked outlier"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAdd();
                }
              }}
            />
          </div>
          <Button onClick={handleAdd} disabled={isPending} size="sm">
            <Plus className="size-4" />
            {isPending ? "Adding…" : "Add"}
          </Button>
        </div>
      </div>

      {/* Existing blacklist */}
      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User ID</TableHead>
              <TableHead className="text-right">Total Deposited</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Excluded by</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="w-[80px] text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {initial.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="h-24 text-center text-sm text-muted-foreground"
                >
                  No excluded users yet.
                </TableCell>
              </TableRow>
            ) : (
              initial.map((row) => (
                <TableRow key={row.userId}>
                  <TableCell className="font-mono text-xs">
                    {row.userId}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {row.totalDeposited > 0 ? (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(row.totalDeposited)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.reason ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.excludedByUsername}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDateTime(row.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <RemoveButton userId={row.userId} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function RemoveButton({ userId }: { userId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleRemove() {
    startTransition(async () => {
      try {
        await removeExcludedUser(userId);
        toast.success("User un-excluded — metrics will include their activity again");
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to remove");
        setOpen(false);
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            disabled={isPending}
            className="size-8 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
            aria-label="Remove from blacklist"
          />
        }
      >
        <Trash2 className="size-4" />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove from blacklist?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono text-xs">{userId}</span>
            <br />
            Their activity will start counting toward dashboard / analytics
            / PnL aggregates again immediately.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleRemove} disabled={isPending}>
            {isPending ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
