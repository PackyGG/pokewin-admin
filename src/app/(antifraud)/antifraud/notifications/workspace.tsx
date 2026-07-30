"use client";

import { useState, useTransition } from "react";
import { BellPlus, Power, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { StepUpField } from "@/components/step-up-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ANTIFRAUD_DASHBOARD_GROUPS,
  ANTIFRAUD_SEVERITIES,
  type AntifraudDashboardEventOption,
  type AntifraudDashboardGroup,
  type AntifraudDashboardNotificationRule,
  type AntifraudSeverity,
} from "@/lib/antifraud/dashboard-notification-contract";
import {
  createDashboardNotificationRuleAction,
  deleteDashboardNotificationRuleAction,
  setDashboardNotificationRuleEnabledAction,
} from "./actions";

const GROUP_LABELS: Record<AntifraudDashboardGroup, string> = {
  owner: "Owners",
  admin: "Admins",
  support: "Support",
  marketing: "Marketing",
  creator_manager: "Creator managers",
  creator: "Creators",
  pack_creator: "Pack creators",
};

export function DashboardNotificationWorkspace({
  initialRules,
  events,
}: {
  initialRules: AntifraudDashboardNotificationRule[];
  events: AntifraudDashboardEventOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [credential, setCredential] = useState("");
  const [eventKey, setEventKey] = useState(events[0]?.key ?? "");
  const [label, setLabel] = useState("");
  const [minimumSeverity, setMinimumSeverity] =
    useState<AntifraudSeverity>("medium");
  const [groups, setGroups] = useState<AntifraudDashboardGroup[]>(["admin"]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [href, setHref] = useState("/antifraud/reviews");
  const [enabled, setEnabled] = useState(false);

  function mutate(operation: () => Promise<unknown>, success: string) {
    if (!credential) {
      toast.error("Approve this change with a passkey or 2FA code.");
      return;
    }
    startTransition(async () => {
      try {
        await operation();
        toast.success(success);
        setCredential("");
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Change failed.");
      }
    });
  }

  function create() {
    mutate(
      () =>
        createDashboardNotificationRuleAction({
          eventKey,
          label,
          minimumSeverity,
          targetGroups: groups,
          titleTemplate: title,
          bodyTemplate: body,
          hrefTemplate: href,
          enabled,
          credential,
          idempotencyKey: crypto.randomUUID(),
        }),
      enabled ? "Dashboard rule created and enabled." : "Draft rule created.",
    );
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b p-4">
          <h2 className="font-semibold">Configured rules</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {initialRules.length} rule{initialRules.length === 1 ? "" : "s"}.
            Disabled drafts do not deliver.
          </p>
        </div>
        {initialRules.length === 0 ? (
          <div className="flex min-h-52 flex-col items-center justify-center p-8 text-center">
            <BellPlus className="size-6 text-muted-foreground" />
            <p className="mt-3 text-sm font-semibold">No automatic rules</p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              This is the secure default. Create a rule only for an event and
              staff audience that should receive an on-site alert.
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {initialRules.map((rule) => (
              <article key={rule.id} className="space-y-3 p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{rule.label}</h3>
                      <Badge variant={rule.enabled ? "default" : "secondary"}>
                        {rule.enabled ? "Enabled" : "Draft"}
                      </Badge>
                      <Badge variant="outline">{rule.minimumSeverity}+</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {rule.eventLabel} · {rule.targetGroups.map((group) => GROUP_LABELS[group]).join(", ")}
                    </p>
                    <p className="mt-2 text-sm font-medium">{rule.titleTemplate}</p>
                    {rule.bodyTemplate && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {rule.bodyTemplate}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="icon-sm"
                      variant="outline"
                      disabled={pending}
                      aria-label={rule.enabled ? "Disable rule" : "Enable rule"}
                      onClick={() =>
                        mutate(
                          () =>
                            setDashboardNotificationRuleEnabledAction({
                              id: rule.id,
                              enabled: !rule.enabled,
                              credential,
                              idempotencyKey: crypto.randomUUID(),
                            }),
                          rule.enabled ? "Rule disabled." : "Rule enabled.",
                        )
                      }
                    >
                      <Power />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={pending}
                      aria-label="Delete rule"
                      onClick={() => {
                        if (!window.confirm(`Delete "${rule.label}"?`)) return;
                        mutate(
                          () =>
                            deleteDashboardNotificationRuleAction({
                              id: rule.id,
                              credential,
                              idempotencyKey: crypto.randomUUID(),
                            }),
                          "Rule deleted.",
                        );
                      }}
                    >
                      <Trash2 className="text-destructive" />
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <aside className="space-y-4 rounded-xl border bg-card p-4">
        <div>
          <h2 className="font-semibold">Create rule</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Templates are stored as configuration only. Secret or raw provider
            fields are never accepted here.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label>Fraud event</Label>
          <Select
            value={eventKey}
            onValueChange={(value) => setEventKey(value ?? "")}
          >
            <SelectTrigger><SelectValue placeholder="Choose an event" /></SelectTrigger>
            <SelectContent>
              {events.map((event) => (
                <SelectItem key={event.key} value={event.key}>
                  {event.category} · {event.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Field label="Rule name" value={label} onChange={setLabel} maxLength={100} />
        <div className="space-y-1.5">
          <Label>Minimum severity</Label>
          <Select
            value={minimumSeverity}
            onValueChange={(value) => setMinimumSeverity(value as AntifraudSeverity)}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {ANTIFRAUD_SEVERITIES.map((severity) => (
                <SelectItem key={severity} value={severity}>
                  {severity.charAt(0).toUpperCase() + severity.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Admin groups</Label>
          <div className="grid grid-cols-2 gap-2">
            {ANTIFRAUD_DASHBOARD_GROUPS.map((group) => (
              <label key={group} className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={groups.includes(group)}
                  onCheckedChange={(checked) =>
                    setGroups((current) =>
                      checked
                        ? [...new Set([...current, group])]
                        : current.filter((item) => item !== group),
                    )
                  }
                />
                {GROUP_LABELS[group]}
              </label>
            ))}
          </div>
        </div>
        <Field label="Alert title" value={title} onChange={setTitle} maxLength={120} />
        <div className="space-y-1.5">
          <Label>Alert body</Label>
          <Textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={1000} />
        </div>
        <Field label="Internal action link" value={href} onChange={setHref} maxLength={500} />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(value) => setEnabled(value === true)} />
          Enable immediately
        </label>
        <StepUpField
          id="dashboard-rule-step-up"
          value={credential}
          onChange={setCredential}
          disabled={pending}
          label="Approve configuration change"
        />
        <Button
          className="w-full"
          disabled={
            pending ||
            !eventKey ||
            label.trim().length < 2 ||
            title.trim().length < 3 ||
            groups.length === 0
          }
          onClick={create}
        >
          <BellPlus />
          Create {enabled ? "enabled rule" : "draft"}
        </Button>
      </aside>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        value={value}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
