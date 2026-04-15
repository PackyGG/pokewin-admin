"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
import { updateRacePrizeTier } from "./actions";

type PrizeTier = {
  id: string;
  raceType: string;
  position: number;
  prizeAmountUsd: number;
};

export function RaceTiersTable({ tiers }: { tiers: PrizeTier[] }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const dailyTiers = tiers.filter((t) => t.raceType === "daily");
  const weeklyTiers = tiers.filter((t) => t.raceType === "weekly");

  function startEdit(tier: PrizeTier) {
    setEditingId(tier.id);
    setEditValue(String(tier.prizeAmountUsd));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue("");
  }

  function saveEdit(id: string) {
    const amount = parseFloat(editValue);
    if (isNaN(amount) || amount < 0) {
      toast.error("Invalid amount");
      return;
    }
    startTransition(async () => {
      try {
        await updateRacePrizeTier(id, amount);
        toast.success("Prize tier updated");
        setEditingId(null);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update");
      }
    });
  }

  function renderGroup(label: string, items: PrizeTier[]) {
    return (
      <div key={label}>
        <h3 className="mb-2 text-sm font-medium capitalize">{label}</h3>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Position</TableHead>
                <TableHead>Prize</TableHead>
                <TableHead className="w-[100px]" />
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
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="h-8 w-32"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(tier.id);
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
                        <Button size="sm" variant="outline" onClick={() => saveEdit(tier.id)} disabled={isPending}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={isPending}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => startEdit(tier)}>
                        Edit
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                    No tiers configured.
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
      {renderGroup("Daily", dailyTiers)}
      {renderGroup("Weekly", weeklyTiers)}
    </div>
  );
}
