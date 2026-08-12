import { AlertTriangle, Clock3, ScrollText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatDateTime } from "@/lib/utils/format";

import { getCreatorAuditDetail } from "../_queries/creator-audit-data";
import { CreatorApprovalRetryButton } from "./creator-approval-retry-button";

export async function CreatorAuditTab({
  userId,
  canViewProtectedActors,
}: {
  userId: string;
  canViewProtectedActors: boolean;
}) {
  const { data, error } = await safeQueryOrNull(
    () => getCreatorAuditDetail(userId, canViewProtectedActors),
    "creator-hub.creator.audit",
    15_000,
  );

  if (!data) {
    return (
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-4" />
          {error ? "Creator audit history could not be loaded. Refresh to retry." : "No audit data."}
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Clock3 className="size-4 text-pink-500" />
          <h2 className="font-semibold">Deal approval requests</h2>
        </div>
        {data.approvalRequests.length === 0 ? (
          <EmptyCard text="No Discord deal approval has been submitted for this creator." />
        ) : (
          <div className="space-y-3">
            {data.approvalRequests.map((request) => (
              <Card key={request.id} className="space-y-2 p-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{humanizeEvent(request.status)}</Badge>
                      <span>Terms v{request.agreementVersion}</span>
                      {request.hasRewardProgram && <span>· rewards included</span>}
                    </div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">{request.id}</div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>Submitted {formatDateTime(request.createdAt)}</div>
                    <div>Updated {formatDateTime(request.updatedAt)}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>Delivery attempts {request.deliveryAttemptCount}</span>
                  <span>Provision attempts {request.provisioningAttemptCount}</span>
                  {request.continuedAt && <span>Continued {formatDateTime(request.continuedAt)}</span>}
                  {request.approvedAt && <span>Approved {formatDateTime(request.approvedAt)}</span>}
                  {request.declinedAt && <span>Declined {formatDateTime(request.declinedAt)}</span>}
                  {request.completedAt && <span>Completed {formatDateTime(request.completedAt)}</span>}
                </div>
                {(request.backendDealIds.length > 0 || request.pnlDealId || request.rewardProgramId) && (
                  <div className="space-y-1 font-mono text-xs text-muted-foreground">
                    <div>Type {humanizeEvent(request.requestKind)}</div>
                    {request.backendDealIds.map((dealId, index) => (
                      <div key={dealId}>
                        Deal{request.backendDealIds.length > 1 ? ` period ${index + 1}/${request.backendDealIds.length}` : ""}{" "}
                        {dealId}
                      </div>
                    ))}
                    {request.pnlDealId && <div>PnL deal {request.pnlDealId}</div>}
                    {request.rewardProgramId && <div>Reward {request.rewardProgramId}</div>}
                  </div>
                )}
                {request.lastErrorMessage && (
                  <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-700 dark:text-rose-300">
                    {request.lastErrorStep ?? "Error"} · {request.lastErrorCode ?? "unknown"}: {request.lastErrorMessage}
                  </div>
                )}
                {["delivery_failed", "awaiting_continue", "awaiting_decision"].includes(request.status) && (
                  <CreatorApprovalRetryButton
                    creatorUserId={userId}
                    requestId={request.id}
                    step="delivery"
                    resend={request.status !== "delivery_failed"}
                  />
                )}
                {request.status === "provisioning_failed" && (
                  <CreatorApprovalRetryButton
                    creatorUserId={userId}
                    requestId={request.id}
                    step="provisioning"
                  />
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <ScrollText className="size-4 text-pink-500" />
          <h2 className="font-semibold">Program, approval, and payment log</h2>
          <span className="text-xs text-muted-foreground">Latest 200</span>
        </div>
        {data.approvalEvents.length === 0 && data.creatorAuditEvents.length === 0 ? (
          <EmptyCard text="No creator-program, PnL-payment, or approval events have been recorded." />
        ) : (
          <Card className="divide-y overflow-hidden">
            {[
              ...data.approvalEvents.map((event) => ({
                id: event.id,
                eventType: event.eventType,
                createdAt: event.createdAt,
                metadata: event.metadata,
                context: `${event.actorKind} · request ${event.requestId}`,
              })),
              ...data.creatorAuditEvents.map((event) => ({
                id: event.id,
                eventType: event.eventType,
                createdAt: event.createdAt,
                metadata: event.metadata,
                context: event.actorUsername
                  ? `admin ${event.actorUsername}`
                  : event.actorAdminUserId
                    ? `admin ${event.actorAdminUserId}`
                    : "system",
              })),
            ]
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((event) => (
                <div key={event.id} className="flex items-start gap-3 px-4 py-3">
                  <Clock3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{humanizeEvent(event.eventType)}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatDateTime(event.createdAt)} · {event.context}
                    </div>
                    {event.metadata != null &&
                      typeof event.metadata === "object" &&
                      Object.keys(event.metadata).length > 0 && (
                        <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground">
                          {JSON.stringify(event.metadata, null, 2)}
                        </pre>
                      )}
                  </div>
                </div>
              ))}
          </Card>
        )}
      </section>
    </div>
  );
}

function EmptyCard({ text }: { text: string }) {
  return <Card className="p-5 text-sm text-muted-foreground">{text}</Card>;
}

function humanizeEvent(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
