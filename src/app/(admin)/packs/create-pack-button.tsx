"use client";

import { lazy, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { LazyModalContent } from "@/components/ux";
import { SkeletonText } from "@/components/ux/skeleton";
import { Skeleton } from "@/components/ui/skeleton";

// Heavy dialog body (dnd-kit sortable table, card picker, EV math, image
// upload, risk slider) is code-split so the /packs route chunk stays
// light — it downloads on first dialog open, not on page load.
const CreatePackForm = lazy(() =>
  import("./create-pack-form").then((m) => ({ default: m.CreatePackForm })),
);

/**
 * Skeleton shown while the lazy form chunk downloads on first open. Shaped
 * like the dialog body — a couple of field rows + the cards section — so
 * the overlay never flashes a bare spinner or jumps when the form mounts.
 */
function CreatePackFormFallback() {
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <SkeletonText size="sm" width={72} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-3 w-16 rounded" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-20 rounded" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-3 w-16 rounded" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-4">
        <SkeletonText size="sm" width={96} />
        <Skeleton className="h-9 w-full rounded-md" />
      </div>
    </div>
  );
}

export function CreatePackButton() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="mr-1 size-4" />
        Create Pack
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Create Pack</DialogTitle>
        </DialogHeader>

        {/* Gate the heavy form on `open` so its chunk + effects (the card
            picker filter fetch) only run once the dialog is actually
            opened. keepMounted preserves a half-built draft across an
            accidental close (matching the previous inline behavior, which
            only reset after a successful create) without shipping the
            chunk until first open. */}
        <LazyModalContent
          open={open}
          keepMounted
          fallback={<CreatePackFormFallback />}
        >
          <CreatePackForm onClose={() => setOpen(false)} />
        </LazyModalContent>
      </DialogContent>
    </Dialog>
  );
}
