import { Suspense } from "react";
import { Ticket } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import { TableSkeleton } from "@/components/loading-skeletons";
import { normalizeQuery } from "@/lib/queries/affiliate-codes-lookup";
import { AffiliateCodeSearchForm } from "./search-form";
import { ResultsSection } from "./results-section";

export const metadata = { title: "Affiliate Codes" };

/**
 * /insights/affiliate-codes — read-only affiliate-code lookup.
 *
 * Search an affiliate code (exact) or its owner (username/email exact +
 * username prefix), then see the owner, what they MADE
 * (affiliate_accounts.total_earned_usd), what they can CLAIM now
 * (available_usd), and context (paid out, referred, downstream wager,
 * created_at). Each code has a lazy recent-referrals drawer and an
 * audited "Manage" dialog (zero claimable balance / transfer to @motha).
 *
 * Backend rules:
 *   - Every read is index-served on MAIN (read-only): exact code →
 *     affiliate_codes_code_unique; owner username/email → unique indexes;
 *     username prefix → idx_user_lower_username_prefix; per-user account /
 *     usages → PK / (affiliate_user_id,…) index. See
 *     `src/lib/queries/affiliate-codes-lookup.ts` for the EXPLAIN-proven map.
 *   - Shell-first: this page paints the hero + search box instantly; the
 *     results stream behind a <Suspense> keyed on `q` (matching loading.tsx).
 *   - Search is server-driven (?q=), not a client full-table load.
 *
 * The whole /insights tree is owner-gated by the layout
 * (requireInsightsOwner); this page additionally gates on its own page key.
 */
export default async function AffiliateCodesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/affiliate-codes");
  const params = await searchParams;
  const query = normalizeQuery(params.q);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4">
          <PageHeroIdentity
            icon={Ticket}
            accent="rose"
            title="Affiliate Codes"
            subtitle="Look up an affiliate code or its owner — earnings, claimable balance, referrals."
          />
          <AffiliateCodeSearchForm />
        </div>
      </PageHero>

      <section className="space-y-3">
        <SectionHeading icon={Ticket} title="Results" />
        {/* Keyed on the query so a new search re-suspends to the skeleton
            instead of stalling on the previous result set. */}
        <Suspense key={query} fallback={<TableSkeleton rows={4} />}>
          <ResultsSection query={query} />
        </Suspense>
      </section>
    </div>
  );
}
