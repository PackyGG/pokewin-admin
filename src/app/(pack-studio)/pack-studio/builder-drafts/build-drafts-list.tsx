"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ClipboardList,
  ImageUp,
  Loader2,
  Pencil,
  Rocket,
  Trash2,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

import {
  discardPackBuildDraftAction,
  requestPackBuildDraftApproval,
  updatePackBuildDraftImageAction,
} from "../builder/actions";
import { CardImage } from "@/components/card-image";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { uploadImageClient } from "@/lib/upload-image-client";
import { isPackBuilderEdgeInRange } from "@/lib/packs/builder-edge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";

export type PackBuildDraftItem = {
  id: string;
  requesterUsername: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  price: number;
  cardCount: number;
  difficulty: number;
  previewEdge: number;
  previewWinRate: number;
  createdAt: string;
};

export function BuildDraftsList({
  drafts,
}: {
  drafts: PackBuildDraftItem[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    kind: "submit" | "discard";
    draft: PackBuildDraftItem;
  } | null>(null);

  function requestApproval(draft: PackBuildDraftItem) {
    if (!draft.imageUrl) {
      toast.error(
        "Add a pack image before requesting live approval. The draft is still saved.",
      );
      return;
    }
    if (!isPackBuilderEdgeInRange(draft.previewEdge)) {
      toast.error(
        "This saved build is outside the strict 10.95%–11.50% edge band and cannot be sent live.",
      );
      return;
    }
    setActiveAction(`submit:${draft.id}`);
    startTransition(async () => {
      try {
        const result = await requestPackBuildDraftApproval(draft.id);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(`${draft.name} sent for live approval.`);
        router.refresh();
      } catch {
        toast.error("Could not request approval for this build draft.");
      } finally {
        setActiveAction(null);
      }
    });
  }

  function uploadDraftImage(draft: PackBuildDraftItem, file: File) {
    setActiveAction(`image:${draft.id}`);
    startTransition(async () => {
      try {
        const imageUrl = await uploadImageClient(file, "/packs");
        const result = await updatePackBuildDraftImageAction(
          draft.id,
          imageUrl,
        );
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(`${draft.name} image updated.`);
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not upload this pack image.",
        );
      } finally {
        setActiveAction(null);
      }
    });
  }

  function discard(draft: PackBuildDraftItem) {
    setActiveAction(`discard:${draft.id}`);
    startTransition(async () => {
      try {
        const result = await discardPackBuildDraftAction(draft.id);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(`${draft.name} discarded.`);
        router.refresh();
      } catch {
        toast.error("Could not discard this build draft.");
      } finally {
        setActiveAction(null);
      }
    });
  }

  if (drafts.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center">
        <ClipboardList className="size-6 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-semibold">No saved build drafts</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Use Save build draft in Pack Builder. It appears here immediately
            without owner approval.
          </p>
        </div>
        <Link
          href="/pack-studio/builder"
          className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
        >
          <Wand2 className="size-4" />
          Open Pack Builder
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <AlertDialog open={confirmation !== null} onOpenChange={(open) => !open && setConfirmation(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.kind === "discard" ? "Discard saved build?" : "Request live approval?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.kind === "discard"
                ? `“${confirmation.draft.name}” will leave Saved Builds. Its revision history remains auditable.`
                : `“${confirmation?.draft.name}” will move to the owner approval queue. Nothing goes live until an owner approves it.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              const selected = confirmation;
              setConfirmation(null);
              if (!selected) return;
              if (selected.kind === "discard") discard(selected.draft);
              else requestApproval(selected.draft);
            }}>
              {confirmation?.kind === "discard" ? "Discard build" : "Submit request"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {drafts.map((draft) => {
        const submitting = activeAction === `submit:${draft.id}`;
        const discarding = activeAction === `discard:${draft.id}`;
        const uploadingImage = activeAction === `image:${draft.id}`;
        const edgeWithinProductionBand = isPackBuilderEdgeInRange(
          draft.previewEdge,
        );
        return (
          <article
            key={draft.id}
            className="rounded-xl border border-border/70 bg-card p-4"
          >
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
              <div className="flex min-w-0 flex-1 gap-3">
                <CardImage
                  src={draft.imageUrl}
                  alt={draft.name}
                  className="size-16 shrink-0 rounded-lg border border-border/70"
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold">{draft.name}</h3>
                    <Badge
                      variant="outline"
                      className="border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                    >
                      Saved draft
                    </Badge>
                    {!draft.imageUrl && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      >
                        Image required for live
                      </Badge>
                    )}
                    {!edgeWithinProductionBand && (
                      <Badge
                        variant="outline"
                        className="border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                      >
                        Edge outside 10.95%–11.50%
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    /{draft.slug} · saved by {draft.requesterUsername} ·{" "}
                    {formatDateTime(draft.createdAt)}
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    <span>
                      Price <strong>{formatCurrency(draft.price)}</strong>
                    </span>
                    <span>
                      Cards <strong>{draft.cardCount}</strong>
                    </span>
                    <span>
                      Edge <strong>{(draft.previewEdge * 100).toFixed(2)}%</strong>
                    </span>
                    <span>
                      Win rate{" "}
                      <strong>{(draft.previewWinRate * 100).toFixed(1)}%</strong>
                    </span>
                    <span>
                      Risk bar <strong>{Math.round(draft.difficulty * 100)}%</strong>
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                <label
                  aria-disabled={isPending}
                  className={cn(
                    buttonVariants({ variant: "outline" }),
                    "gap-2",
                    isPending && "pointer-events-none opacity-50",
                  )}
                >
                  {uploadingImage ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ImageUp className="size-4" />
                  )}
                  {draft.imageUrl ? "Replace image" : "Add image"}
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    disabled={isPending}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) uploadDraftImage(draft, file);
                    }}
                  />
                </label>
                <Link
                  href={`/pack-studio/builder?draft=${encodeURIComponent(draft.id)}`}
                  className={cn(
                    buttonVariants({ variant: "outline" }),
                    "gap-2",
                  )}
                >
                  <Pencil className="size-4" />
                  Edit build
                </Link>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => setConfirmation({ kind: "discard", draft })}
                  className="gap-2"
                >
                  {discarding ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  Discard
                </Button>
                <Button
                  type="button"
                  disabled={
                    isPending || !draft.imageUrl || !edgeWithinProductionBand
                  }
                  onClick={() => setConfirmation({ kind: "submit", draft })}
                  className="gap-2"
                >
                  {submitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Rocket className="size-4" />
                  )}
                  Request live approval
                </Button>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
