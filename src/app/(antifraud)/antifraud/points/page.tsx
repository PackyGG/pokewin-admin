import { Suspense, type ComponentType, type ReactNode } from "react";
import {
  Activity,
  Clock3,
  Gauge,
  Radar,
  RadioTower,
  ShieldAlert,
  Users,
  Workflow,
} from "lucide-react";

import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import {
  getAntifraudEventCatalog,
  getAntifraudScoringConfig,
  type AntifraudScoreDefinition,
  type AntifraudScoringConfig,
} from "@/lib/antifraud/monitor-api";
import {
  listAnalysisRules,
  type AntifraudAnalysisRule,
} from "@/lib/antifraud/network-api";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  type AccentColor,
} from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TabChips } from "@/components/ux";
import { cn } from "@/lib/utils";
import { FlowBuilder } from "../flows/flow-builder";
import { ScoreWeightEditor } from "./score-weight-editor";
import { AnalysisRuleEditor } from "./analysis-rule-editor";

export const metadata = { title: "Rules & Scoring · Antifraud" };

type RiskScoringTab = "scoring" | "flows" | "network";

const RISK_SCORING_TABS = [
  { value: "scoring", label: "Risk scoring" },
  { value: "flows", label: "Point flows" },
  { value: "network", label: "Network & creator" },
] as const;

export default async function AntifraudPointsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireAntifraudManagerPage();
  const requestedTab = (await searchParams).tab;
  const tab: RiskScoringTab =
    requestedTab === "flows" || requestedTab === "network"
      ? requestedTab
      : "scoring";

  // Shell-first and active-tab-only: the selected tab is the only branch
  // mounted, so its monitor API reads do not run until that tab is selected.
  // The connected-account and creator checks moved onto their own tab, so the
  // scoring tab no longer pays for `listAnalysisRules()` on every visit.
  return (
    <div className="space-y-4">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Rules &amp; scoring
        </h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
          What turns evidence into points, which sequences escalate a case, and
          how connected accounts and creator networks are judged.
        </p>
      </div>

      <TabChips
        items={RISK_SCORING_TABS}
        current={tab}
        paramKey="tab"
        defaultValue="scoring"
      />

      <Suspense
        key={tab}
        fallback={
          tab === "flows" ? (
            <FlowBuilderSkeleton />
          ) : tab === "network" ? (
            <NetworkSkeleton />
          ) : (
            <PointsSkeleton />
          )
        }
      >
        {tab === "flows" ? (
          <FlowBuilderData />
        ) : tab === "network" ? (
          <NetworkChecks />
        ) : (
          <ScoringDashboard />
        )}
      </Suspense>
    </div>
  );
}

async function NetworkChecks() {
  const analysis = await listAnalysisRules();
  if (!analysis.configured) {
    return <Unavailable text="The monitor service is not configured." />;
  }
  if (analysis.error) {
    return <Unavailable text="The network and creator checks could not be loaded." />;
  }
  const network = analysis.data.filter((rule) => rule.category === "network");
  const creator = analysis.data.filter((rule) => rule.category === "creator");
  if (network.length === 0 && creator.length === 0) {
    return <Unavailable text="No network or creator checks are configured." />;
  }
  return (
    <div className="space-y-4">
      {network.length > 0 && (
        <AnalysisRules
          icon={Users}
          title="Account network checks"
          description="full connected-component scoring"
          rules={network}
        />
      )}
      {creator.length > 0 && (
        <AnalysisRules
          icon={Radar}
          title="Creator fraud checks"
          description="referred-account networks and activity; creator behavior is excluded"
          rules={creator}
        />
      )}
      <p className="text-[11px] text-muted-foreground">
        Edits apply to new assessments. Existing case history keeps the values
        recorded when it occurred.
      </p>
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
  const cards: {
    label: string;
    value: string;
    icon: ComponentType<{ className?: string }>;
    accent: AccentColor;
  }[] = [
    {
      label: "Monitor starts at",
      value: `${config.monitorStartScore} pts`,
      icon: Radar,
      accent: "cyan",
    },
    {
      label: "Monitor window",
      value: `${config.monitorDurationSeconds / 60} min`,
      icon: Clock3,
      accent: "cyan",
    },
    {
      label: "Score signals",
      value: String(fixedSignals),
      icon: Activity,
      accent: "emerald",
    },
    {
      label: "Active flows",
      value: `${activeRules}/${config.behaviorRules.length}`,
      icon: Workflow,
      accent:
        activeRules < config.behaviorRules.length ? "amber" : "emerald",
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <KpiTile
            key={card.label}
            label={card.label}
            value={card.value}
            icon={card.icon}
            accent={card.accent}
          />
        ))}
      </div>

      <SeverityBands bands={config.severityBands} />

      <ScoreSection
        icon={Radar}
        title="Signup checks"
        description="account and signup data"
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
        description="actions recorded during the monitor window"
        definitions={config.activitySignals}
      />
      <BehaviorRules config={config} />

      <p className="text-[11px] text-muted-foreground">
        Point edits apply to new signup assessments and new live activity.
        Existing case history keeps the values recorded when it occurred.
      </p>
    </div>
  );
}

async function FlowBuilderData() {
  const [scoring, events] = await Promise.all([
    getAntifraudScoringConfig(),
    getAntifraudEventCatalog(),
  ]);
  if (!scoring.configured || !events.configured) {
    return <Unavailable text="The monitor service is not configured." />;
  }
  if (scoring.error || events.error || !scoring.data) {
    return (
      <Unavailable text="The flow builder could not load the live monitor configuration." />
    );
  }
  return (
    <FlowBuilder
      initialRules={scoring.data.behaviorRules}
      events={events.data}
      monitorWindowSeconds={scoring.data.monitorDurationSeconds}
    />
  );
}

function SectionTitleText({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <>
      {title}
      {description && (
        <span className="text-xs font-normal text-muted-foreground">
          {description}
        </span>
      )}
    </>
  );
}

// Two rows side by side on wide screens: these lists are short text plus a few
// controls, so a single full-width column wasted most of the horizontal space.
// The cells carry the dividers and the wrapper's -mb-px swallows the last row's
// bottom border so it never doubles up with the container border.
const LIST_GRID =
  "-mb-px grid lg:grid-cols-2 [&>*]:border-b [&>*]:border-border/60 " +
  "lg:[&>*:nth-child(odd)]:border-r lg:[&>*:last-child:nth-child(odd)]:border-r-0";

function ListGrid({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className={LIST_GRID}>{children}</div>
    </div>
  );
}

function AnalysisRules({
  icon,
  title,
  description,
  rules,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  rules: AntifraudAnalysisRule[];
}) {
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={icon}
        title={<SectionTitleText title={title} description={description} />}
      />
      <ListGrid>
        {rules.map((rule) => (
          <AnalysisRuleEditor key={rule.key} rule={rule} />
        ))}
      </ListGrid>
    </section>
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
    <section className="space-y-3">
      <SectionHeading
        icon={Gauge}
        title={
          <SectionTitleText
            title="Severity bands"
            description="how a case's total points map to severity"
          />
        }
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {bands.map((band) => (
          <div
            key={band.key}
            className={cn(
              "rounded-lg border px-3 py-2.5",
              colors[band.key],
            )}
          >
            <span className="block text-xs font-semibold">{band.label}</span>
            <span className="mt-0.5 block text-sm font-semibold tabular-nums">
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
    <section className="space-y-3">
      <SectionHeading
        icon={icon}
        title={<SectionTitleText title={title} description={description} />}
      />
      <ListGrid>
        {definitions.map((definition) => (
          <div key={definition.key} className="space-y-2 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{definition.title}</p>
              <p className="text-xs leading-5 text-muted-foreground">
                {definition.description}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {definition.options.map((option) => (
                <ScoreWeightEditor
                  key={option.key}
                  weightKey={option.key}
                  label={option.label}
                  points={option.points}
                />
              ))}
            </div>
          </div>
        ))}
      </ListGrid>
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
    <section className="space-y-3">
      <SectionHeading
        icon={Workflow}
        title={
          <SectionTitleText
            title="Behavior flows"
            description="sequence rules evaluated during live monitoring"
          />
        }
      />
      <ListGrid>
        {config.behaviorRules.map((rule) => (
          <div
            key={rule.id}
            className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
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
      </ListGrid>
    </section>
  );
}

function Unavailable({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-14 text-center">
      <RadioTower className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function NetworkSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-56 rounded-lg" />
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-8 w-56 rounded-lg" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

function PointsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-24 rounded-xl" />
      <Skeleton className="h-52 rounded-xl" />
      <Skeleton className="h-52 rounded-xl" />
    </div>
  );
}

function FlowBuilderSkeleton() {
  return (
    <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
      <Skeleton className="h-[520px] rounded-xl" />
      <div className="space-y-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    </div>
  );
}
