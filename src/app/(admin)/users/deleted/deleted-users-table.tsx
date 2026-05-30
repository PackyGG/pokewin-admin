"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/empty-state";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { restoreDeletedUser, purgeDeletedUserSnapshot } from "./actions";

export type DeletedUserRow = {
  id: string;
  username: string | null;
  email: string | null;
  deletedAt: string;
  deletedByLabel: string;
  expiresAt: string;
  restoredAt: string | null;
  restoredByLabel: string | null;
};

type DialogMode = "restore" | "purge";

type DialogState = {
  mode: DialogMode;
  row: DeletedUserRow;
} | null;

export function DeletedUsersTable({ rows }: { rows: DeletedUserRow[] }) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function closeDialog() {
    setDialog(null);
    setTotpCode("");
  }

  function handleConfirm() {
    if (!dialog) return;
    const code = totpCode.trim();
    if (!code) {
      toast.error("Enter your 2FA code first");
      return;
    }
    const { mode, row } = dialog;
    startTransition(async () => {
      try {
        if (mode === "restore") {
          await restoreDeletedUser(row.id, code);
          toast.success("User restored");
        } else {
          await purgeDeletedUserSnapshot(row.id, code);
          toast.success("Snapshot purged");
        }
        closeDialog();
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : mode === "restore"
              ? "Failed to restore user"
              : "Failed to purge snapshot",
        );
      }
    });
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border bg-card">
        <EmptyState
          icon={Archive}
          title="No deleted users in the recovery window"
          description="When an admin deletes a user, the snapshot lives here for 7 days before it's purged automatically."
        />
      </div>
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Deleted</TableHead>
              <TableHead>Deleted By</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const isRestored = row.restoredAt !== null;
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {row.username ?? row.email ?? row.id.slice(0, 8)}
                      </span>
                      {row.email && row.username && (
                        <span className="text-xs text-muted-foreground">
                          {row.email}
                        </span>
                      )}
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {row.id}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-sm">
                        {formatDateTime(row.deletedAt)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatRelative(row.deletedAt)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.deletedByLabel}
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {formatRelative(row.expiresAt)}
                    </span>
                  </TableCell>
                  <TableCell>
                    {isRestored ? (
                      <Badge
                        variant="outline"
                        className="border-blue-500/30 bg-blue-500/15 text-blue-600 dark:text-blue-400"
                        title={
                          row.restoredByLabel
                            ? `Restored by ${row.restoredByLabel}`
                            : undefined
                        }
                      >
                        Restored
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      >
                        Recoverable
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {!isRestored && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setDialog({ mode: "restore", row });
                            setTotpCode("");
                          }}
                        >
                          <RefreshCw className="mr-1.5 size-3.5" />
                          Restore
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-rose-500/40 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-rose-400"
                        onClick={() => {
                          setDialog({ mode: "purge", row });
                          setTotpCode("");
                        }}
                      >
                        <Trash2 className="mr-1.5 size-3.5" />
                        Purge
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={dialog !== null}
        onOpenChange={(v) => {
          if (!v) closeDialog();
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle
              className={
                dialog?.mode === "purge" ? "text-rose-500" : undefined
              }
            >
              {dialog?.mode === "restore"
                ? "Restore User"
                : "Permanently Purge Snapshot"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {dialog && (
              <p className="text-sm text-muted-foreground">
                {dialog.mode === "restore" ? (
                  <>
                    Restore{" "}
                    <span className="font-semibold text-foreground">
                      {dialog.row.username ??
                        dialog.row.email ??
                        dialog.row.id.slice(0, 8)}
                    </span>{" "}
                    and their balances / inventory / vouchers / rakeback
                    claims back into main DB. Game sessions and ledger
                    history will not be re-inserted.
                  </>
                ) : (
                  <>
                    This will{" "}
                    <span className="font-semibold text-rose-500">
                      permanently delete
                    </span>{" "}
                    the snapshot for{" "}
                    <span className="font-semibold text-foreground">
                      {dialog.row.username ??
                        dialog.row.email ??
                        dialog.row.id.slice(0, 8)}
                    </span>{" "}
                    before its natural 7-day expiry. The user cannot be
                    restored after this.
                  </>
                )}
              </p>
            )}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">2FA Code</Label>
              <Input
                type="text"
                inputMode="numeric"
                placeholder="Enter your 6-digit code"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                maxLength={6}
                autoComplete="one-time-code"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant={
                dialog?.mode === "purge" ? "destructive" : "default"
              }
              className="w-full sm:w-auto"
              disabled={!totpCode.trim() || isPending}
              onClick={handleConfirm}
            >
              {isPending
                ? dialog?.mode === "restore"
                  ? "Restoring..."
                  : "Purging..."
                : dialog?.mode === "restore"
                  ? "Restore User"
                  : "Purge Snapshot"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
