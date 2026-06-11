import { requireInsightsOwner } from "@/lib/insights/motha-gate";

/**
 * Layout gate for the entire Insights tree (/insights/**).
 * Non-motha admins are redirected to /dashboard even if they know the URL.
 */
export default async function InsightsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireInsightsOwner();
  return children;
}
