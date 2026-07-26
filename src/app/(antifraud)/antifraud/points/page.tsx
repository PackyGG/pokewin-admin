import { Suspense, type ComponentType } from "react";
import {
  Activity,
  Clock3,
  Gauge,
  Radar,
  ShieldAlert,
  Workflow,
} from "lucide-react";

import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import {
  getAntifraudScoringConfig,
  type AntifraudScoreDefinition,
  type AntifraudScoringConfig,
} from "@/lib/antifraud/monitor-api";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const metadata = { title: "Risk Scoring · Antifraud" };

export default async function AntifraudPointsPage() {
  await requireAntifraudManagerPage();

  return (
    <div className="w-full space-y-5">
      <header className="flex items-start gap-3 border-b border-border/60 pb-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-500">
          <Gauge className="size-4" />
        </span>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Risk scoring</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            The live point values and thresholds used by the antifraud monitor.
          </p>
        </div>
      </header>

      <Suspense fallback={<PointsSkeleton />}>
        <ScoringDashboard />
      </Suspense>
    </div>
  );
}

async function ScoringDashboard() {
  const result = await getAntifraudScoringConfig();
  if (!result.configured) {
    return <Unavailable text="The monitor service is not configured." />;
  }
  if (result.error || !result.data) {
    return <Unavailable text="The live scoring configuration could not be loaded." />;
  }

  const config = result.data;
  const activeRules = config.behaviorRules.filter((rule) => rule.enabled).length;
  const fixedSignals =
    config.signupSignals.length +
    config.providerSignals.length +
    config.activitySignals.length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border/70 bg-card sm:grid-cols-4">
        <SummaryItem
          icon={Radar}
          label="Monitor starts"
          value={`${config.monitorStartScore} pts`}
        />
        <SummaryItem
          icon={Clock3}
          label="Monitor window"
          value={`${config.monitorDurationSeconds / 60} min`}
        />
        <SummaryItem
          icon={Activity}
          label="Score signals"
          value={String(fixedSignals)}
        />
        <SummaryItem
          icon={Workflow}
          label="Active flows"
          value={`${activeRules}/${config.behaviorRules.length}`}
        />
      </div>

      <SeverityBands bands={config.severityBands} />

      <ScoreSection
        icon={Radar}
        title="Signup checks"
        description="Account and signup data"
        definitions={config.signupSignals}
      />
      <ScoreSection
        icon={ShieldAlert}
        title="Fingerprint and IP"
        description="Fingerprint Pro and proxycheck.io results"
        definitions={config.providerSignals}
      />
      <ScoreSection
        icon={Activity}
        title="Live behavior"
        description="Actions recorded during the monitor window"
        definitions={config.activitySignals}
      />
      <BehaviorRules config={config} />

      <p className="text-[11px] text-muted-foreground">
        Fixed signal weights are deployed with the monitor. Behavior flows are
        stored in the antifraud database.
      </p>
    </div>
  );
}

function SummaryItem({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2.5 border-border/70 p-3 [&:nth-child(odd)]:border-r [&:nth-child(n+3)]:border-t sm:[&:not(:last-child)]:border-r sm:[&:nth-child(n+3)]:border-t-0">
      <Icon className="size-4 shrink-0 text-cyan-500" />
      <span className="min-w-0">
        <span className="block truncate text-[11px] text-muted-foreground">
          {label}
        </span>
        <span className="block text-sm font-semibold tabular-nums">{value}</span>
      </span>
    </div>
  );
}

function SeverityBands({
  bands,
}: {
  bands: AntifraudScoringConfig["severityBands"];
}) {
  const colors = {
    low: "border-emerald-500/25 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400",
    medium: "border-amber-500/25 bg-amber-500/5 text-amber-600 dark:text-amber-400",
    high: "border-orange-500/25 bg-orange-500/5 text-orange-600 dark:text-orange-400",
    critical: "border-rose-500/25 bg-rose-500/5 text-rose-600 dark:text-rose-400",
  };

  return (
    <section>
      <SectionTitle icon={Gauge} title="Severity" />
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {bands.map((band) => (
          <div
            key={band.key}
            className={cn(
              "flex items-center justify-between rounded-md border px-3 py-2",
              colors[band.key],
            )}
          >
            <span className="text-xs font-medium">{band.label}</span>
            <span className="text-xs font-semibold tabular-nums">
              {band.maximum == null
                ? `${band.minimum}+`
                : `${band.minimum}–${band.maximum}`}{" "}
              pts
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ScoreSection({
  icon,
  title,
  description,
  definitions,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  definitions: AntifraudScoreDefinition[];
}) {
  return (
    <section>
      <SectionTitle icon={icon} title={title} description={description} />
      <div className="mt-2 divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card">
        {definitions.map((definition) => (
          <div
            key={definition.key}
            className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{definition.title}</p>
              <p className="text-xs leading-5 text-muted-foreground">
                {definition.description}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5 sm:max-w-md sm:justify-end">
              {definition.options.map((option) => (
                <ScoreBadge
                  key={option.label}
                  label={option.label}
                  points={option.points}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ScoreBadge({ label, points }: { label: string; points: number }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-6 gap-1 rounded-md px-2 text-[11px] font-medium tabular-nums",
        points < 0
          ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
          : "border-rose-500/25 bg-rose-500/5 text-rose-600 dark:text-rose-400",
      )}
    >
      {label}
      <span className="font-semibold">
        {points > 0 ? "+" : ""}
        {points}
      </span>
    </Badge>
  );
}

function BehaviorRules({ config }: { config: AntifraudScoringConfig }) {
  return (
    <section>
      <SectionTitle
        icon={Workflow}
        title="Behavior flows"
        description="Sequence rules evaluated during live monitoring"
      />
      <div className="mt-2 divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card">
        {config.behaviorRules.map((rule) => (
          <div
            key={rule.id}
            className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium">{rule.name}</span>
                {!rule.enabled && (
                  <Badge variant="outline" className="h-5 text-[10px]">
                    Disabled
                  </Badge>
                )}
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {rule.sequence.join(" → ")} · within {rule.window_seconds}s
              </p>
            </div>
            <ScoreBadge label={rule.action_type} points={rule.score_delta} />
          </div>
        ))}
      </div>
    </section>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  description,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="flex items-center gap-1.5 text-sm font-semibold">
        <Icon className="size-3.5 text-cyan-500" />
        {title}
      </span>
      {description && (
        <span className="text-xs text-muted-foreground">{description}</span>
      )}
    </div>
  );
}

function Unavailable({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function PointsSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-16 rounded-lg" />
      <Skeleton className="h-20 rounded-lg" />
      <Skeleton className="h-52 rounded-lg" />
      <Skeleton className="h-52 rounded-lg" />
    </div>
  );
}
