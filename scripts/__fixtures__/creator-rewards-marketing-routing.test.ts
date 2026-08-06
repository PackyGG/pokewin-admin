import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("Creator Rewards lives only in the Marketing workspace", () => {
  assert.equal(
    existsSync("src/app/(admin)/creator-rewards/page.tsx"),
    false,
    "the normal admin route must stay removed",
  );

  const nav = source("src/lib/nav-config.ts");
  assert.doesNotMatch(nav, /nav\.creator-rewards|href:\s*"\/creator-rewards"/);

  const hubPage = source(
    "src/app/(creator-hub)/creator-hub/rewards/page.tsx",
  );
  assert.match(hubPage, /from "\.\/content"/);
  assert.match(hubPage, /requireCreatorHubPageAccess\(\)/);
  assert.match(hubPage, /requirePageAccess\("\/creator-rewards"\)/);

  const actions = source(
    "src/app/(creator-hub)/creator-hub/rewards/actions.ts",
  );
  for (const action of [
    "createCreatorRewardProgram",
    "setCreatorRewardProgramActive",
    "approveCreatorRewardClaim",
    "rejectCreatorRewardClaim",
    "reinstateCreatorRewardClaim",
    "raiseCreatorRewardClaimForUser",
    "previewCreatorRewardEntitlement",
    "resendClaimDecisionNotice",
    "testBotWebhookConnection",
    "searchCreatorsWithCodes",
    // Program lifecycle (2026-08-06). Edit and removal move money terms and
    // retire live agreements, so they are gated exactly like the rest.
    "updateCreatorRewardProgram",
    "planCreatorRewardProgramRemoval",
    "removeCreatorRewardProgram",
    "restoreCreatorRewardProgram",
  ]) {
    assert.match(actions, new RegExp(`export async function ${action}\\b`));
  }
  assert.equal(
    actions.match(/await requireAdmin\(\)/g)?.length,
    14,
    "every mutation/search action must retain its admin gate",
  );
  assert.equal(
    actions.match(/await requirePageAccess\("\/creator-rewards"\)/g)?.length,
    14,
    "every mutation/search action must retain its page permission gate",
  );
  assert.match(actions, /revalidatePath\("\/creator-hub\/rewards"\)/);
  assert.doesNotMatch(actions, /revalidatePath\("\/creator-rewards"\)/);

  const middleware = source("src/middleware.ts");
  assert.match(middleware, /pathname === "\/creator-rewards"/);
  assert.match(middleware, /creatorHub\.host\}\/rewards/);
  assert.match(middleware, /url\.search = request\.nextUrl\.search/);
});
