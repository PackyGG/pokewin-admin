"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import type { MultiplierDealResponse } from "@/lib/backend-api";

import { MultiplierDealFormDialog } from "../../_components/multiplier-review/deal-form-dialog";
import { MultiplierDealsList } from "./multiplier-deals-list";

type Props = {
  userId: string;
  fillCount: number;
  multiplierCount: number;
  fillPanel: React.ReactNode;
  multiplierDeals: MultiplierDealResponse[];
};

/**
 * Sub-tab host inside the outer DealTabs "Deals" panel. Splits creator
 * deals by kind:
 *
 *   - Fill       — existing weekly-fill deals (unchanged rendering)
 *   - Multiplier — new single-shot deposit×multiplier deals
 *
 * Counts are shown in the trigger labels so admin sees at a glance which
 * surface has activity. State is local (no URL persistence per user
 * decision — admin doesn't need deep-link to a specific sub-tab).
 *
 * The "+ New Multiplier Deal" action lives inside the multiplier sub-tab
 * header rather than at the outer card level so it doesn't appear while
 * viewing fill deals.
 */
export function DealsSubTabs({
  userId,
  fillCount,
  multiplierCount,
  fillPanel,
  multiplierDeals,
}: Props) {
  const [tab, setTab] = useState<"fill" | "multiplier">("fill");

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as "fill" | "multiplier")}
      className="gap-0"
    >
      <div className="flex items-center justify-between border-b px-4 py-2">
        <TabsList variant="line">
          <TabsTrigger value="fill">
            Fill
            <span className="ml-1 text-muted-foreground">
              ({fillCount})
            </span>
          </TabsTrigger>
          <TabsTrigger value="multiplier">
            Multiplier
            <span className="ml-1 text-muted-foreground">
              ({multiplierCount})
            </span>
          </TabsTrigger>
        </TabsList>
        {tab === "multiplier" && (
          <MultiplierDealFormDialog
            userId={userId}
            trigger={
              <>
                <Plus className="mr-1.5 size-3.5" />
                New Multiplier Deal
              </>
            }
          />
        )}
      </div>
      <TabsContent value="fill" keepMounted>
        {fillPanel}
      </TabsContent>
      <TabsContent value="multiplier" keepMounted>
        <MultiplierDealsList userId={userId} deals={multiplierDeals} />
      </TabsContent>
    </Tabs>
  );
}
