import { redirect } from "next/navigation";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readDbEnvFromCookie } from "@/lib/db-env";
import { requirePageAccess } from "@/lib/dal";
import { CreatorTestingShell } from "./_components/creator-testing-shell";

const PAGE_KEY = "/test/creator";

/**
 * Creator-side testing tools. The page itself is gated on:
 *   1. Page-permission ACL (handled by requirePageAccess)
 *   2. The admin's main-DB cookie pointing at the dev environment.
 *
 * Without the dev-env cookie we redirect to /dashboard rather than
 * render an empty shell — the user explicitly switched to prod and
 * the testing actions would fail anyway (server actions enforce the
 * same gate, and the backend rejects unless ENABLE_TESTING_ENDPOINTS
 * is set on that deployment).
 */
export default async function CreatorTestingPage() {
  await requirePageAccess(PAGE_KEY);
  const dbEnv = await readDbEnvFromCookie();
  if (dbEnv !== "dev") {
    redirect("/dashboard");
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Creator Testing Tools</CardTitle>
          <CardDescription>
            Drive the creator-deal and leaderboard pipelines end-to-end without waiting on
            real users. Available only while connected to the dev environment.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <ul className="list-disc pl-5 space-y-1">
            <li>Promote/demote test creators on the fly.</li>
            <li>Override a user&apos;s active affiliate code to redirect their wagers.</li>
            <li>Spin up a 10-tier approved leaderboard in one click.</li>
            <li>Inject synthetic wager volume so a leaderboard can be ranked without real bets.</li>
            <li>Force-end or manually convert active stream sessions.</li>
          </ul>
        </CardContent>
      </Card>

      <CreatorTestingShell />
    </div>
  );
}
