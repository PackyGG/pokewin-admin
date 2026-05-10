"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/utils/format";
import {
  upsertRacePrizeTier,
  upsertRacePrizeTiersBulk,
  deleteRacePrizeTier,
} from "./actions";

type PrizeTier = {
  id: string;
  raceType: string;
  position: number;
  prizeAmountUsd: number;
};

type RaceType = "daily" | "weekly" | "monthly";

// Pending-row shape for the multi-row "Add Tiers" stage. Inputs stay as
// strings until save (so the field can hold "" or "1." mid-typing
// without re-rendering as NaN). Each row gets a stable client-side key
// so React doesn't reorder when the array splices.
type PendingRow = {
  key: string;
  position: string;
  amount: string;
};

function makePendingRow(position: number, amount = ""): PendingRow {
  return {
    key:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `r-${Math.random().toString(36).slice(2)}`,
    position: String(position),
    amount,
  };
}

export function RaceTiersTable({ tiers }: { tiers: PrizeTier[] }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Inline edit state — only one row is ever being edited at a time
  // across both sections, so a single piece of state is enough.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // "Add Tiers" stage — keyed by race type (so the daily and weekly
  // sections don't collide when both are open) and holds a LIST of
  // pending rows. Admin can stack as many rows as they want and save
  // them all at once via the bulk action — no more saving after every
  // row.
  const [addingFor, setAddingFor] = useState<RaceType | null>(null);
  const [pendingRows, setPendingRows] = useState<PendingRow[]>([]);

  const dailyTiers = tiers
    .filter((t) => t.raceType === "daily")
    .sort((a, b) => a.position - b.position);
  const weeklyTiers = tiers
    .filter((t) => t.raceType === "weekly")
    .sort((a, b) => a.position - b.position);
  const monthlyTiers = tiers
    .filter((t) => t.raceType === "monthly")
    .sort((a, b) => a.position - b.position);

  function startEdit(tier: PrizeTier) {
    setEditingId(tier.id);
    setEditValue(String(tier.prizeAmountUsd));
    setAddingFor(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue("");
  }

  function saveEdit(tier: PrizeTier) {
    const amount = parseFloat(editValue);
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error("Invalid amount");
      return;
    }
    startTransition(async () => {
      try {
        await upsertRacePrizeTier(tier.raceType, tier.position, amount);
        toast.success("Prize tier updated");
        setEditingId(null);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update");
      }
    });
  }

  function nextPositionAfter(existing: PrizeTier[], pending: PendingRow[]) {
    // Highest position across both saved tiers and the rows already
    // staged in the form. Adding a new row should pick up where the
    // last staged row left off, not duplicate it.
    const taken = [
      ...existing.map((t) => t.position),
      ...pending
        .map((r) => parseInt(r.position, 10))
        .filter((n) => Number.isInteger(n) && n > 0),
    ];
    return taken.length === 0 ? 1 : Math.max(...taken) + 1;
  }

  function startAdd(raceType: RaceType, existing: PrizeTier[]) {
    setAddingFor(raceType);
    setPendingRows([makePendingRow(nextPositionAfter(existing, []))]);
    setEditingId(null);
  }

  function appendPendingRow(existing: PrizeTier[]) {
    setPendingRows((rows) => [
      ...rows,
      makePendingRow(nextPositionAfter(existing, rows)),
    ]);
  }

  function updatePendingRow(
    key: string,
    patch: Partial<Omit<PendingRow, "key">>,
  ) {
    setPendingRows((rows) =>
      rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
  }

  function removePendingRow(key: string) {
    setPendingRows((rows) => rows.filter((r) => r.key !== key));
  }

  function cancelAdd() {
    setAddingFor(null);
    setPendingRows([]);
  }

  function saveAdd(raceType: RaceType) {
    if (pendingRows.length === 0) {
      toast.error("Add at least one row before saving");
      return;
    }
    // Validate + parse client-side first so we surface a friendly toast
    // instead of bouncing off the server's thrown Error string.
    const parsed: { position: number; prizeAmountUsd: number }[] = [];
    const seen = new Set<number>();
    for (const row of pendingRows) {
      const position = parseInt(row.position, 10);
      const amount = parseFloat(row.amount);
      if (!Number.isInteger(position) || position < 1) {
        toast.error(`Position "${row.position || "(empty)"}" is not a positive integer`);
        return;
      }
      if (!Number.isFinite(amount) || amount < 0) {
        toast.error(`Prize amount for #${position} must be a non-negative number`);
        return;
      }
      if (seen.has(position)) {
        toast.error(`Position #${position} appears twice in the form`);
        return;
      }
      seen.add(position);
      parsed.push({ position, prizeAmountUsd: amount });
    }

    // Single row → fall through to the existing single-row action so
    // the server-side audit event records "race_prize_tier_created"
    // (matches what a one-off edit produces). Multi-row → bulk action.
    startTransition(async () => {
      try {
        if (parsed.length === 1) {
          await upsertRacePrizeTier(
            raceType,
            parsed[0].position,
            parsed[0].prizeAmountUsd,
          );
          toast.success("Prize tier saved");
        } else {
          const result = await upsertRacePrizeTiersBulk(raceType, parsed);
          toast.success(
            result.upserted === 1
              ? "Prize tier saved"
              : `${result.upserted} prize tiers saved`,
          );
        }
        cancelAdd();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to save");
      }
    });
  }

  function handleDelete(tier: PrizeTier) {
    // Lightweight confirm — delete is cheap to reverse by re-adding
    // the same position, so a full AlertDialog would be overkill.
    if (
      !confirm(
        `Delete ${tier.raceType} #${tier.position} (${formatCurrency(tier.prizeAmountUsd)})?`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        await deleteRacePrizeTier(tier.id);
        toast.success("Prize tier deleted");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to delete");
      }
    });
  }

  function renderGroup(raceType: RaceType, items: PrizeTier[]) {
    const isAdding = addingFor === raceType;
    const visiblePending = isAdding ? pendingRows : [];

    return (
      <div key={raceType}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium capitalize">{raceType}</h3>
          {!isAdding && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => startAdd(raceType, items)}
              disabled={isPending}
            >
              <Plus className="mr-1 size-3" />
              Add Tiers
            </Button>
          )}
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Position</TableHead>
                <TableHead>Prize</TableHead>
                <TableHead className="w-[160px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((tier) => (
                <TableRow key={tier.id}>
                  <TableCell>
                    <Badge variant="outline">#{tier.position}</Badge>
                  </TableCell>
                  <TableCell>
                    {editingId === tier.id ? (
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="h-8 w-32"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(tier);
                          if (e.key === "Escape") cancelEdit();
                        }}
                      />
                    ) : (
                      formatCurrency(tier.prizeAmountUsd)
                    )}
                  </TableCell>
                  <TableCell>
                    {editingId === tier.id ? (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => saveEdit(tier)}
                          disabled={isPending}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={cancelEdit}
                          disabled={isPending}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => startEdit(tier)}
                          disabled={isPending}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDelete(tier)}
                          disabled={isPending}
                          aria-label={`Delete ${raceType} position ${tier.position}`}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}

              {visiblePending.map((row, idx) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <Input
                      type="number"
                      step="1"
                      min="1"
                      value={row.position}
                      onChange={(e) =>
                        updatePendingRow(row.key, { position: e.target.value })
                      }
                      className="h-8 w-20"
                      placeholder="#"
                      autoFocus={idx === visiblePending.length - 1}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={row.amount}
                      onChange={(e) =>
                        updatePendingRow(row.key, { amount: e.target.value })
                      }
                      className="h-8 w-32"
                      placeholder="0.00"
                      onKeyDown={(e) => {
                        // Enter on the last row appends a fresh row so
                        // admins can keep typing without grabbing the
                        // mouse. Cmd/Ctrl+Enter saves the whole batch.
                        if (e.key === "Enter") {
                          if (e.metaKey || e.ctrlKey) {
                            saveAdd(raceType);
                          } else if (idx === visiblePending.length - 1) {
                            e.preventDefault();
                            appendPendingRow(items);
                          }
                        }
                        if (e.key === "Escape") cancelAdd();
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    {/* Per-row remove (X). Cancel + Save All live in
                        the footer row below so they aren't repeated on
                        every pending row. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removePendingRow(row.key)}
                      disabled={isPending || visiblePending.length === 1}
                      aria-label={`Remove pending row ${idx + 1}`}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <X className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}

              {isAdding && (
                <TableRow>
                  <TableCell colSpan={3} className="bg-muted/20">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => appendPendingRow(items)}
                        disabled={isPending}
                      >
                        <Plus className="mr-1 size-3" />
                        Add another row
                      </Button>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">
                          {visiblePending.length}{" "}
                          {visiblePending.length === 1 ? "row" : "rows"} staged
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => saveAdd(raceType)}
                          disabled={isPending || visiblePending.length === 0}
                        >
                          {isPending
                            ? "Saving…"
                            : visiblePending.length > 1
                              ? "Save all"
                              : "Save"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={cancelAdd}
                          disabled={isPending}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )}

              {items.length === 0 && !isAdding && (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No tiers configured. Click &ldquo;Add Tier&rdquo; to add
                    the first one.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {renderGroup("monthly", monthlyTiers)}
      {renderGroup("weekly", weeklyTiers)}
      {renderGroup("daily", dailyTiers)}
    </div>
  );
}
