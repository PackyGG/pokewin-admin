"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Percent } from "lucide-react";
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
import { EmptyState } from "@/components/empty-state";
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({ percentage: "", expirationDays: "" });

  // Optimistic in-place mirror of the server rows. We flip a row locally the
  // instant the admin toggles/saves — no router.refresh(), so the page never
  // re-renders and the scroll position is preserved. The server action still
  // revalidates the /rewards route (server-side, no cache tag exists for the
  // uncached rakeback read), and when a genuine revalidation streams fresh
  // props in we re-sync below — but never while a mutation is mid-flight, or a
  // stale pre-mutation prop would clobber the optimistic value.
  const [rows, setRows] = useState<RakebackConfig[]>(configs);
  useEffect(() => {
    if (isPending) return;
    setRows(configs);
  }, [configs, isPending]);

  function handleToggle(config: RakebackConfig) {
    const next = !config.enabled;
    // Optimistic flip — instant, no reload.
    setRows((rs) =>
      rs.map((r) => (r.id === config.id ? { ...r, enabled: next } : r)),
    );
    startTransition(async () => {
      try {
        await updateRakebackConfig(config.id, {
          percentage: config.percentage,
          expirationDays: config.expirationDays,
          enabled: next,
        });
        toast.success(`${config.displayName} ${next ? "enabled" : "disabled"}`);
      } catch (e) {
        // Roll back to the persisted value.
        setRows((rs) =>
          rs.map((r) =>
            r.id === config.id ? { ...r, enabled: config.enabled } : r,
          ),
        );
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
    const nextPercentage = percentage / 100;
    const prev = { percentage: config.percentage, expirationDays: config.expirationDays };
    // Optimistic update — show the new value in place immediately.
    setRows((rs) =>
      rs.map((r) =>
        r.id === config.id
          ? { ...r, percentage: nextPercentage, expirationDays }
          : r,
      ),
    );
    setEditingId(null);
    startTransition(async () => {
      try {
        await updateRakebackConfig(config.id, {
          percentage: nextPercentage,
          expirationDays,
          enabled: config.enabled,
        });
        toast.success("Rakeback config updated");
      } catch (e) {
        // Roll back to the persisted values.
        setRows((rs) =>
          rs.map((r) => (r.id === config.id ? { ...r, ...prev } : r)),
        );
        toast.error(e instanceof Error ? e.message : "Failed to update");
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent, config: RakebackConfig) {
    if (e.key === "Enter") saveEdit(config);
    if (e.key === "Escape") cancelEdit();
  }

  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {rows.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={Percent}
              title="No rakeback configs found"
              description="Rakeback tiers will appear here once they are configured."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border divide-y divide-border/60">
            {rows.map((config) => (
              <div key={config.id} className="px-3 py-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{config.type}</Badge>
                    <span className="text-sm font-medium">{config.displayName}</span>
                  </div>
                  <Switch
                    checked={config.enabled}
                    onCheckedChange={() => handleToggle(config)}
                    disabled={isPending}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Rate
                    </div>
                    {editingId === config.id ? (
                      <Input
                        type="number"
                        value={editValues.percentage}
                        onChange={(e) =>
                          setEditValues((v) => ({ ...v, percentage: e.target.value }))
                        }
                        className="h-8 w-full mt-1"
                        onKeyDown={(e) => handleKeyDown(e, config)}
                      />
                    ) : (
                      <div className="tabular-nums">{(config.percentage * 100).toFixed(4)}%</div>
                    )}
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Expires (days)
                    </div>
                    {editingId === config.id ? (
                      <Input
                        type="number"
                        value={editValues.expirationDays}
                        onChange={(e) =>
                          setEditValues((v) => ({ ...v, expirationDays: e.target.value }))
                        }
                        className="h-8 w-full mt-1"
                        onKeyDown={(e) => handleKeyDown(e, config)}
                      />
                    ) : (
                      <div className="tabular-nums">{config.expirationDays}</div>
                    )}
                  </div>
                </div>
                <div className="flex justify-end gap-1">
                  {editingId === config.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => saveEdit(config)}
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
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => startEdit(config)}
                    >
                      Edit
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
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
            {rows.map((config) => (
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
            {rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={Percent}
                    title="No rakeback configs found"
                    description="Rakeback tiers will appear here once they are configured."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
