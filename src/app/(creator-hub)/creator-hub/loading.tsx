import { HubDashboardSkeleton } from "./_components/hub-dashboard-skeleton";

/**
 * Route-level loading skeleton for the Creator Hub dashboard. Renders the
 * ONE shared skeleton (`_components/hub-dashboard-skeleton.tsx`) that also
 * feeds the in-page Suspense fallbacks, so the loading state always mirrors
 * the real band structure (Overview, Trends, Top Creators,
 * Deal performance).
 */
export default function CreatorHubDashboardLoading() {
  return <HubDashboardSkeleton />;
}
