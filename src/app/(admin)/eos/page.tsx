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
          </>
        }
      />
      <EosTestConfigCard initial={config} />
      <EosUserSequences initial={userConfigs} />
    </div>
  );
}
