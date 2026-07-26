"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  CheckCircle2,
  Clock3,
  Loader2,
  PackageOpen,
  Rocket,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import {
  approvePackCreationRequest,
  declinePackCreationRequestAction,
} from "@/app/(admin)/packs/actions";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import type { PackCreationRequestStatus } from "@/lib/packs/build-requests";

export type PackRequestReviewItem = {
  id: string;
  status: PackCreationRequestStatus;
  requesterUsername: string;
  reviewerUsername: string | null;
  name: string;
  slug: string;
  requestedActive: boolean;
  price: number;
  cardCount: number;
  difficulty: number;
  previewEdge: number;
  previewWinRate: number;
  createdPackId: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

const STATUS_SPEC: Record<
  PackCreationRequestStatus,
  { label: string; className: string }
> = {
  pending: {
    label: "Pending",
    className:
      "border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  processing: {
    label: "Processing",
    className:
      "border-blue-500/30 bg-blue-500/15 text-blue-600 dark:text-blue-400",
  },
  approved: {
    label: "Approved",
    className:
      "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  declined: {
    label: "Declined",
    className:
      "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400",
  },
};

export function PackRequestReviewList({
  requests,
}: {
  requests: PackRequestReviewItem[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [activeAction, setActiveAction] = useState<string | null>(null);

  function approve(item: PackRequestReviewItem) {
    setActiveAction(`approve:${item.id}`);
    startTransition(async () => {
      try {
        const result = await approvePackCreationRequest(item.id);
        toast.success(
          result.active
            ? `${item.name} approved and pushed live`
            : `${item.name} approved as an inactive pack`,
        );
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Approval failed");
      } finally {
        setActiveAction(null);
      }
    });
  }

  function decline(item: PackRequestReviewItem) {
    setActiveAction(`decline:${item.id}`);
    startTransition(async () => {
      try {
        await declinePackCreationRequestAction(item.id);
        toast.success(`${item.name} declined`);
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Decline failed");
      } finally {
        setActiveAction(null);
      }
    });
  }

  if (requests.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center">
        <PackageOpen className="size-5 text-muted-foreground" />
        <p className="text-sm font-semibold">No pack requests yet</p>
        <p className="text-xs text-muted-foreground">
          Pack Builder submissions will appear here before anything reaches production.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {requests.map((item) => {
        const status = STATUS_SPEC[item.status];
        const approving = activeAction === `approve:${item.id}`;
        const declining = activeAction === `decline:${item.id}`;
        return (
          <article
            key={item.id}
            className={cn(
              "rounded-xl border border-border/70 bg-card p-4",
              item.status === "pending" && "border-amber-500/25",
            )}
          >
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-sm font-semibold">{item.name}</h3>
                  <Badge variant="outline" className={status.className}>
                    {status.label}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={
                      item.requestedActive
                        ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                        : "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                    }
                  >
                    {item.requestedActive ? (
                      <Rocket className="mr-1 size-3" />
                    ) : (
                      <Clock3 className="mr-1 size-3" />
                    )}
                    {item.requestedActive ? "Go live" : "Inactive draft"}
                  </Badge>
                </div>

                <p className="text-xs text-muted-foreground">
                  /{item.slug} · requested by {item.requesterUsername} ·{" "}
                  {formatDateTime(item.createdAt)}
                </p>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <span>
                    Price <strong>{formatCurrency(item.price)}</strong>
                  </span>
                  <span>
                    Cards <strong>{item.cardCount}</strong>
                  </span>
                  <span>
                    Edge <strong>{(item.previewEdge * 100).toFixed(2)}%</strong>
                  </span>
                  <span>
                    Win rate{" "}
                    <strong>{(item.previewWinRate * 100).toFixed(1)}%</strong>
                  </span>
                  <span>
                    Risk bar <strong>{Math.round(item.difficulty * 100)}%</strong>
                  </span>
                </div>

                {item.reviewerUsername && item.reviewedAt && (
                  <p className="text-xs text-muted-foreground">
                    Reviewed by {item.reviewerUsername} ·{" "}
                    {formatDateTime(item.reviewedAt)}
                  </p>
                )}
              </div>

              {item.status === "pending" ? (
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isPending}
                    onClick={() => decline(item)}
                    className="gap-2"
                  >
                    {declining ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <X className="size-4" />
                    )}
                    Decline
                  </Button>
                  <Button
                    type="button"
                    disabled={isPending}
                    onClick={() => approve(item)}
                    className="gap-2"
                  >
                    {approving ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Check className="size-4" />
                    )}
                    Approve
                  </Button>
                </div>
              ) : item.createdPackId ? (
                <Link
                  href={`/packs/${item.createdPackId}`}
                  className={cn(
                    buttonVariants({ variant: "outline" }),
                    "shrink-0 gap-2",
                  )}
                >
                  <CheckCircle2 className="size-4" />
                  Open pack
                </Link>
              ) : item.status === "declined" ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <XCircle className="size-4" />
                  No production pack created
                </span>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
