import { Suspense } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Hash, AlertTriangle } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { safeQuery } from "@/lib/errors/safe-query";
import { FadeIn } from "@/components/fade-in";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { getRecentCompletedBattles } from "@/lib/queries/eos-verification";
import { BattleRow } from "./battle-row";

export const metadata = { title: "EOS Verification" };

const EOS_VERIFICATION_PATH = "/system/eos-verification";
const PER_PAGE = 5;
const LIST_TIMEOUT_MS = 15_000;

/**
 * System → EOS Verification.
 *
 * Latest completed battles, 5/page, each row collapsible. Expanding a row
 * fetches (on-demand, via a Server Action) every participant in that battle
 * plus a live cross-check of the battle's stored `eos_block_hash` against
 * all 13 public EOS RPC providers — see actions.ts / lib/eos/verify.ts.
 *
 * Shell-first: the hero paints immediately; the battle list fetch lives in
 * its own Suspense leg below (see loading.tsx for the matching skeleton).
 */
export default async function EosVerificationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess(EOS_VERIFICATION_PATH);

  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? "1") || 1);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Hash}
          accent="cyan"
          title="EOS Verification"
          subtitle="Latest completed battles, cross-checked against the EOS blockchain"
        />
      </PageHero>

      <Suspense key={page} fallback={<EosVerificationSkeleton />}>
        <BattleListSection page={page} />
      </Suspense>
    </div>
  );
}

async function BattleListSection({ page }: { page: number }) {
  const EMPTY: Awaited<ReturnType<typeof getRecentCompletedBattles>> = {
    items: [],
    total: 0,
  };
  const result = await safeQuery(
    () => getRecentCompletedBattles({ page, perPage: PER_PAGE }),
    EMPTY,
    "eos-verification.list",
    LIST_TIMEOUT_MS,
  );
  const { items, total } = result.data;
  const listFailed = result.error !== null;

  return (
    <FadeIn className="space-y-6">
      <div className="space-y-3">
        <SectionHeading icon={Hash} title="Completed battles" />

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
              Couldn&apos;t load the battle list — the query timed out or
              failed. Refresh to retry.
            </p>
          </div>
        )}

        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground">
            <Hash className="size-6" />
            <span className="text-sm">No completed battles yet.</span>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((battle) => (
              <BattleRow key={battle.id} battle={battle} />
            ))}
          </div>
        )}

        {total > 0 && (
          <PaginationFooter page={page} perPage={PER_PAGE} total={total} />
        )}
      </div>
    </FadeIn>
  );
}

function PaginationFooter({
  page,
  perPage,
  total,
}: {
  page: number;
  perPage: number;
  total: number;
}) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  const linkFor = (targetPage: number) => {
    const params = new URLSearchParams();
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `${EOS_VERIFICATION_PATH}?${qs}` : EOS_VERIFICATION_PATH;
  };

  return (
    <div className="flex items-center justify-between border-t pt-3">
      <span className="text-xs text-muted-foreground">
        Page {page} of {totalPages} · {total} completed battles
      </span>
      <div className="flex items-center gap-2">
        {hasPrev ? (
          <Link
            href={linkFor(page - 1)}
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
            href={linkFor(page + 1)}
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

function EosVerificationSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-40 rounded" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
