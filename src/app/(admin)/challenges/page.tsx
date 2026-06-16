import { Suspense } from "react";
import Link from "next/link";
import { Target, AlertTriangle } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
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
import { CreateChallengeButton } from "./create-challenge-button";
import { ChallengesTable } from "./challenges-table";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Challenges" };

const STATUS_TABS = ["all", "active", "inactive", "archived"] as const;

function normalizeStatus(raw?: string): ChallengeStatus | undefined {
  if (raw === "active" || raw === "inactive" || raw === "archived") return raw;
  return undefined;
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
  // safeQuery (12s wall-clock bound, matching the upgrader catalog backend
  // call) so a backend blip / timeout degrades to an empty table + a visible
  // band — tabs and pagination keep rendering — instead of throwing the whole
  // page into the segment error boundary. Mirrors the upgrader Transactions
  // tab's degrade-not-crash handling.
  const EMPTY: { data: Challenge[]; total: number; offset: number; limit: number } =
    { data: [], total: 0, offset, limit: perPage };
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

export default async function ChallengesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/challenges");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const status = normalizeStatus(params.status);

  const suspenseKey = `${page}|${perPage}|${params.status ?? ""}`;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Target}
          title="Challenges"
          subtitle="Game challenges — reward players for hitting a target card or upgrader outcome."
          action={<CreateChallengeButton />}
        />
      </PageHero>

      <div className="space-y-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {STATUS_TABS.map((s) => (
            <Link
              key={s}
              href={`/challenges?status=${s}`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
                (params.status || "all") === s
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s}
            </Link>
          ))}
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
    </div>
  );
}
