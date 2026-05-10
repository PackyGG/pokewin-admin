"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
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
import { upsertRacePrizeTier, deleteRacePrizeTier } from "./actions";

type PrizeTier = {
  id: string;
  raceType: string;
  position: number;
  prizeAmountUsd: number;
};

type RaceType = "daily" | "weekly" | "monthly";

export function RaceTiersTable({ tiers }: { tiers: PrizeTier[] }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Inline edit state — only one row is ever being edited at a time
  // across both sections, so a single piece of state is enough.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // "Add Tier" form state — keyed by race type so the daily and
  // weekly forms don't collide if both ever get opened.
  const [addingFor, setAddingFor] = useState<RaceType | null>(null);
  const [addPosition, setAddPosition] = useState("");
  const [addAmount, setAddAmount] = useState("");

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

  function startAdd(raceType: RaceType, existing: PrizeTier[]) {
    const nextPosition =
      existing.length === 0
        ? 1
        : Math.max(...existing.map((t) => t.position)) + 1;
    setAddingFor(raceType);
    setAddPosition(String(nextPosition));
    setAddAmount("");
    setEditingId(null);
  }

  function cancelAdd() {
    setAddingFor(null);
    setAddPosition("");
    setAddAmount("");
  }

  function saveAdd(raceType: RaceType) {
    const position = parseInt(addPosition, 10);
    const amount = parseFloat(addAmount);
    if (!Number.isInteger(position) || position < 1) {
      toast.error("Position must be a positive integer");
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error("Prize amount must be a non-negative number");
      return;
    }
    startTransition(async () => {
      try {
        await upsertRacePrizeTier(raceType, position, amount);
        toast.success("Prize tier created");
        cancelAdd();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to create");
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
              Add Tier
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

              {isAdding && (
                <TableRow>
                  <TableCell>
                    <Input
                      type="number"
                      step="1"
                      min="1"
                      value={addPosition}
                      onChange={(e) => setAddPosition(e.target.value)}
                      className="h-8 w-20"
                      placeholder="#"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={addAmount}
                      onChange={(e) => setAddAmount(e.target.value)}
                      className="h-8 w-32"
                      placeholder="0.00"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveAdd(raceType);
                        if (e.key === "Escape") cancelAdd();
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => saveAdd(raceType)}
                        disabled={isPending}
                      >
                        Save
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
