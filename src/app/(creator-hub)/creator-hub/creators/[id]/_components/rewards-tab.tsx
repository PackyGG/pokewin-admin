import { AlertTriangle, CheckCircle2, Crown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";

import { getCreatorRewardsDetail } from "../_queries/creator-rewards-data";
import { NewRewardsProgramDialog } from "./new-rewards-program-dialog";

export async function CreatorRewardsTab({ userId }: { userId: string }) {
  const { data, error } = await safeQueryOrNull(
    () => getCreatorRewardsDetail(userId),
    "creator-hub.creator.rewards",
    15_000,
  );

  if (!data) {
    return (
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-4" />
          {error ? "Creator rewards could not be loaded. Refresh to retry." : "No reward data."}
        </div>
      </Card>
    );
  }

  const programName = new Map(
    data.programs.map((program) => [program.id, program.name]),
  );

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Crown className="size-4 text-pink-500" />
            <h2 className="font-semibold">Reward programs</h2>
          </div>
          <NewRewardsProgramDialog userId={userId} />
        </div>
        {data.programs.length === 0 ? (
          <EmptyCard text="No creator reward program has been created for this creator." />
        ) : (
          <div className="space-y-3">
            {data.programs.map((program) => (
              <Card key={program.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium">{program.name}</h3>
                      <Badge variant="outline">
                        {program.endsAt && new Date(program.endsAt).getTime() <= Date.now()
                          ? "Ended"
                          : new Date(program.accrualStartAt).getTime() > Date.now()
                            ? "Scheduled"
                            : program.isActive
                              ? "Active"
                              : "Paused"}
                      </Badge>
                    </div>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {program.codes.join(", ") || "No codes"}
                    </p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>Starts {formatDateTime(program.accrualStartAt)}</div>
                    {program.endsAt && <div>Ends {formatDateTime(program.endsAt)}</div>}
                    <div>Updated {formatDateTime(program.updatedAt)}</div>
                  </div>
                </div>

                <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  {program.thresholdUsd != null && program.rewardUsd != null && (
                    <Info label="Wager milestone" value={`${formatCurrency(program.thresholdUsd)} → ${formatCurrency(program.rewardUsd)}`} />
                  )}
                  {program.vipRewardUsd != null && (
                    <Info label="VIP reward" value={formatCurrency(program.vipRewardUsd)} />
                  )}
                  {program.lossbackPct != null && program.minDepositUsd != null && (
                    <Info label="First-deposit lossback" value={`${program.lossbackPct}% from ${formatCurrency(program.minDepositUsd)}`} />
                  )}
                  <Info label="Per-user cap" value={program.maxRewardPerUserUsd == null ? "No cap" : formatCurrency(program.maxRewardPerUserUsd)} />
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
                  <span>{program.stats.pending} pending</span>
                  <span>{program.stats.approved} approved</span>
                  <span>{program.stats.rejected} rejected</span>
                  <span className="text-rose-600 dark:text-rose-400">
                    {formatCurrency(program.stats.paidUsd)} paid
                  </span>
                  {program.sourceRequestId && (
                    <span className="font-mono">Source {program.sourceRequestId}</span>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-4 text-pink-500" />
          <h2 className="font-semibold">Claims</h2>
          <span className="text-xs text-muted-foreground">Latest 200</span>
        </div>
        {data.claims.length === 0 ? (
          <EmptyCard text="No reward claims have been filed under this creator's programs." />
        ) : (
          <Card className="divide-y overflow-hidden">
            {data.claims.map((claim) => (
              <div key={claim.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div>
                  <div className="font-medium">
                    {programName.get(claim.programId) ?? claim.programId}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Player {claim.userId} · {claim.leg === "ftd_lossback" ? "First-deposit lossback" : "Wager milestone"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-medium text-rose-600 dark:text-rose-400">
                    {formatCurrency(claim.amountUsd)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {claim.status} · {formatDateTime(claim.requestedAt)}
                  </div>
                  {claim.reviewedAt && (
                    <div className="text-xs text-muted-foreground">
                      Reviewed {formatDateTime(claim.reviewedAt)}
                    </div>
                  )}
                  {claim.reviewNote && <div className="text-xs">{claim.reviewNote}</div>}
                  {claim.ledgerTxId && <div className="font-mono text-[10px] text-muted-foreground">Ledger {claim.ledgerTxId}</div>}
                  {claim.botNotifyError && <div className="text-xs text-rose-600 dark:text-rose-400">Discord: {claim.botNotifyError}</div>}
                </div>
              </div>
            ))}
          </Card>
        )}
      </section>

    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium">{value}</div>
    </div>
  );
}

function EmptyCard({ text }: { text: string }) {
  return <Card className="p-5 text-sm text-muted-foreground">{text}</Card>;
}
