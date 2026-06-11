import { requireInsightsOwner } from "@/lib/insights/motha-gate";

/**
 * GGR lives under the Insights sidebar group but outside /insights/**.
 * Same motha-only gate as the insights layout.
 */
export default async function GgrLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireInsightsOwner();
  return children;
}
