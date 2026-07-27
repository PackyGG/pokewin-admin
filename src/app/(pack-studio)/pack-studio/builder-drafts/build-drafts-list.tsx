"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ClipboardList,
  Loader2,
  Rocket,
  Trash2,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

import {
  discardPackBuildDraftAction,
  requestPackBuildDraftApproval,
} from "../builder/actions";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";

export type PackBuildDraftItem = {
  id: string;
  requesterUsername: string;
  name: string;
  slug: string;
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

  function requestApproval(draft: PackBuildDraftItem) {
    if (
      !window.confirm(
        `Send "${draft.name}" to the owner queue as a live request?`,
      )
    ) {
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

  function discard(draft: PackBuildDraftItem) {
    if (!window.confirm(`Discard the saved build "${draft.name}"?`)) return;
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
      {drafts.map((draft) => {
        const submitting = activeAction === `submit:${draft.id}`;
        const discarding = activeAction === `discard:${draft.id}`;
        return (
          <article
            key={draft.id}
            className="rounded-xl border border-border/70 bg-card p-4"
          >
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-sm font-semibold">{draft.name}</h3>
                  <Badge
                    variant="outline"
                    className="border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                  >
                    Saved draft
                  </Badge>
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

              <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => discard(draft)}
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
                  disabled={isPending}
                  onClick={() => requestApproval(draft)}
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
