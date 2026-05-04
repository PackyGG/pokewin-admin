import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Inbox, ShieldCheck } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { FadeIn } from "@/components/fade-in";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  PageHero,
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import { creatorsApi, type CreatorSocialStatus } from "@/lib/backend-api";

import { SocialsQueueTabs } from "./tabs";
import { SocialReviewActions } from "./review-actions";

export const metadata = { title: "Creator Socials" };

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
  const limit = 50;
  const offset = Math.max(0, Number(params.offset ?? "0")) || 0;

  let items: Awaited<ReturnType<typeof creatorsApi.listSocials>>["items"] = [];
  let total = 0;
  let loadError: { title: string; detail: string } | null = null;

  try {
    const result = await creatorsApi.listSocials({ status, limit, offset });
    items = result.items;
    total = result.total;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Likely a "feature not deployed" state — table missing, route 404,
    // backend env unreachable. Surface a friendly box instead of crashing
    // the whole admin layout.
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
    // eslint-disable-next-line no-console
    console.error("[creators/socials] listSocials failed:", err);
  }

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-500/10">
              <ShieldCheck className="size-5 text-emerald-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Creator Socials</h1>
              <p className="text-sm text-muted-foreground">
                Approve or reject social accounts submitted by creators.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <KpiTile
              label="Total in queue"
              value={status === "pending" ? String(total) : "—"}
            />
          </div>
        </div>
      </PageHero>

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
                      <SectionHeading className="text-xs text-muted-foreground">
                        Already reviewed
                      </SectionHeading>
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
    </div>
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
