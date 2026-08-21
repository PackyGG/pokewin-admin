import { CheckCircle2, Globe2, RadioTower, Users } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  getEosTestConfig,
  listEosUserConfigs,
} from "@/lib/antifraud/eos-test-config-api";
import { readDbEnvFromCookie } from "@/lib/db-env";
import { requireEosTestAccess } from "@/lib/eos-test-access";
import { EosTestConfigCard } from "./eos-test-config-card";
import { EosUserSequences } from "./eos-user-sequences";

export const metadata = { title: "EOS Battle Testing" };

export default async function EosPage() {
  await requireEosTestAccess();
  const environment = await readDbEnvFromCookie();
  const [config, userConfigs] = await Promise.all([
    getEosTestConfig(environment),
    listEosUserConfigs(environment),
  ]);
  const environmentLabel = environment === "prod"
    ? "Normal · production"
    : "Development";

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
              {environmentLabel} controls
            </Badge>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border bg-card px-4 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-2 font-medium text-foreground">
          <CheckCircle2 className="size-4 text-emerald-500" />Control service connected
        </span>
        <span>{userConfigs.length} personal {userConfigs.length === 1 ? "flow" : "flows"}</span>
        <span>Follows the dashboard&apos;s {environmentLabel.toLowerCase()} data toggle</span>
        <span>Multiplier ranges use creator payout ÷ creator cost</span>
        {config.forceAllLosses && (
          <Badge variant="destructive">All-battles loss override active</Badge>
        )}
      </div>
      <Tabs defaultValue="global" className="gap-4">
        <TabsList className="h-10 w-full justify-start sm:w-fit">
          <TabsTrigger value="users" className="px-4">
            <Users className="size-4" />Per-user flows
          </TabsTrigger>
          <TabsTrigger value="global" className="px-4">
            <Globe2 className="size-4" />Global controls
          </TabsTrigger>
        </TabsList>
        <TabsContent value="users">
          <EosUserSequences
            environment={environment}
            initial={userConfigs}
            forceAllLosses={config.forceAllLosses}
          />
        </TabsContent>
        <TabsContent value="global">
          <EosTestConfigCard initial={config} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
