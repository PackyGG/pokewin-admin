"use client";

import { useState, useTransition } from "react";
import { CircleDollarSign, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { EosTestConfig } from "@/lib/antifraud/eos-test-config-api";
import { setUserOnlyLoses } from "./actions";

export function EosTestConfigCard({ initial }: { initial: EosTestConfig }) {
  const [enabled, setEnabled] = useState(initial.userOnlyLoses);
  const [isPending, startTransition] = useTransition();

  function update(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    startTransition(async () => {
      try {
        const saved = await setUserOnlyLoses(next);
        setEnabled(saved.userOnlyLoses);
        toast.success(
          saved.userOnlyLoses
            ? "Creator-loss selection enabled"
            : "Random EOS selection restored",
        );
      } catch (error) {
        setEnabled(previous);
        toast.error(
          error instanceof Error ? error.message : "EOS setting update failed",
        );
      }
    });
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CircleDollarSign className="size-4 text-primary" />
          Battle outcome selection
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-6 rounded-lg border p-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              User only loses
              {isPending && <Loader2 className="size-3.5 animate-spin" />}
            </div>
            <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
              When enabled, the testing API selects a creator-loss result from
              the latest five EOS blocks. If all five are profitable, it selects
              the result with the lowest creator profit.
            </p>
          </div>
          <Switch
            aria-label="User only loses"
            checked={enabled}
            disabled={isPending}
            onCheckedChange={update}
          />
        </div>

        <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          This setting affects only the unauthenticated dev battle-testing
          endpoint and never settles or modifies a battle.
        </div>
      </CardContent>
    </Card>
  );
}
