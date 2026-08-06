import { cache, Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Inbox} from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { FadeIn } from "@/components/fade-in";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHero, PageHeroIdentity, KpiTile } from "@/components/modern-panels";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { creatorsApi, type CreatorSocialStatus } from "@/lib/backend-api";

import { SocialsQueueTabs } from "./tabs";
import { SocialReviewActions } from "./review-actions";
import { SocialsQueueCardSkeleton } from "./queue-skeleton";

export const metadata = { title: "Creator Socials" };

const STATUS_TONES: Record<CreatorSocialStatus, string> = {
  pending: "bg-amber-500/10 text-amber-600 dark:text-amber-300",
  approved: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  rejected: "bg-rose-500/10 text-rose-600 dark:text-rose-300",
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

const PAGE_LIMIT = 50;

type SocialsPayload = {
  items: Awaited<ReturnType<typeof creatorsApi.listSocials>>["items"];
  total: number;
  loadError: { title: string; detail: string } | null;
};

/**
 * The one backend read this page makes, wrapped so it can never block first
 * paint or hang the route:
 *
 *   - `safeQuery(..., REWARD_QUERY_TIMEOUT_MS)` bounds it — before, a hung
 *     backend hung the whole page body with no timeout at all.
 *   - `cache()` dedupes it per request, so the hero's "Total in queue" tile
 *     and the list body (two separate Suspense boundaries) share ONE HTTP
 *     call — exactly the single call the page made before.
 *
 * The original try/catch semantics are preserved: any failure degrades to an
 * empty list plus the same friendly `loadError` box (with the missing-table
 * special case) instead of crashing the admin layout.
 */
const loadSocials = cache(
  async (status: CreatorSocialStatus, offset: number): Promise<SocialsPayload> => {
    const { data, error } = await safeQuery(
      () => creatorsApi.listSocials({ status, limit: PAGE_LIMIT, offset }),
      { items: [], total: 0 } as Awaited<
        ReturnType<typeof creatorsApi.listSocials>
      >,
      "creators.socials",
      REWARD_QUERY_TIMEOUT_MS,
    );

    if (!error) return { items: data.items, total: data.total, loadError: null };

    // Likely a "feature not deployed" state — table missing, route 404,
    // backend env unreachable. Surface a friendly box instead of crashing
    // the whole admin layout.
    const isMissingTable =
      /relation .* does not exist|creator_socials/i.test(error);
    return {
      items: [],
      total: 0,
      loadError: {
        title: isMissingTable
          ? "Creator Socials feature not yet enabled"
          : "Could not load social submissions",
        detail: isMissingTable
          ? "The creator_socials migration has not been applied on this environment yet. Run the migration to enable this page."
          : error,
      },
    };
  },
);

export default async function CreatorSocialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/creators");

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
          action={
            <Suspense
              key={`kpi|${status}|${offset}`}
              fallback={<KpiTile label="Total in queue" value="—" icon={Inbox} />}
            >
              <QueueTotalTile status={status} offset={offset} />
            </Suspense>
          }
        />
      </PageHero>

      <Suspense
        key={`${status}|${offset}`}
        fallback={<SocialsQueueCardSkeleton rows={8} />}
      >
        <SocialsQueueBody status={status} offset={offset} />
      </Suspense>
    </div>
  );
}

/** Hero KPI — same value as before, streamed instead of blocking the shell. */
async function QueueTotalTile({
  status,
  offset,
}: {
  status: CreatorSocialStatus;
  offset: number;
}) {
  const { total } = await loadSocials(status, offset);
  return (
    <KpiTile
      label="Total in queue"
      value={status === "pending" ? String(total) : "—"}
      icon={Inbox}
    />
  );
}

async function SocialsQueueBody({
  status,
  offset,
}: {
  status: CreatorSocialStatus;
  offset: number;
}) {
  const { items, total, loadError } = await loadSocials(status, offset);
  const limit = PAGE_LIMIT;

  return (
      <FadeIn>
        <Card size="sm" className="p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <SocialsQueueTabs current={status} />
            <span className="text-xs text-muted-foreground">
              Showing {items.length} of {total}
            </span>
          </div>

          {loadError ? (
            <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-4">
              <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                {loadError.title}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {loadError.detail}
              </div>
            </div>
          ) : items.length === 0 ? (
            <div className="mt-6 flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-muted-foreground">
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
                            href={`/creators/${row.user_id}`}
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
                          <span>
                            Submitted {submittedAt.toLocaleString()}
                          </span>
                          {reviewedAt ? (
                            <span>
                              · Reviewed {reviewedAt.toLocaleString()}
                            </span>
                          ) : null}
                          {row.rejection_reason ? (
                            <span className="text-rose-500">
                              · Reason: {row.rejection_reason}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    {row.status === "pending" ? (
                      <SocialReviewActions socialId={row.id} />
                    ) : (
                      <span className="text-xs text-muted-foreground italic">
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
              limit={limit}
              total={total}
              shown={items.length}
            />
          )}
        </Card>
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
    return `/creators/socials?${params.toString()}`;
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
          <span className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-semibold text-muted-foreground/40 cursor-not-allowed">
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
          <span className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-semibold text-muted-foreground/40 cursor-not-allowed">
            Next
            <ChevronRight className="size-3.5" />
          </span>
        )}
      </div>
    </div>
  );
}
