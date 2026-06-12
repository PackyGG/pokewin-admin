import { notFound } from "next/navigation";
import { CryptoFeesFixtureClient } from "./fixture-client";

/**
 * DEV-ONLY rendering fixture for the /security Crypto Exchange-Rate Fees
 * card (same harness pattern as responsive-fixture/edge-plan-2).
 *
 * The live card sits on /security behind requirePageAccess + the ADMIN DB
 * session — neither is available on env-less checkouts, and the backend
 * crypto-fees branch isn't deployed yet, so the live route can only show
 * the degraded state. This fixture renders the ACTUAL <CryptoFeesCard>
 * (production component, production types) twice: once with a static,
 * representative config (both Switch states + non-default % values) and
 * once with `initial={null}` (the "awaiting backend deploy" state that
 * production will actually show until the backend ships).
 *
 * Returns 404 in production (`NODE_ENV === "production"`), so it can never
 * be reached by a real admin. Lives OUTSIDE the (admin) route group so it
 * doesn't require a page-access grant or the full shell.
 */

export const dynamic = "force-dynamic";

export default function ResponsiveCryptoFeesFixture() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  // Mirror the admin shell's scrollable content region padding so the card
  // is measured in the same horizontal space it occupies in production.
  return (
    <div className="min-h-screen bg-background">
      <div className="min-w-0 p-3 sm:p-4 md:p-6">
        <CryptoFeesFixtureClient />
      </div>
    </div>
  );
}
