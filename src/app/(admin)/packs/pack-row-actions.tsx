"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  MoreHorizontal,
  Pencil,
  Power,
  PowerOff,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
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
import type { PackListItem } from "@/lib/queries/packs";
import { deletePack, togglePackActive } from "./actions";
import { invalidatePackDetailCache } from "./pack-detail-cache";

/**
 * Per-pack kebab menu, shared by the table rows and the gallery tiles so the
 * action surface is identical in both views. Replaces the old grid-only
 * <PackActions>:
 *
 *   - "Quick edit"  → opens the QuickEditDrawer (price + active) without
 *                     leaving the list (only shown when the viewer can edit
 *                     price or toggle active).
 *   - "Open detail" → opens the centered detail MODAL on the list (via the
 *                     `?inspect=` flow), the same as a row/tile click. There is
 *                     no standalone full-page pack view — the modal is the only
 *                     detail surface, so this never navigates away.
 *   - Activate/Deactivate → togglePackActive (capability-gated).
 *   - Delete        → confirmation dialog → deletePack (capability-gated).
 *
 * All handlers stop propagation so a kebab click inside a clickable row/tile
 * never also triggers the row's inspector-open or the tile's navigation.
 */
export function PackRowActions({
  pack,
  canToggle,
  canDelete,
  canQuickEdit,
  onQuickEdit,
  onOpenDetail,
  /** Compact trigger for dense table rows (smaller hit target). */
  size = "default",
}: {
  pack: PackListItem;
  canToggle: boolean;
  canDelete: boolean;
  /** Whether the viewer may open the quick-edit drawer (edit price). */
  canQuickEdit: boolean;
  onQuickEdit: (pack: PackListItem) => void;
  /** Opens the centered detail modal for this pack (sets `?inspect=`). */
  onOpenDetail: (pack: PackListItem) => void;
  size?: "default" | "sm";
}) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  function handleToggle(e: React.MouseEvent) {
    stop(e);
    startTransition(async () => {
      try {
        await togglePackActive(pack.id, !pack.active);
        invalidatePackDetailCache(pack.id);
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
        invalidatePackDetailCache(pack.id);
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
              className={
                size === "sm"
                  ? "size-7 rounded-md text-muted-foreground hover:text-foreground"
                  : "size-7 rounded-md bg-background/80 shadow-sm ring-1 ring-border backdrop-blur-sm hover:bg-background"
              }
              onClick={stop}
              aria-label="Pack actions"
              data-no-row-click
            />
          }
        >
          <MoreHorizontal className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={4}
          className="min-w-[170px]"
        >
          {canQuickEdit && (
            <DropdownMenuItem
              onClick={(e) => {
                stop(e);
                onQuickEdit(pack);
              }}
            >
              <SlidersHorizontal className="size-3.5" />
              Quick edit
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={(e) => {
              stop(e);
              onOpenDetail(pack);
            }}
          >
            <Pencil className="size-3.5" />
            Open detail
          </DropdownMenuItem>
          {canToggle && (
            <DropdownMenuItem onClick={handleToggle} disabled={isPending}>
              {pack.active ? (
                <PowerOff className="size-3.5" />
              ) : (
                <Power className="size-3.5" />
              )}
              {pack.active ? "Deactivate" : "Activate"}
            </DropdownMenuItem>
          )}
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={(e) => {
                  stop(e);
                  setDeleteOpen(true);
                }}
              >
                <Trash2 className="size-3.5" />
                Delete
              </DropdownMenuItem>
            </>
          )}
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
