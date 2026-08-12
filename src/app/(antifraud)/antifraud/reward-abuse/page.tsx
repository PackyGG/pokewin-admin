import { Suspense } from "react";
import { Search } from "lucide-react";

import { HostLink } from "@/components/host-link";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { getRewardAbuseCounts, listRewardAbuseReviews, type RewardAbuseReview, type RewardAbuseStatus } from "@/lib/antifraud/reward-abuse";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { RewardAbuseReviewActions } from "./review-actions";

export const metadata = { title: "Reward Abuse" };

const TABS: Array<{ status: RewardAbuseStatus; label: string }> = [
  { status: "pending", label: "Pending" },
  { status: "confirmed", label: "Confirmed" },
  { status: "dismissed", label: "Dismissed" },
];

export default async function RewardAbusePage({ searchParams }: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  await requireAntifraudPageAccess();
  const params = await searchParams;
  const status = TABS.some((tab) => tab.status === params.status)
    ? params.status as RewardAbuseStatus : "pending";
  const search = params.q?.trim() || undefined;
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>
      <Suspense key={`${status}-${search ?? ""}`} fallback={<QueueSkeleton />}>
        <ReviewQueue status={status} search={search} />
      </Suspense>
    </div>
  );
}

async function ReviewQueue({ status, search }: { status: RewardAbuseStatus; search?: string }) {
  const [reviews, counts] = await Promise.all([
    listRewardAbuseReviews({ status, search }),
    getRewardAbuseCounts(),
  ]);
  return (
    <section className="space-y-4">
      <div className="rounded-xl border bg-card p-3 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <nav className="flex flex-wrap gap-1" aria-label="Reward abuse status">
            {TABS.map((tab) => (
              <HostLink key={tab.status} href={`/antifraud/reward-abuse?status=${tab.status}${search ? `&q=${encodeURIComponent(search)}` : ""}`} className={cn("rounded-lg px-3 py-2 text-sm font-medium", status === tab.status ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted") }>
                {tab.label} <span className="ml-1 tabular-nums">{counts[tab.status]}</span>
              </HostLink>
            ))}
          </nav>
          <form className="flex gap-2" action="/antifraud/reward-abuse">
            <input type="hidden" name="status" value={status} />
            <Input name="q" defaultValue={search} placeholder="Username or user ID" aria-label="Search reward reviews" />
            <Button type="submit" variant="outline"><Search /> Search</Button>
          </form>
        </div>
      </div>
      {reviews.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">No {status} rain-abuse reviews.</div>
      ) : (
        <div className="space-y-3">{reviews.map((review) => <ReviewCard key={review.id} review={review} />)}</div>
      )}
    </section>
  );
}

function usd(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="rounded-lg border bg-muted/20 p-3"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 font-semibold tabular-nums">{value}</p>{note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}</div>;
}

function ReviewCard({ review }: { review: RewardAbuseReview }) {
  const m = review.metrics;
  return (
    <article id={`review-${review.id}`} className="scroll-mt-20 rounded-xl border bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <HostLink href={`/users/${review.userId}`} target="_blank" className="font-semibold hover:underline">{review.username ?? review.userId}</HostLink>
            <Badge variant="outline" className={cn(review.severity === "critical" ? "border-red-500/30 bg-red-500/10 text-red-600" : review.severity === "high" ? "border-orange-500/30 bg-orange-500/10 text-orange-600" : "border-amber-500/30 bg-amber-500/10 text-amber-600")}>{review.score}/100 · {review.severity}</Badge>
            <Badge variant="secondary">{review.status}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">Detected {formatRelative(review.lastDetectedAt)} · window ended {formatDateTime(review.windowEndedAt)}</p>
        </div>
        {review.status === "pending" ? <RewardAbuseReviewActions reviewId={review.id} /> : <div className="max-w-md text-sm"><p className="font-medium">{review.reviewReason}</p><p className="text-xs text-muted-foreground">{review.reviewerUsername ?? "Staff"} · {review.reviewedAt ? formatDateTime(review.reviewedAt) : ""}{review.rainLockApplied ? " · Rain disabled" : " · No account change"}</p></div>}
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
        <Metric label="Rain entries" value={m.entries.toLocaleString()} note={`${m.entryDays} active days`} />
        <Metric label="Net Rain retained" value={usd(m.netRainUsd)} note={`${usd(m.rainUsd)} won · ${usd(m.rainTipsUsd)} tipped`} />
        <Metric label="Deposits · 30d" value={usd(m.deposits30dUsd)} note={`${Math.round((m.deposits30dUsd / Math.max(m.netRainUsd, .01)) * 100)}% of net Rain`} />
        <Metric label="Real-money play" value={usd(m.wagerUsd)} note={`${m.games} paid game sessions`} />
        <Metric label="Pack pattern" value={`${Math.round(m.packGameRatio * 100)}%`} note={`${m.packGames} pack sessions`} />
        <Metric label="Bonus-funded packs" value={`${Math.round(m.bonusFundedPackRatio * 100)}%`} note="Inference; general bonus pool" />
      </div>
    </article>
  );
}

function QueueSkeleton() {
  return <div className="space-y-3"><Skeleton className="h-24 rounded-xl" /><Skeleton className="h-72 rounded-xl" /><Skeleton className="h-72 rounded-xl" /></div>;
}
