"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Database, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { switchDbEnv } from "@/lib/actions/db-env";
import {
  formatDbTargetLine,
  type DbEnv,
  type MainDbEnvDisplay,
} from "@/lib/db-env-display.types";
import { SectionHeading } from "@/components/modern-panels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function ConnectionUrlField({
  label,
  url,
  hint,
}: {
  label: string;
  url: string | null;
  hint?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Copied to clipboard");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-sm font-medium">{label}</Label>
        {hint ? (
          <span className="text-xs text-muted-foreground">{hint}</span>
        ) : null}
      </div>
      {url ? (
        <div className="flex gap-2">
          <Input
            readOnly
            value={url}
            className="font-mono text-xs"
            aria-label={label}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0"
            onClick={copy}
            aria-label={`Copy ${label}`}
          >
            {copied ? (
              <Check className="size-4 text-emerald-500" />
            ) : (
              <Copy className="size-4" />
            )}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Not configured on this server.</p>
      )}
    </div>
  );
}

export function DbEnvSettingsCard({ display }: { display: MainDbEnvDisplay }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  async function pick(next: DbEnv) {
    if (pending || next === display.activeEnv) return;
    if (next === "dev" && !display.devConfigured) {
      toast.error("DEV_DATABASE_URL is not configured on this server");
      return;
    }
    setPending(true);
    try {
      await switchDbEnv(next);
      toast.success(
        next === "dev"
          ? "Switched to DEV environment"
          : "Switched back to PROD environment",
      );
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not switch environment",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeading icon={Database} title="Development database" />

      <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-3 text-xs text-muted-foreground sm:text-sm">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" />
        <p>
          Admin-only. The dev connection string includes credentials — treat like
          a password. Production credentials are never shown here. The Admin DB
          (sessions, users, audit) is always separate and is not switched by the
          environment toggle below.
        </p>
      </div>

      <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium">Your session is reading from</p>
            <Badge
              variant="outline"
              className={cn(
                "font-mono uppercase",
                display.activeEnv === "dev"
                  ? "border-rose-500/40 text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground",
              )}
            >
              {display.activeEnv}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={display.activeEnv === "prod" ? "default" : "outline"}
              size="sm"
              disabled={pending}
              onClick={() => pick("prod")}
            >
              Use production
            </Button>
            <Button
              type="button"
              variant={display.activeEnv === "dev" ? "default" : "outline"}
              size="sm"
              disabled={pending || !display.devConfigured}
              onClick={() => pick("dev")}
            >
              Use development
            </Button>
          </div>
        </div>

        <div className="mt-6">
          <ConnectionUrlField
            label="Development (DEV_DATABASE_URL)"
            url={display.devDatabaseUrl}
            hint={formatDbTargetLine(display.dev)}
          />
        </div>
      </div>
    </div>
  );
}
