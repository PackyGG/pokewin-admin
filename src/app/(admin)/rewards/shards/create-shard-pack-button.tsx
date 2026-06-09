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
import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonText } from "@/components/ux/skeleton";

// Reuse the exact /packs create form — the heavy dnd-kit sortable table,
// card picker, image upload and risk slider are identical for a shard
// pack. The only difference is the pack type is locked to "shard" (the
// type Select is hidden) so this dialog always creates a shard pack with
// its required shard cost. Code-split the same way the /packs button is.
const CreatePackForm = lazy(() =>
  import("@/app/(admin)/packs/create-pack-form").then((m) => ({
    default: m.CreatePackForm,
  })),
);

function CreateShardPackFormFallback() {
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
      </div>
      <div className="space-y-4">
        <SkeletonText size="sm" width={96} />
        <Skeleton className="h-9 w-full rounded-md" />
      </div>
    </div>
  );
}

export function CreateShardPackButton() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="mr-1 size-4" />
        Create shard pack
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Create shard pack</DialogTitle>
        </DialogHeader>

        <LazyModalContent
          open={open}
          keepMounted
          fallback={<CreateShardPackFormFallback />}
        >
          <CreatePackForm lockedType="shard" onClose={() => setOpen(false)} />
        </LazyModalContent>
      </DialogContent>
    </Dialog>
  );
}
