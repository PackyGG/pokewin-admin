import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Flag,
  Gauge,
  ShieldAlert,
} from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { KpiTile, PageHero } from "@/components/modern-panels";
import { Card } from "@/components/ui/card";
import { listMultiplierReviewQueue } from "../multiplier-actions";

import { ReviewQueueTable } from "./_components/review-queue-table";
import { ReviewQueueFilters } from "./_components/review-queue-filters";

export const metadata = { title: "Multiplier Review" };

type SearchParamRecord = Record<string, string | string[] | undefined>;

const PAGE_SIZE = 25;

/**
 * Global review queue across all creators — lists every multiplier deal
 * currently in pending_review or flagged status, oldest-first.
 *
 * Two read passes: one for the queue page itself (paged), one for the
 * KPI counts (full unfiltered set + flagged-only set). The counts are
 * computed by reading both queues in parallel; for MVP we accept the
 * small extra request rather than building a dedicated count endpoint.
 *
 * Query params:
 *   ?flagged_only=1 — narrow to flagged status only
 *   ?offset=N       — pagination offset
 */
export default async function MultiplierReviewPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamRecord>;
}) {
  await requirePageAccess("/creators");
  const sp = await searchParams;

  const offsetParam = Array.isArray(sp.offset) ? sp.offset[0] : sp.offset;
  const offset = Math.max(0, parseInt(offsetParam ?? "0", 10) || 0);

  const flaggedRaw = Array.isArray(sp.flagged_only)
    ? sp.flagged_only[0]
    : sp.flagged_only;
  const flaggedOnly = flaggedRaw === "1" || flaggedRaw === "true";

  // Queue page (filtered) + full counts in parallel. Both calls are
  // small (max 25-50 rows) so we don't need streaming Suspense here.
  const [page, allCounts, flaggedCounts] = await Promise.all([
    listMultiplierReviewQueue({
      offset,
      limit: PAGE_SIZE,
      flagged_only: flaggedOnly,
    }),
    listMultiplierReviewQueue({ offset: 0, limit: 1 }),
    listMultiplierReviewQueue({ offset: 0, limit: 1, flagged_only: true }),
  ]);

  const totalPending = allCounts.total;
  const totalFlagged = flaggedCounts.total;
  const totalCleanPending = Math.max(0, totalPending - totalFlagged);

  // Oldest awaiting — the first row in the global unfiltered list is the
  // earliest. We use its ended_at as a relative-time tile so reviewers see
  // how long the queue tail has been waiting.
  const oldestPage = await listMultiplierReviewQueue({
    offset: 0,
    limit: 1,
  }).catch(() => null);
  const oldestEndedAt = oldestPage?.data[0]?.ended_at ?? null;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-amber-500/10">
              <ShieldAlert className="size-5 text-amber-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">
                Multiplier Review
              </h1>
              <p className="text-sm text-muted-foreground">
                Settle ended multiplier streams — issue payout vouchers or
                reject deals across all creators. Oldest first.
              </p>
            </div>
          </div>
          <ReviewQueueFilters flaggedOnly={flaggedOnly} />
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-4">
        <KpiTile
          label="Awaiting review"
          value={String(totalCleanPending)}
          icon={Gauge}
          accent="blue"
        />
        <KpiTile
          label="Flagged"
          value={String(totalFlagged)}
          icon={Flag}
          accent="amber"
        />
        <KpiTile
          label="Total in queue"
          value={String(totalPending)}
          icon={AlertTriangle}
          accent="orange"
        />
        <KpiTile
          label="Oldest waiting"
          value={
            oldestEndedAt
              ? (new Date(oldestEndedAt)
                  .toISOString()
                  .split("T")[0] ?? "—")
              : "—"
          }
          icon={Clock}
          accent="cyan"
        />
      </div>

      <Card size="sm" className="overflow-hidden p-0">
        <ReviewQueueTable
          deals={page.data}
          total={page.total}
          offset={offset}
          pageSize={PAGE_SIZE}
          flaggedOnly={flaggedOnly}
        />
      </Card>
    </div>
  );
}
