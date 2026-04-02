"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { updateRakebackConfig } from "../actions";

type RakebackConfig = {
  id: string;
  type: string;
  percentage: number;
  expirationDays: number;
  displayName: string;
  enabled: boolean;
};

export function RakebackConfigTable({ configs }: { configs: RakebackConfig[] }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({ percentage: "", expirationDays: "" });

  function handleToggle(config: RakebackConfig) {
    startTransition(async () => {
      try {
        await updateRakebackConfig(config.id, {
          percentage: config.percentage,
          expirationDays: config.expirationDays,
          enabled: !config.enabled,
        });
        toast.success(`${config.displayName} ${config.enabled ? "disabled" : "enabled"}`);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  function startEdit(config: RakebackConfig) {
    setEditingId(config.id);
    setEditValues({
      percentage: String(config.percentage * 100),
      expirationDays: String(config.expirationDays),
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValues({ percentage: "", expirationDays: "" });
  }

  function saveEdit(config: RakebackConfig) {
    const percentage = parseFloat(editValues.percentage);
    const expirationDays = parseInt(editValues.expirationDays, 10);
    if (isNaN(percentage) || percentage < 0 || percentage > 100) {
      toast.error("Percentage must be between 0 and 100");
      return;
    }
    if (isNaN(expirationDays) || expirationDays < 0) {
      toast.error("Expiration days must be a positive number");
      return;
    }
    startTransition(async () => {
      try {
        await updateRakebackConfig(config.id, {
          percentage: percentage / 100,
          expirationDays,
          enabled: config.enabled,
        });
        toast.success("Rakeback config updated");
        setEditingId(null);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update");
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent, config: RakebackConfig) {
    if (e.key === "Enter") saveEdit(config);
    if (e.key === "Escape") cancelEdit();
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Display Name</TableHead>
            <TableHead>Percentage</TableHead>
            <TableHead>Expiration (days)</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead className="w-[100px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {configs.map((config) => (
            <TableRow key={config.id}>
              <TableCell>
                <Badge variant="outline">{config.type}</Badge>
              </TableCell>
              <TableCell>{config.displayName}</TableCell>
              <TableCell>
                {editingId === config.id ? (
                  <Input
                    type="number"
                    value={editValues.percentage}
                    onChange={(e) => setEditValues((v) => ({ ...v, percentage: e.target.value }))}
                    className="h-8 w-28"
                    onKeyDown={(e) => handleKeyDown(e, config)}
                  />
                ) : (
                  <>{(config.percentage * 100).toFixed(4)}%</>
                )}
              </TableCell>
              <TableCell>
                {editingId === config.id ? (
                  <Input
                    type="number"
                    value={editValues.expirationDays}
                    onChange={(e) => setEditValues((v) => ({ ...v, expirationDays: e.target.value }))}
                    className="h-8 w-24"
                    onKeyDown={(e) => handleKeyDown(e, config)}
                  />
                ) : (
                  config.expirationDays
                )}
              </TableCell>
              <TableCell>
                <Switch
                  checked={config.enabled}
                  onCheckedChange={() => handleToggle(config)}
                  disabled={isPending}
                />
              </TableCell>
              <TableCell>
                {editingId === config.id ? (
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => saveEdit(config)} disabled={isPending}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={isPending}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => startEdit(config)}>
                    Edit
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
          {configs.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                No rakeback configs found.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
