import { RadioTower } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import {
  getEosTestConfig,
  listEosUserConfigs,
} from "@/lib/antifraud/eos-test-config-api";
import { requireEosTestAccess } from "@/lib/eos-test-access";
import { EosTestConfigCard } from "./eos-test-config-card";
import { EosUserSequences } from "./eos-user-sequences";

export const metadata = { title: "EOS Battle Testing" };

export default async function EosPage() {
  await requireEosTestAccess();
  const [config, userConfigs] = await Promise.all([
    getEosTestConfig(),
    listEosUserConfigs(),
  ]);
  if (userConfigs.some((entry) => entry.environment !== config.environment)) {
    throw new Error("EOS configuration service returned mixed environments");
  }

  return (
    <div className="space-y-5">
      <SectionHeading
        icon={RadioTower}
        title={
          <>
            EOS battle testing
            <Badge variant="outline" className="text-[10px] uppercase">
              Private
            </Badge>
            <Badge variant="secondary" className="text-[10px] uppercase">
              {config.environment} controls
            </Badge>
          </>
        }
      />
      <EosTestConfigCard initial={config} />
      <EosUserSequences
        environment={config.environment}
        initial={userConfigs}
      />
    </div>
  );
}
