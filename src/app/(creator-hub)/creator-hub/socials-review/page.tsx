import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Inbox,
  ShieldCheck,
} from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { FadeIn } from "@/components/fade-in";
import { Badge } from "@/components/ui/badge";
import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { creatorsApi, type CreatorSocialStatus } from "@/lib/backend-api";

import { SocialsQueueTabs } from "./tabs";
import { SocialReviewActions } from "./review-actions";

export const metadata = { title: "Socials Review · Creator Hub" };

const HUB_SOCIALS_REVIEW_PATH = "/creator-hub/socials-review";

const STATUS_TONES: Record<CreatorSocialStatus, string> = {
  pending: "bg-amber-500/10 text-amber-600 dark:text-amber-300",
  approved: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  rejected: "bg-red-500/10 text-red-600 dark:text-red-300",
};

const PLATFORM_LABEL: Record<string, string> = {
  twitch: "Twitch",
  kick: "Kick",
  youtube: "YouTube",
  x: "X",
  instagram: "Instagram",
  tiktok: "TikTok",
  discord: "Discord",
};

const LIMIT = 50;

/**
 * Creator Hub → Socials Review.
 *
 * 1:1 port of `/creators/socials`: the approval queue for creator-uploaded
 * social accounts. Reads via `creatorsApi.listSocials` (backend API / MAIN
 * DB read-only from the admin panel's perspective); approve/reject mutations
 * write through the backend API and stamp ADMIN-DB audit rows.
 *
 * ACCESS: `canAccessCreatorHub` (founder `motha`, or a role whose ADMIN-DB
 * toggle is on) — NOT bare `requireRole`. The Hub layout already guards the
 * segment; this page adds the explicit gate per house convention.
 *
 * LAZY: the data-bearing queue is wrapped in a `<Suspense key={status-offset}>`
 * boundary so the hero paints immediately and each status tab (and pagination
 * page) loads on demand.
 */
export default async function SocialsReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const params = await searchParams;
  const status: CreatorSocialStatus =
    params.status === "approved" || params.status === "rejected"
      ? params.status
      : "pending";
  const offset = Math.max(0, Number(params.offset ?? "0")) || 0;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ShieldCheck}
          accent="pink"
          title="Socials Review"
          subtitle="Approve or reject social accounts submitted by creators"
        />
      </PageHero>

      <Suspense key={`${status}-${offset}`} fallback={<QueueSkeleton />}>
        <QueueSection status={status} offset={offset} />
      </Suspense>
    </div>
  );
}

// ─── Data section (streamed via Suspense) ───────────────────────────

async function QueueSection({
  status,
  offset,
}: {
  status: CreatorSocialStatus;
  offset: number;
}) {
  let items: Awaited<ReturnType<typeof creatorsApi.listSocials>>["items"] =
    [];
  let total = 0;
  let loadError: { title: string; detail: string } | null = null;

  try {
    const result = await creatorsApi.listSocials({
      status,
      limit: LIMIT,
      offset,
    });
    items = result.items;
    total = result.total;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const isMissingTable =
      /relation .* does not exist|creator_socials/i.test(detail);
    loadError = {
      title: isMissingTable
        ? "Creator Socials feature not yet enabled"
        : "Could not load social submissions",
      detail: isMissingTable
        ? "The creator_socials migration has not been applied on this environment yet. Run the migration to enable this page."
        : detail,
    };
    console.error("[creator-hub/socials-review] listSocials failed:", err);
  }

  return (
    <FadeIn>
      {status === "pending" && !loadError && (
        <div className="mb-4 grid grid-cols-1 gap-3 sm:max-w-xs">
          <KpiTile
            label="Pending in queue"
            value={String(total)}
            sub="awaiting review"
            icon={Inbox}
            accent="pink"
          />
        </div>
      )}

      <div className="rounded-2xl border bg-card p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <SocialsQueueTabs current={status} />
          <span className="text-xs text-muted-foreground">
            Showing {items.length} of {total}
          </span>
        </div>

        {loadError ? (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-4">
            <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">
              {loadError.title}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {loadError.detail}
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground">
            <Inbox className="size-6" />
            <span className="text-sm">No submissions in this status.</span>
          </div>
        ) : (
          <ul className="mt-4 divide-y">
            {items.map((row) => {
              const submittedAt = new Date(row.submitted_at);
              const reviewedAt = row.reviewed_at
                ? new Date(row.reviewed_at)
                : null;
              return (
                <li
                  key={row.id}
                  className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <div className="size-9 shrink-0 overflow-hidden rounded-full bg-muted">
                      {row.creator_image ? (
                        <Image
                          src={row.creator_image}
                          alt={row.creator_username ?? row.user_id}
                          width={36}
                          height={36}
                          className="size-full object-cover"
                          unoptimized
                        />
                      ) : null}
                    </div>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/creator-hub/creators/${row.user_id}`}
                          className="text-sm font-semibold hover:underline"
                        >
                          {row.creator_username ?? row.user_id}
                        </Link>
                        <Badge variant="outline" className="text-[10px]">
                          {PLATFORM_LABEL[row.platform] ?? row.platform}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${STATUS_TONES[row.status]}`}
                        >
                          {row.status}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="font-medium">{row.username}</span>
                        {row.url ? (
                          <a
                            href={row.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="truncate hover:underline"
                          >
                            {row.url}
                          </a>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                        <span>Submitted {submittedAt.toLocaleString()}</span>
                        {reviewedAt ? (
                          <span>· Reviewed {reviewedAt.toLocaleString()}</span>
                        ) : null}
                        {row.rejection_reason ? (
                          <span className="text-red-500">
                            · Reason: {row.rejection_reason}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {row.status === "pending" ? (
                    <SocialReviewActions socialId={row.id} />
                  ) : (
                    <span className="text-xs italic text-muted-foreground">
                      Already reviewed
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {!loadError && total > 0 && (
          <PaginationFooter
            status={status}
            offset={offset}
            limit={LIMIT}
            total={total}
            shown={items.length}
          />
        )}
      </div>
    </FadeIn>
  );
}

function PaginationFooter({
  status,
  offset,
  limit,
  total,
  shown,
}: {
  status: CreatorSocialStatus;
  offset: number;
  limit: number;
  total: number;
  shown: number;
}) {
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = offset + shown;
  const hasPrev = offset > 0;
  const hasNext = pageEnd < total;

  const linkFor = (nextOffset: number) => {
    const params = new URLSearchParams();
    params.set("status", status);
    if (nextOffset > 0) params.set("offset", String(nextOffset));
    return `${HUB_SOCIALS_REVIEW_PATH}?${params.toString()}`;
  };

  return (
    <div className="mt-4 flex items-center justify-between border-t pt-3">
      <span className="text-xs text-muted-foreground">
        {pageStart}–{pageEnd} of {total}
      </span>
      <div className="flex items-center gap-2">
        {hasPrev ? (
          <Link
            href={linkFor(Math.max(0, offset - limit))}
            className="inline-flex h-8 items-center gap-1 rounded-md border bg-background px-3 text-xs font-semibold hover:bg-muted"
          >
            <ChevronLeft className="size-3.5" />
            Previous
          </Link>
        ) : (
          <span className="inline-flex h-8 cursor-not-allowed items-center gap-1 rounded-md border px-3 text-xs font-semibold text-muted-foreground/40">
            <ChevronLeft className="size-3.5" />
            Previous
          </span>
        )}
        {hasNext ? (
          <Link
            href={linkFor(offset + limit)}
            className="inline-flex h-8 items-center gap-1 rounded-md border bg-background px-3 text-xs font-semibold hover:bg-muted"
          >
            Next
            <ChevronRight className="size-3.5" />
          </Link>
        ) : (
          <span className="inline-flex h-8 cursor-not-allowed items-center gap-1 rounded-md border px-3 text-xs font-semibold text-muted-foreground/40">
            Next
            <ChevronRight className="size-3.5" />
          </span>
        )}
      </div>
    </div>
  );
}

// ─── In-boundary skeleton (tab / page switch) ───────────────────────

function QueueSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-[88px] max-w-xs rounded-xl" />
      <div className="rounded-2xl border bg-card p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="inline-flex gap-1 rounded-lg border p-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-20 rounded-md" />
            ))}
          </div>
          <Skeleton className="h-3 w-28 rounded" />
        </div>
        <ul className="mt-4 divide-y">
          {Array.from({ length: 4 }).map((_, i) => (
            <li
              key={i}
              className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between"
            >
              <div className="flex items-start gap-3">
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-32 rounded" />
                  <Skeleton className="h-3 w-48 rounded" />
                </div>
              </div>
              <div className="flex gap-2">
                <Skeleton className="h-8 w-20 rounded-md" />
                <Skeleton className="h-8 w-20 rounded-md" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
