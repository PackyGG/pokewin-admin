import { Suspense } from "react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { canManageAntifraud } from "@/lib/antifraud/access";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { parsePage, parsePerPage } from "@/lib/utils/pagination";
import { FiatDepositReviewQueue } from "./credit-review-page";
import { FiatDepositReviewsSkeleton } from "./review-queue-skeleton";

export const metadata = { title: "Fiat Deposit Reviews" };

type SearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Shell for the Fiat deposit review queue.
 *
 * The page body does the CHEAP work only — the access gate and the
 * `?page` / `?perPage` parse — then paints immediately. Every read the queue
 * needs (the monitor list, the admin-DB decision states, the player lookup)
 * lives in the async child behind `<Suspense>`, keyed on the paging pair so a
 * page change swaps the boundary instead of re-using stale rows.
 *
 * `loading.tsx` renders the same skeleton around the same shell, so the
 * route-level and boundary-level fallbacks are pixel-identical.
 */
export default async function FiatDepositReviewsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireAntifraudPageAccess();
  const canManageKyc = canManageAntifraud(session);
  const raw = await searchParams;
  const page = parsePage(firstValue(raw.page));
  const perPage = Math.min(parsePerPage(firstValue(raw.perPage)), 100);

  return (
    <>
      <PageHero>
        <PageHeroIdentity />
      </PageHero>
      <div className="space-y-3">
        <Suspense
          key={`${page}-${perPage}`}
          fallback={<FiatDepositReviewsSkeleton />}
        >
          <FiatDepositReviewQueue
            page={page}
            perPage={perPage}
            canManageKyc={canManageKyc}
          />
        </Suspense>
      </div>
    </>
  );
}
