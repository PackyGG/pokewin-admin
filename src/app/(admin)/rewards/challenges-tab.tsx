import { Suspense } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import {
  challengesApi,
  type Challenge,
  type ChallengeStatus,
} from "@/lib/backend-api";
import { safeQuery } from "@/lib/errors/safe-query";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { parsePagination } from "@/lib/utils/pagination";
import { CreateChallengeButton } from "../challenges/create-challenge-button";
import { ChallengesTable } from "../challenges/challenges-table";
import { FadeIn } from "@/components/fade-in";
import { LinkPending } from "@/components/ux";

/**
 * Challenges tab of the merged /rewards page (was the standalone /challenges
 * page). Challenge data lives in the MAIN game DB and is read/written via the
 * backend admin API (challengesApi) — this panel never writes it directly.
 *
 * Status filtering is driven by `?status=`. Only this tab's list is awaited
 * when the top-level tab is `challenges` (active-tab-only, CLAUDE.md).
 */
const STATUS_TABS = ["all", "active", "inactive", "archived"] as const;

function normalizeStatus(raw?: string): ChallengeStatus | undefined {
  if (raw === "active" || raw === "inactive" || raw === "archived") return raw;
  return undefined;
}

export function ChallengesTab({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const { page, perPage } = parsePagination(params);
  const status = normalizeStatus(params.status);

  const suspenseKey = `${page}|${perPage}|${params.status ?? ""}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex gap-1 rounded-lg border bg-muted/50 p-1">
          {STATUS_TABS.map((s) => (
            <Link
              key={s}
              href={`/rewards?tab=challenges&status=${s}`}
              className={cn(
                "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
                (params.status || "all") === s
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s}
              <LinkPending size={13} />
            </Link>
          ))}
        </div>
        <CreateChallengeButton />
      </div>

      <Suspense
        key={suspenseKey}
        fallback={
          <>
            <TableSkeleton rows={12} columns={7} />
            <PaginationSkeleton />
          </>
        }
      >
        <ChallengesContent page={page} perPage={perPage} status={status} />
      </Suspense>
    </div>
  );
}

async function ChallengesContent({
  page,
  perPage,
  status,
}: {
  page: number;
  perPage: number;
  status?: ChallengeStatus;
}) {
  const offset = (page - 1) * perPage;

  // The list comes from the website backend admin API over HTTP. Wrap it in
  // safeQuery (12s wall-clock bound) so a backend blip / timeout degrades to
  // an empty table + a visible band — tabs and pagination keep rendering —
  // instead of throwing the whole page into the segment error boundary.
  const EMPTY: {
    data: Challenge[];
    total: number;
    offset: number;
    limit: number;
  } = { data: [], total: 0, offset, limit: perPage };
  const listResult = await safeQuery(
    () => challengesApi.list({ status, offset, limit: perPage }),
    EMPTY,
    "challenges.list",
    12_000,
  );
  const result = listResult.data;
  const listFailed = listResult.error !== null;

  const totalPages = Math.max(1, Math.ceil(result.total / perPage));

  return (
    <>
      {listFailed && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
        >
          <AlertTriangle
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-amber-500"
          />
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Couldn&apos;t load challenges — the backend request timed out or
            failed. This is a{" "}
            <span className="font-medium">request error, not zero results</span>
            . Refresh to retry.
          </p>
        </div>
      )}

      <FadeIn>
        <ChallengesTable data={result.data} />
      </FadeIn>

      <DataTablePagination
        page={page}
        totalPages={totalPages}
        total={result.total}
        perPage={perPage}
        degraded={listFailed}
      />
    </>
  );
}
