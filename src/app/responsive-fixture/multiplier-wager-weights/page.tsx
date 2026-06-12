import { notFound } from "next/navigation";
import { MultiplierWagerWeightsFixtureClient } from "./fixture-client";

/**
 * DEV-ONLY rendering fixture for the /security Multiplier Wager Weights
 * card (same harness pattern as responsive-fixture/crypto-fees).
 *
 * The live card sits on /security behind requirePageAccess + the ADMIN DB
 * session — neither is available on env-less checkouts, and the backend
 * multiplier-wager-weights branch isn't deployed yet, so the live route can
 * only show the degraded state. This fixture renders the ACTUAL
 * <MultiplierWagerWeightsCard> (production component, production types)
 * twice: once with a static, representative config (both Switch states,
 * default + custom + empty tier lists) and once with `initial={null}` (the
 * "awaiting backend deploy" state that production will actually show until
 * the backend ships).
 *
 * Returns 404 in production (`NODE_ENV === "production"`), so it can never
 * be reached by a real admin. Lives OUTSIDE the (admin) route group so it
 * doesn't require a page-access grant or the full shell.
 */

export const dynamic = "force-dynamic";

export default function ResponsiveMultiplierWagerWeightsFixture() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  // Mirror the admin shell's scrollable content region padding so the card
  // is measured in the same horizontal space it occupies in production.
  return (
    <div className="min-h-screen bg-background">
      <div className="min-w-0 p-3 sm:p-4 md:p-6">
        <MultiplierWagerWeightsFixtureClient />
      </div>
    </div>
  );
}
