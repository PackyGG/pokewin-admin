import { notFound } from "next/navigation";

import { RetuneReviewCardFixtureClient } from "./fixture-client";

/**
 * DEV-ONLY rendering fixture for the redesigned Pack-Studio retune review card.
 *
 * The real `/pack-studio/retune` surface is owner + 2FA gated and its proposals
 * come from `planAllRetunes`, a batched read against the MAIN game DB — so it
 * cannot render in a logged-out / no-DB environment. This route renders the
 * ACTUAL `ReviewCard` component (the file the redesign touches) with a static,
 * representative tagged "1% 18 PLUS" proposal so the redesign can be eyeballed /
 * screenshotted without minting an owner session or touching MAIN.
 *
 * Returns 404 in production so a real admin can never reach it. Lives OUTSIDE
 * the (admin)/(pack-studio) route groups so it needs no page-access grant.
 */

export const dynamic = "force-dynamic";

export default function RetuneReviewCardFixture() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto min-w-0 max-w-3xl p-3 sm:p-4 md:p-6">
        <RetuneReviewCardFixtureClient />
      </div>
    </div>
  );
}
