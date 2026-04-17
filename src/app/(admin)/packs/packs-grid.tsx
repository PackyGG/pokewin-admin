"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  MoreHorizontal,
  Pencil,
  Power,
  PowerOff,
  Trash2,
  Package,
} from "lucide-react";
import { toast } from "sonner";
import { CardImage } from "@/components/card-image";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { PackListItem } from "@/lib/queries/packs";
import { togglePackActive, deletePack } from "./actions";

/**
 * /packs list grid — cleaner, calmer tiles.
 *
 * Layout is 1 → 2 → 3 → 4 → 5 columns so pack tiles feel roomy at the
 * default sort density (packs carry more metadata than cards). Each tile:
 *
 *   - Image sits top-left at a calm 48px (not dominant)
 *   - Title + price occupy the right column with the price aligned right
 *   - Stats row shows openings, revenue, RTP, edge — all tabular-nums
 *   - Inline card preview strip below the stats carries the first few
 *     card thumbnails so operators can eyeball the contents at a glance
 *   - Hover reveals a kebab-menu for toggle-active / delete; edit links
 *     to the detail page where the full editor lives (unchanged)
 *
 * Inactive packs fade to ~70% opacity and carry a small "Off" badge over
 * the image so the list visually distinguishes live vs paused packs.
 */
export function PacksGrid({ data }: { data: PackListItem[] }) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed bg-card/30 px-6 py-16 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-muted/40">
          <Package className="size-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">No packs match your filters</p>
        <p className="text-xs text-muted-foreground">
          Try a different search or status filter.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid gap-3",
        "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
      )}
    >
      {data.map((pack) => (
        <PackTile key={pack.id} pack={pack} />
      ))}
    </div>
  );
}

function PackTile({ pack }: { pack: PackListItem }) {
  const edgeClass =
    pack.actualHouseEdge >= 0
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-card/50",
        "transition-all duration-200",
        "motion-safe:hover:-translate-y-0.5 hover:shadow-md hover:bg-card hover:border-primary/40",
        !pack.active && "opacity-80",
      )}
    >
      {/* Hover-revealed action menu — absolute so it stays out of the Link
          flow. motion-safe for reduce-motion users. */}
      <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity motion-safe:duration-150 group-hover:opacity-100 focus-within:opacity-100">
        <PackActions pack={pack} />
      </div>

      <Link href={`/packs/${pack.id}`} className="block">
        {/* Header: image + name/price */}
        <div className="flex items-start gap-3 p-3 pr-10">
          <div className="relative shrink-0">
            <CardImage
              src={pack.imageUrl}
              alt={pack.name}
              className="size-12 rounded-lg ring-1 ring-border"
            />
            {!pack.active && (
              <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50">
                <span className="text-[9px] font-semibold uppercase tracking-wide text-zinc-200">
                  Off
                </span>
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <h3
                className="line-clamp-2 text-sm font-semibold leading-tight transition-colors group-hover:text-primary"
                title={pack.name}
              >
                {pack.name}
              </h3>
              <span className="shrink-0 rounded-md border bg-background/60 px-1.5 py-0.5 text-xs font-semibold tabular-nums">
                {formatCurrency(pack.priceUsd)}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {formatNumber(pack.totalOpenings)} opens · {pack.totalCardCount} cards
            </p>
          </div>
        </div>

        {/* Stats row — four compact metrics. */}
        <div className="grid grid-cols-4 gap-1 border-t bg-muted/20 px-3 py-2">
          <Metric label="Revenue" value={formatCurrency(pack.totalRevenue)} />
          <Metric
            label="Edge"
            value={`${pack.actualHouseEdge.toFixed(1)}%`}
            valueClass={edgeClass}
          />
          <Metric label="RTP" value={`${pack.actualRtp.toFixed(1)}%`} />
          <Metric label="Payout" value={formatCurrency(pack.totalPayout)} />
        </div>

        {/* Mini card preview strip — skipped when no cards. */}
        {pack.cards.length > 0 && (
          <div className="flex items-center gap-1 px-3 pb-3 pt-2">
            {pack.cards.map((card) => (
              <CardImage
                key={card.id}
                src={card.imageUrl}
                alt={card.name}
                className="size-6 shrink-0 rounded-sm ring-1 ring-border"
              />
            ))}
            {pack.totalCardCount > pack.cards.length && (
              <div className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-muted text-[9px] font-medium tabular-nums">
                +{pack.totalCardCount - pack.cards.length}
              </div>
            )}
          </div>
        )}
      </Link>
    </div>
  );
}

function Metric({
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
      <p className="truncate text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "truncate text-[11px] font-semibold tabular-nums",
          valueClass,
        )}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * Per-pack kebab-menu actions. Toggle fires a server action and
 * refreshes; delete opens a confirmation dialog first because it drops
 * the pack_cards rows too.
 *
 * Uses e.preventDefault() on the trigger to block the outer <Link />
 * navigation when opening the menu.
 */
function PackActions({ pack }: { pack: PackListItem }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [deleteOpen, setDeleteOpen] = useState(false);

  function handleToggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    startTransition(async () => {
      try {
        await togglePackActive(pack.id, !pack.active);
        toast.success(pack.active ? "Pack deactivated" : "Pack activated");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    });
  }

  function handleDelete() {
    startTransition(async () => {
      try {
        await deletePack(pack.id);
        toast.success("Pack deleted");
        setDeleteOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to delete pack",
        );
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-md bg-background/80 shadow-sm ring-1 ring-border backdrop-blur-sm hover:bg-background"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              aria-label="Pack actions"
            />
          }
        >
          <MoreHorizontal className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-[160px]">
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              router.push(`/packs/${pack.id}`);
            }}
          >
            <Pencil className="size-3.5" />
            Edit pack
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={handleToggle}
            disabled={isPending}
          >
            {pack.active ? (
              <PowerOff className="size-3.5" />
            ) : (
              <Power className="size-3.5" />
            )}
            {pack.active ? "Deactivate" : "Activate"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDeleteOpen(true);
            }}
          >
            <Trash2 className="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete pack</DialogTitle>
            <DialogDescription>
              Delete <strong>{pack.name}</strong>? This removes the pack and
              all its card associations. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isPending}
            >
              {isPending ? "Deleting..." : "Delete pack"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
