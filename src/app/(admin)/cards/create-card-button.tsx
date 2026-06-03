"use client";

import { lazy, useState } from "react";
import { Plus, Sparkles } from "lucide-react";
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

// Heavy dialog body (image-upload flow, Pokemon/OnePiece variant branches,
// selects + constants) is code-split so the /cards route chunk stays light
// — it downloads on first dialog open, not on page load.
const CreateCardForm = lazy(() =>
  import("./create-card-form").then((m) => ({ default: m.CreateCardForm })),
);

/**
 * Skeleton shown while the lazy form chunk downloads on first open. Shaped
 * like the three-section dialog body (image · details · economy) so the
 * overlay never flashes a bare spinner or jumps when the form mounts.
 */
function CreateCardFormFallback() {
  return (
    <div className="space-y-6 px-5 py-5">
      {/* Image section */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-6 rounded-md" />
          <Skeleton className="h-4 w-24 rounded" />
        </div>
        <div className="pl-8">
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      </div>
      {/* Details + economy sections */}
      {Array.from({ length: 2 }).map((_, s) => (
        <div key={s} className="space-y-3">
          <div className="flex items-center gap-2">
            <Skeleton className="size-6 rounded-md" />
            <Skeleton className="h-4 w-28 rounded" />
          </div>
          <div className="grid grid-cols-1 gap-3 pl-8 sm:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3 w-16 rounded" />
                <Skeleton className="h-9 w-full rounded-md" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function CreateCardButton({
  sets,
  defaultSetId = "",
}: {
  sets: { id: string; name: string }[];
  /**
   * Pre-selects the Set dropdown when the dialog opens. Driven by the
   * active per-set tab on /cards. Empty string (the default) means no
   * preselection.
   */
  defaultSetId?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="size-4" />
        Create Card
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto p-0">
        {/* Header band — gradient to match the hero aesthetic. Stays in the
            light wrapper so it paints instantly when the dialog opens. */}
        <div className="relative overflow-hidden rounded-t-xl border-b bg-gradient-to-br from-card via-card to-card/60 px-5 py-4">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-blue-500/[0.06] blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -left-16 -bottom-16 size-48 rounded-full bg-purple-500/[0.06] blur-3xl"
          />
          <DialogHeader className="relative">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
                <Sparkles className="size-4 text-primary" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold leading-tight">
                  Create Card
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  Add a new card to the catalog.
                </p>
              </div>
            </div>
          </DialogHeader>
        </div>

        {/* Gate the heavy form on `open` so its chunk only downloads + its
            state only mounts once the dialog is opened. keepMounted keeps a
            half-built draft across an accidental close (the form resets
            itself only after a successful create), without shipping the
            chunk until first open. */}
        <LazyModalContent
          open={open}
          keepMounted
          minHeight={320}
          fallback={<CreateCardFormFallback />}
        >
          <CreateCardForm
            sets={sets}
            defaultSetId={defaultSetId}
            onClose={() => setOpen(false)}
          />
        </LazyModalContent>
      </DialogContent>
    </Dialog>
  );
}
