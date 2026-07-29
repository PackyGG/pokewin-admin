"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Gavel, ShieldCheck, ShieldX } from "lucide-react";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { decideMonitorCase } from "../actions";

/**
 * The verdict controls on a monitor case.
 *
 * Idempotency: the key is generated HERE, once per (decision, reason) attempt,
 * and reused verbatim if the same button is pressed again after a failure — so
 * a double-click or a retried timeout resolves to one `staff_actions` row
 * upstream instead of two. Picking a different verdict starts a new key,
 * because that is a genuinely different write.
 *
 * A reason is mandatory: the whole point of closing the loop here is that the
 * case history explains itself six months later.
 */

type MonitorCaseDecision =
  | "in_review"
  | "resolved_safe"
  | "resolved_fraud";

const DECISIONS: {
  value: MonitorCaseDecision;
  icon: React.ElementType;
  className: string;
  label: string;
  hint: string;
}[] = [
  {
    value: "in_review",
    icon: Gavel,
    label: "Take into review",
    className:
      "border-amber-500/30 bg-amber-500/10 text-amber-600 hover:bg-amber-500/15 dark:text-amber-400",
    hint: "You are working it — keeps the case open.",
  },
  {
    value: "resolved_safe",
    icon: ShieldCheck,
    label: "Resolve — legitimate",
    className:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400",
    hint: "Closes the case as a legitimate account.",
  },
  {
    value: "resolved_fraud",
    icon: ShieldX,
    label: "Resolve — fraud",
    className:
      "border-rose-500/30 bg-rose-500/10 text-rose-600 hover:bg-rose-500/15 dark:text-rose-400",
    hint: "Closes the case as fraud. Act on the account from the main dashboard.",
  },
];

export function DecisionPanel({
  caseId,
  status,
  enabled,
}: {
  caseId: string;
  status: string;
  /** False when the service's admin token is not configured server-side. */
  enabled: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = React.useState("");
  const [pending, setPending] = React.useState<MonitorCaseDecision | null>(null);
  const attempt = React.useRef<{
    decision: MonitorCaseDecision;
    key: string;
  } | null>(null);

  const resolved = status === "resolved";
  const locked = resolved || !enabled;

  async function submit(decision: MonitorCaseDecision) {
    const body = reason.trim();
    if (body.length < 4) {
      toast.error("Say why you are making this call");
      return;
    }
    // Reuse the key only when retrying the SAME verdict.
    if (attempt.current?.decision !== decision) {
      attempt.current = { decision, key: crypto.randomUUID() };
    }
    setPending(decision);
    try {
      const result = await decideMonitorCase({
        caseId,
        decision,
        reason: body,
        idempotencyKey: attempt.current.key,
      });
      toast.success(
        result.idempotent
          ? "That decision was already recorded"
          : `${result.label} — recorded`,
      );
      attempt.current = null;
      setReason("");
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not record that decision",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-border/60 bg-card p-4">
      {!enabled && (
        <p className="rounded-lg border border-dashed border-border/70 bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          Decisions are read-only here: the monitor service&apos;s admin token
          is not configured on this deployment.
        </p>
      )}
      {resolved && (
        <p className="rounded-lg border border-dashed border-border/70 bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          This case is closed. Reopening is not something the service allows —
          open a fresh review if something new turned up.
        </p>
      )}

      <div className="space-y-1.5">
        <Label
          htmlFor="monitor-decision-reason"
          className="text-xs uppercase tracking-wide text-muted-foreground"
        >
          Reason (required)
        </Label>
        <Textarea
          id="monitor-decision-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={4}
          maxLength={1000}
          disabled={locked || pending !== null}
          placeholder="What you checked, and what convinced you."
          className="text-xs"
        />
      </div>

      <div className="space-y-2">
        {DECISIONS.map(({ value, icon: Icon, className, label, hint }) => (
          <div key={value} className="space-y-1">
            <button
              type="button"
              disabled={locked || pending !== null}
              onClick={() => void submit(value)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50",
                className,
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">
                {pending === value
                  ? "Recording…"
                  : label}
              </span>
            </button>
            <p className="px-1 text-[10px] leading-snug text-muted-foreground">
              {hint}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
