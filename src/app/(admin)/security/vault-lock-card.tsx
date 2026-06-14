"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Trash2, X, Check, Plus, Timer } from "lucide-react";
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
import { EmptyState } from "@/components/empty-state";
import { Spinner, transition } from "@/components/ux";
import { cn } from "@/lib/utils";
import { upsertVaultLockTime, deleteVaultLockTime } from "./vault-lock-actions";

export type VaultLockTime = {
  id: string;
  hours: number;
  label: string;
};

/**
 * Vault Lock Times editor — relocated from the old `/settings` page into
 * /security. Mirrors the other /security cards: a self-contained client
 * component that receives its data as a plain serializable `vaultLockTimes`
 * prop and drives the relocated server actions (`upsertVaultLockTime` /
 * `deleteVaultLockTime`), whose admin guards/capabilities are unchanged.
 *
 * The surrounding CollapsibleSecuritySection supplies the heading, so this
 * renders only the bordered table + add-row body.
 */
export function VaultLockCard({
  vaultLockTimes,
}: {
  vaultLockTimes: VaultLockTime[];
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editHours, setEditHours] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [newHours, setNewHours] = useState("");
  const [newLabel, setNewLabel] = useState("");

  function startEdit(v: VaultLockTime) {
    setEditingId(v.id);
    setEditHours(String(v.hours));
    setEditLabel(v.label);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function handleSaveEdit(id: string) {
    const hours = parseInt(editHours);
    if (isNaN(hours) || hours <= 0) {
      toast.error("Hours must be a positive number");
      return;
    }
    startTransition(async () => {
      try {
        await upsertVaultLockTime(id, hours, editLabel);
        toast.success("Lock time updated");
        setEditingId(null);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  function handleAdd() {
    const hours = parseInt(newHours);
    if (isNaN(hours) || hours <= 0) {
      toast.error("Hours must be a positive number");
      return;
    }
    if (!newLabel.trim()) {
      toast.error("Label is required");
      return;
    }
    startTransition(async () => {
      try {
        await upsertVaultLockTime(null, hours, newLabel);
        toast.success("Lock time added");
        setNewHours("");
        setNewLabel("");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  function handleDelete(id: string) {
    if (!confirm("Delete this vault lock time?")) return;
    startTransition(async () => {
      try {
        await deleteVaultLockTime(id);
        toast.success("Lock time deleted");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Hours</TableHead>
              <TableHead>Label</TableHead>
              <TableHead className="w-[100px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {vaultLockTimes.map((v) =>
              editingId === v.id ? (
                <TableRow key={v.id} className={cn(transition("all", "base"))}>
                  <TableCell>
                    <Input
                      type="number"
                      value={editHours}
                      onChange={(e) => setEditHours(e.target.value)}
                      className="h-8 w-24"
                      disabled={isPending}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      className="h-8"
                      disabled={isPending}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isPending}
                        onClick={() => handleSaveEdit(v.id)}
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={cancelEdit}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow key={v.id} className={cn(transition("all", "base"))}>
                  <TableCell>{v.hours}h</TableCell>
                  <TableCell>{v.label}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isPending}
                        onClick={() => startEdit(v)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isPending}
                        onClick={() => handleDelete(v.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            )}
            {vaultLockTimes.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="p-0">
                  <EmptyState
                    icon={Timer}
                    title="No vault lock times configured"
                    description="Add a duration below to offer it as a vault option."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-end sm:gap-4">
        <div className="space-y-1">
          <Label>Hours</Label>
          <Input
            type="number"
            placeholder="e.g. 48"
            value={newHours}
            onChange={(e) => setNewHours(e.target.value)}
            className="sm:w-24"
          />
        </div>
        <div className="space-y-1 flex-1">
          <Label>Label</Label>
          <Input
            placeholder="e.g. 2 Days"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
        </div>
        <Button onClick={handleAdd} disabled={isPending}>
          {isPending && newLabel.trim() && newHours.trim() ? (
            <Spinner size={16} className="text-current" />
          ) : (
            <Plus className="size-4" />
          )}
          Add
        </Button>
      </div>
    </div>
  );
}
