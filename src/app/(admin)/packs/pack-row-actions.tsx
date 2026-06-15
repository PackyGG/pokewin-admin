"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  MoreHorizontal,
  Pencil,
  Power,
  PowerOff,
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

export function PackRowActions({
  pack,
  canToggle,
  canDelete,
  canEdit,
  size = "default",
}: {
  pack: PackListItem;
  canToggle: boolean;
  canDelete: boolean;
  canEdit: boolean;
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
          <DropdownMenuItem
            onClick={(e) => {
              stop(e);
              router.push(`/packs/${pack.id}`);
            }}
          >
            <Pencil className="size-3.5" />
            Open pack
          </DropdownMenuItem>
          {canEdit && (
            <DropdownMenuItem
              onClick={(e) => {
                stop(e);
                router.push(`/packs/${pack.id}?edit=1`);
              }}
            >
              <Pencil className="size-3.5" />
              Edit pack
            </DropdownMenuItem>
          )}
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
