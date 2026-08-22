import { Suspense } from "react";
import { RadioTower } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import {
  getEosTestConfig,
  getEosTestOverview,
  listEosUserConfigs,
} from "@/lib/antifraud/eos-test-config-api";
import { readDbEnvFromCookie, type DbEnv } from "@/lib/db-env";
import { requireEosTestAccess } from "@/lib/eos-test-access";
import { logError } from "@/lib/errors/logger";
import { EosOverview } from "./eos-overview";
import { EosWorkspace } from "./eos-workspace";

export const metadata = { title: "EOS Outcome Controls" };

async function EosOverviewSection({ environment }: { environment: DbEnv }) {
  const overview = await getEosTestOverview(environment).catch((error) => {
    logError("eos.overview", "EOS control overview failed", error);
    return null;
  });
  return <EosOverview overview={overview} />;
}

export default async function EosPage() {
  await requireEosTestAccess();
  const environment = await readDbEnvFromCookie();
  const [config, userConfigs] = await Promise.all([
    getEosTestConfig(environment),
    listEosUserConfigs(environment),
  ]);

  return (
    <div className="space-y-6">
      <SectionHeading
        icon={RadioTower}
        title="EOS outcome controls"
      />
      <EosWorkspace
        environment={environment}
        config={config}
        userConfigs={userConfigs}
        overview={(
          <Suspense
            fallback={(
              <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
                Loading EOS impact overview…
              </div>
            )}
          >
            <EosOverviewSection environment={environment} />
          </Suspense>
        )}
      />
    </div>
  );
}
