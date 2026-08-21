import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { eosPlayerIntelligenceInputSchema } from "../../src/lib/eos-player-intelligence-shared";

const repoRoot = process.cwd();
const querySource = fs.readFileSync(
  path.join(repoRoot, "src/lib/queries/eos-player-intelligence.ts"),
  "utf8",
);
const actionSource = fs.readFileSync(
  path.join(repoRoot, "src/app/(admin)/eos/actions.ts"),
  "utf8",
);

test("EOS creator intelligence is bounded, environment routed, and currency separated", () => {
  assert.match(querySource, /environment === "prod"[\s\S]*getProdReadDrizzleDb\(\)/);
  assert.match(querySource, /getBattleTestDevReadDrizzleDb\(\)/);
  assert.match(querySource, /b\.status = 'completed'/);
  assert.match(querySource, /b\.created_at >= now\(\) - \(\$1::int \* interval '1 hour'\)/);
  assert.match(querySource, /b\.currency::text = \$2/);
  assert.match(querySource, /bp\.user_id = b\.user_id/);
  assert.match(querySource, /bp\.bot_id IS NULL/);
  assert.match(querySource, /estimated_net_pnl DESC/);
  assert.match(querySource, /LIMIT \$5/);
  assert.doesNotMatch(querySource, /currency.*(?:both|all)/i);
});

test("EOS creator intelligence filters are closed and access gated", () => {
  assert.deepEqual(
    eosPlayerIntelligenceInputSchema.parse({}),
    {
      period: "7d",
      currency: "real",
      sort: "profit",
      minBattles: 5,
      minBattleValue: 0,
      limit: 50,
    },
  );
  assert.throws(() => eosPlayerIntelligenceInputSchema.parse({ period: "90d" }));
  assert.throws(() => eosPlayerIntelligenceInputSchema.parse({ currency: "all" }));
  assert.throws(() => eosPlayerIntelligenceInputSchema.parse({ sort: "raw_sql" }));
  assert.match(
    actionSource,
    /loadEosPlayerIntelligence[\s\S]*requireEosTestAccess\(\)[\s\S]*readDbEnvFromCookie\(\)/,
  );
});
