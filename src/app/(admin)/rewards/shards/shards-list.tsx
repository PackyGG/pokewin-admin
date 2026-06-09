"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Gem, Layers, Pencil, Power, PowerOff, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CardImage } from "@/components/card-image";
import { ActiveBadge, EmptyState } from "@/components/entity-surface";
import { formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { ShardPackListItem } from "@/lib/queries/packs";
import { deletePack, togglePackActive } from "@/app/(admin)/packs/actions";
import { EditPackButton } from "@/app/(admin)/packs/[id]/edit-pack-button";
import { getShardPackForEdit } from "./actions";

type EditDetail = Awaited<ReturnType<typeof getShardPackForEdit>>;

/**
 * Management list for shard packs. Neutral config surface — shard_cost is a
 * shard-currency cost, NOT USD, so there is no house-POV finance coloring
 * here (no money P&L on this page). Each row carries:
 *   - Edit  → lazy-fetches the full card pool (getShardPackForEdit) only on
 *             click, then reuses the shared <EditPackButton> editor.
 *   - Activate / Deactivate → shared togglePackActive.
 *   - Delete → confirm → shared deletePack.
 */
export function ShardsList({
  packs,
  canEdit,
  canToggle,
  canDelete,
}: {
  packs: ShardPackListItem[];
  canEdit: boolean;
  canToggle: boolean;
  canDelete: boolean;
}) {
  if (packs.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed bg-card/30">
        <EmptyState
          icon={Gem}
          title="No shard packs yet"
          description="Create a shard pack to let players spend shards on a free-roll pack."
        />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card/50">
      <div className="hidden grid-cols-[1fr_auto_auto_auto_auto] gap-4 border-b bg-muted/30 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground sm:grid">
        <span>Pack</span>
        <span className="text-right">Shard cost</span>
        <span className="text-right">Cards / open</span>
        <span className="text-right">Card pool</span>
        <span className="text-right">Actions</span>
      </div>
      <ul className="divide-y">
        {packs.map((pack) => (
          <ShardRow
            key={pack.id}
            pack={pack}
            canEdit={canEdit}
            canToggle={canToggle}
            canDelete={canDelete}
          />
        ))}
      </ul>
    </div>
  );
}

function ShardRow({
  pack,
  canEdit,
  canToggle,
  canDelete,
}: {
  pack: ShardPackListItem;
  canEdit: boolean;
  canToggle: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  // Lazy edit: detail (full card pool) is fetched only when Edit is clicked,
  // then the shared editor mounts already-open. Unmount it on close so the
  // next open re-fetches a fresh card pool.
  const [editDetail, setEditDetail] = React.useState<EditDetail>(null);
  const [loadingEdit, setLoadingEdit] = React.useState(false);

  function handleEdit() {
    if (loadingEdit) return;
    setLoadingEdit(true);
    startTransition(async () => {
      try {
        const detail = await getShardPackForEdit(pack.id);
        if (!detail) {
          toast.error("Shard pack not found");
          return;
        }
        setEditDetail(detail);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load pack");
      } finally {
        setLoadingEdit(false);
      }
    });
  }

  function handleToggle() {
    startTransition(async () => {
      try {
        await togglePackActive(pack.id, !pack.active);
        toast.success(pack.active ? "Shard pack deactivated" : "Shard pack activated");
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
        toast.success("Shard pack deleted");
        setDeleteOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to delete pack");
      }
    });
  }

  return (
    <li
      className={cn(
        "grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-[1fr_auto_auto_auto_auto] sm:items-center sm:gap-4",
        !pack.active && "opacity-75",
      )}
    >
      {/* Identity */}
      <div className="flex min-w-0 items-center gap-3">
        <CardImage
          src={pack.imageUrl}
          alt={pack.name}
          className="size-10 shrink-0 rounded-lg ring-1 ring-border"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold" title={pack.name}>
              {pack.name}
            </p>
            <ActiveBadge active={pack.active} size="sm" />
          </div>
          <p className="truncate text-[11px] text-muted-foreground">{pack.slug}</p>
        </div>
      </div>

      {/* Shard cost */}
      <div className="flex items-center gap-1.5 sm:justify-end">
        <Gem className="size-3.5 text-purple-500 sm:hidden" />
        <span className="text-sm font-semibold tabular-nums text-purple-600 dark:text-purple-400">
          {pack.shardCost != null ? formatNumber(pack.shardCost) : "—"}
          <span className="ml-1 text-[11px] font-normal text-muted-foreground sm:hidden">
            shards
          </span>
        </span>
      </div>

      {/* Cards per open */}
      <div className="text-sm tabular-nums sm:text-right">
        <span className="text-muted-foreground sm:hidden">Cards / open: </span>
        {formatNumber(pack.cardsPerOpen)}
      </div>

      {/* Card pool size */}
      <div className="flex items-center gap-1.5 text-sm tabular-nums sm:justify-end">
        <Layers className="size-3.5 text-cyan-500 sm:hidden" />
        <span className="text-muted-foreground sm:hidden">Pool: </span>
        {formatNumber(pack.cardCount)}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 sm:justify-end">
        {canEdit && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleEdit}
            disabled={loadingEdit || isPending}
          >
            <Pencil className="mr-1 size-3.5" />
            {loadingEdit ? "Loading…" : "Edit"}
          </Button>
        )}
        {canToggle && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleToggle}
            disabled={isPending}
            aria-label={pack.active ? "Deactivate" : "Activate"}
          >
            {pack.active ? (
              <PowerOff className="size-3.5" />
            ) : (
              <Power className="size-3.5" />
            )}
          </Button>
        )}
        {canDelete && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
            disabled={isPending}
            aria-label="Delete"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>

      {/* Lazy-mounted shared editor (opens immediately once detail loads) */}
      {editDetail && (
        <EditPackButton
          pack={editDetail}
          defaultOpen
          onClosed={() => {
            setEditDetail(null);
            router.refresh();
          }}
        />
      )}

      {/* Delete confirm */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete shard pack</DialogTitle>
            <DialogDescription>
              Delete <strong>{pack.name}</strong>? This removes the pack and all
              its card associations. This action cannot be undone.
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
              {isPending ? "Deleting…" : "Delete shard pack"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
