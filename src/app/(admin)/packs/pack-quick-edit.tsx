"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { QuickEditDrawer } from "@/components/entity-surface";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { houseAmountTextClass, toPercent } from "@/lib/house-pov";
import { cn } from "@/lib/utils";
import type { PackListItem } from "@/lib/queries/packs";
import { quickUpdatePack } from "./actions";

/**
 * Quick-edit drawer for a pack — the low-friction price + active edit the
 * discovery asked for, so the most common tweak (price / active) is one click
 * from the list without opening the detail modal.
 *
 * Controlled by the parent list (open + which pack). The body is deferred by
 * QuickEditDrawer (mounts only when open). On save we call `quickUpdatePack`,
 * which re-applies the exact capability + live-pack gates the full flow uses.
 *
 * `canTogglePack` gates the active switch; price is always editable here
 * because the drawer is only offered to viewers who can update packs.
 */
export function PackQuickEdit({
  pack,
  open,
  onOpenChange,
  canTogglePack,
}: {
  pack: PackListItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canTogglePack: boolean;
}) {
  return (
    <QuickEditDrawer
      open={open}
      onOpenChange={onOpenChange}
      icon={SlidersHorizontal}
      accent="amber"
      title={pack ? `Quick edit · ${pack.name}` : "Quick edit"}
      subtitle={pack?.slug}
    >
      {pack && (
        <QuickEditForm
          // Remount the form per-pack so its local state resets when the
          // drawer is reused for a different row.
          key={pack.id}
          pack={pack}
          canTogglePack={canTogglePack}
          onDone={() => onOpenChange(false)}
        />
      )}
    </QuickEditDrawer>
  );
}

function QuickEditForm({
  pack,
  canTogglePack,
  onDone,
}: {
  pack: PackListItem;
  canTogglePack: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const [price, setPrice] = React.useState(String(pack.priceUsd));
  const [active, setActive] = React.useState(pack.active);
  const [saving, setSaving] = React.useState(false);

  const priceNum = parseFloat(price);
  const priceValid = Number.isFinite(priceNum) && priceNum > 0;
  const priceChanged = priceValid && priceNum !== pack.priceUsd;
  const activeChanged = active !== pack.active;
  const dirty = priceChanged || activeChanged;

  // House-POV reading of the pack's current edge (emerald = house up).
  const edgePct = toPercent(pack.actualHouseEdge);

  async function handleSave() {
    if (saving || !dirty) return;
    if (!priceValid) {
      toast.error("Price must be greater than 0");
      return;
    }
    setSaving(true);
    try {
      await quickUpdatePack(pack.id, {
        ...(priceChanged ? { price: priceNum } : {}),
        ...(activeChanged ? { active } : {}),
      });
      toast.success("Pack updated");
      onDone();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update pack");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-5">
        {/* Read-only economics context so the operator sees what they're
            tuning against without leaving the drawer. House-POV edge color. */}
        <div className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/20 p-2.5">
          <Stat label="Opens" value={formatNumber(pack.totalOpenings)} />
          <Stat
            label="Revenue"
            value={formatCurrency(pack.totalRevenue)}
          />
          <Stat
            label="Edge"
            value={`${edgePct.toFixed(1)}%`}
            valueClass={houseAmountTextClass(pack.actualHouseEdge)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="qe-price">Price (USD)</Label>
          <Input
            id="qe-price"
            type="number"
            min="0"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
            aria-invalid={!priceValid}
          />
          {!priceValid && (
            <p className="text-xs text-rose-600 dark:text-rose-400">
              Price must be greater than 0.
            </p>
          )}
        </div>

        {canTogglePack && (
          <div className="flex items-center justify-between rounded-lg border bg-muted/20 px-3 py-2.5">
            <div className="min-w-0">
              <Label htmlFor="qe-active" className="cursor-pointer">
                Active
              </Label>
              <p className="text-xs text-muted-foreground">
                {active ? "Live — players can open this pack." : "Off — hidden from players."}
              </p>
            </div>
            <Switch
              id="qe-active"
              checked={active}
              onCheckedChange={(v) => setActive(Boolean(v))}
            />
          </div>
        )}
      </div>

      <div className="mt-auto flex items-center justify-end gap-2 pt-6">
        <Button
          variant="outline"
          size="sm"
          onClick={onDone}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("truncate text-sm font-semibold tabular-nums", valueClass)}>
        {value}
      </p>
    </div>
  );
}
