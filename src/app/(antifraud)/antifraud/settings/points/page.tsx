import { Suspense } from "react";
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
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const metadata = { title: "Antifraud Points" };

export default async function AntifraudPointsPage() {
  await requireAntifraudManagerPage();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Gauge}
          accent="cyan"
          title="Antifraud Points"
          subtitle="Every risk-score input currently used by the monitor"
          backHref="/antifraud"
        />
      </PageHero>

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
    <div className="space-y-8">
      <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 px-4 py-3 text-xs text-muted-foreground">
        This is the live scoring reference. Behavior flows are stored in the
        antifraud database; fixed signup, provider and activity weights are
        deployed with the monitor service.
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Monitor starts at"
          value={`${config.monitorStartScore} pts`}
          sub="signup risk score"
          icon={Radar}
          accent="cyan"
        />
        <KpiTile
          label="Monitor window"
          value={`${config.monitorDurationSeconds / 60} min`}
          sub="behavior observation"
          icon={Clock3}
          accent="purple"
        />
        <KpiTile
          label="Score signals"
          value={String(fixedSignals)}
          sub="signup, provider and activity"
          icon={Activity}
          accent="amber"
        />
        <KpiTile
          label="Active flows"
          value={`${activeRules}/${config.behaviorRules.length}`}
          sub="sequence-based rules"
          icon={Workflow}
          accent="emerald"
        />
      </div>

      <SeverityBands bands={config.severityBands} />
      <ScoreSection
        icon={Radar}
        title="Signup checks"
        subtitle="Signals calculated from Packy signup and account-linking data."
        definitions={config.signupSignals}
      />
      <ScoreSection
        icon={ShieldAlert}
        title="Fingerprint and IP checks"
        subtitle="Signals returned by Fingerprint Pro Plus and proxycheck.io. Multiple matching provider signals stack."
        definitions={config.providerSignals}
      />
      <ScoreSection
        icon={Activity}
        title="Live behavior"
        subtitle="Points added or removed while the user is actively monitored. The running score is always floored at zero."
        definitions={config.activitySignals}
      />
      <BehaviorRules config={config} />
    </div>
  );
}

function SeverityBands({
  bands,
}: {
  bands: AntifraudScoringConfig["severityBands"];
}) {
  const colors = {
    low: "border-emerald-500/30 bg-emerald-500/5",
    medium: "border-amber-500/30 bg-amber-500/5",
    high: "border-orange-500/30 bg-orange-500/5",
    critical: "border-rose-500/30 bg-rose-500/5",
  };

  return (
    <section className="space-y-4">
      <SectionHeading icon={Gauge} title="Severity bands" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {bands.map((band) => (
          <div
            key={band.key}
            className={cn("rounded-xl border px-4 py-3", colors[band.key])}
          >
            <p className="text-xs font-bold uppercase tracking-wide">
              {band.label}
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums">
              {band.maximum == null
                ? `${band.minimum}+`
                : `${band.minimum}–${band.maximum}`}{" "}
              pts
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ScoreSection({
  icon,
  title,
  subtitle,
  definitions,
}: {
  icon: typeof Radar;
  title: string;
  subtitle: string;
  definitions: AntifraudScoreDefinition[];
}) {
  return (
    <section className="space-y-4">
      <SectionHeading icon={icon} title={title} />
      <p className="-mt-2 text-xs text-muted-foreground">{subtitle}</p>
      <ul className="grid gap-3 lg:grid-cols-2">
        {definitions.map((definition) => (
          <li
            key={definition.key}
            className="rounded-xl border border-border/60 bg-card px-4 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm font-semibold">
                  {definition.title}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {definition.description}
                </span>
              </span>
              <code className="shrink-0 text-[10px] text-muted-foreground">
                {definition.key}
              </code>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {definition.options.map((option) => (
                <Badge
                  key={option.label}
                  variant="outline"
                  className={cn(
                    "gap-1 tabular-nums",
                    option.points < 0
                      ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                      : "border-rose-500/30 text-rose-600 dark:text-rose-400",
                  )}
                >
                  {option.label}: {option.points > 0 ? "+" : ""}
                  {option.points}
                </Badge>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BehaviorRules({ config }: { config: AntifraudScoringConfig }) {
  return (
    <section className="space-y-4">
      <SectionHeading icon={Workflow} title="Behavior flows" />
      <p className="-mt-2 text-xs text-muted-foreground">
        Sequence bonuses stored in the antifraud database and evaluated during
        the live monitor window.
      </p>
      <ul className="space-y-3">
        {config.behaviorRules.map((rule) => (
          <li
            key={rule.id}
            className="rounded-xl border border-border/60 bg-card px-4 py-4"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{rule.name}</span>
                  <Badge variant={rule.enabled ? "default" : "outline"}>
                    {rule.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  <Badge variant="outline">{rule.action_type}</Badge>
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {rule.description}
                </span>
              </span>
              <span
                className={cn(
                  "shrink-0 text-lg font-bold tabular-nums",
                  rule.score_delta < 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400",
                )}
              >
                {rule.score_delta > 0 ? "+" : ""}
                {rule.score_delta} pts
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>Sequence</span>
              {rule.sequence.map((event, index) => (
                <span key={`${event}-${index}`} className="contents">
                  {index > 0 && <span>→</span>}
                  <code className="rounded bg-muted px-1.5 py-0.5">{event}</code>
                </span>
              ))}
              <span>within {rule.window_seconds}s</span>
              {rule.exclude_before.length > 0 && (
                <span>
                  · blocked after {rule.exclude_before.join(", ")}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Unavailable({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function PointsSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-32 rounded-xl" />
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}
