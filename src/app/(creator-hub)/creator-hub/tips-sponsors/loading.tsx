import { TipsSponsorsSkeleton } from "./_components/tips-sponsors-skeleton";

/**
 * Route-level loading state — renders the SAME skeleton module the page's
 * Suspense fallbacks compose, so the placeholder always mirrors the real
 * section structure (headline strip → reconciliation → chart → ranklist).
 */
export default function TipsSponsorsLoading() {
  return <TipsSponsorsSkeleton />;
}
