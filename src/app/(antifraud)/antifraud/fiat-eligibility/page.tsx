import {
  Activity,
  BadgeCheck,
  Ban,
  Clock3,
  Fingerprint,
  Gauge,
  KeyRound,
  Network,
  RefreshCw,
  Route,
  ServerCog,
  ShieldCheck,
  ShieldX,
  type LucideIcon,
} from "lucide-react";

import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";

export const metadata = { title: "Fiat Eligibility · Antifraud" };

type Rule = {
  title: string;
  detail: string;
  points: string;
  blocking?: boolean;
};

const HARD_BLOCKERS: Rule[] = [
  {
    title: "Account restriction",
    detail:
      "Banned, locked, self-excluded, per-user Fiat-disabled, or country-blocked accounts.",
    points: "Block",
    blocking: true,
  },
  {
    title: "KYC not cleared",
    detail:
      "KYC is required and is not approved, or an admin rejected the verification.",
    points: "Block",
    blocking: true,
  },
  {
    title: "Request is not fresh",
    detail:
      "The backend timestamp or Fingerprint event is older than 2 minutes, over 30 seconds in the future, or missing trusted time.",
    points: "Block",
    blocking: true,
  },
  {
    title: "Identity does not bind",
    detail:
      "The Fingerprint event belongs to another user, has no linked user, or its IP differs from the backend-captured IP.",
    points: "Block",
    blocking: true,
  },
  {
    title: "Provider check unavailable",
    detail:
      "Either the full Fingerprint event lookup or independent proxycheck.io lookup does not succeed.",
    points: "Block",
    blocking: true,
  },
  {
    title: "Hard device or network attack",
    detail:
      "Replay, bad bot, Tor, attack-source IP, rooted or jailbroken device, cloned app, Frida, location spoofing, or mobile MitM.",
    points: "Block",
    blocking: true,
  },
];

const ACCOUNT_RULES: Rule[] = [
  {
    title: "Suspected alternate account",
    detail: "The account is already marked as a suspected alt.",
    points: "+55",
  },
  {
    title: "Account under 1 day old",
    detail: "Very new accounts receive the larger age penalty.",
    points: "+30",
  },
  {
    title: "Account 1–7 days old",
    detail: "New, but no longer inside the first-day window.",
    points: "+15",
  },
  {
    title: "Signup IP changed",
    detail: "Checkout IP differs from signup. The lower value applies at 7+ days.",
    points: "+25 / +10",
  },
  {
    title: "Signup device changed",
    detail:
      "Checkout Fingerprint visitor differs from signup. The lower value applies at 7+ days.",
    points: "+35 / +20",
  },
];

const NETWORK_RULES: Rule[] = [
  {
    title: "Checkout device is shared",
    detail: "Used by 1–2 other accounts / at least 3 other accounts.",
    points: "+40 / +70",
  },
  {
    title: "Checkout IP is shared",
    detail: "At least 3 other signup accounts / at least 10 other accounts.",
    points: "+15 / +40",
  },
  {
    title: "Fingerprint Pro Plus evidence",
    detail:
      "Event integrity, VPN/proxy, velocity, browser, device, mobile, datacenter, confidence, and suspect-score signals use the live configured weights.",
    points: "Live weights",
  },
  {
    title: "proxycheck.io evidence",
    detail:
      "Current proxy, VPN, Tor, risk, network, location, operator, and attack-history evidence. History-only evidence is preserved without double-counting.",
    points: "Live weights",
  },
];

const HISTORY_RULES: Rule[] = [
  {
    title: "Signup risk history",
    detail: "Prior signup score is at least 25 / at least 60.",
    points: "+20 / +45",
  },
  {
    title: "Active high-risk case",
    detail: "The production account has an open high or critical Fraud case.",
    points: "+60",
  },
  {
    title: "Eligibility velocity",
    detail: "At least 5 / at least 10 checks within 10 minutes.",
    points: "+35 / +70",
  },
  {
    title: "Repeated denials",
    detail: "At least 3 / at least 6 denied checks within 24 hours.",
    points: "+25 / +60",
  },
  {
    title: "Established Fiat history",
    detail:
      "A 7+ day account with completed Fiat deposits receives credit only when no blocker exists.",
    points: "−6 to −15",
  },
];

const FLOW = [
  {
    icon: KeyRound,
    title: "Authenticate backend",
    detail:
      "The dedicated bearer key must match the declared environment and the caller must be inside that environment's source-IP allowlist.",
  },
  {
    icon: ServerCog,
    title: "Load isolated account state",
    detail:
      "Production and development use separate read-only source connections. The account, Fiat locks, country policy, KYC, history, and recent attempts are loaded.",
  },
  {
    icon: Fingerprint,
    title: "Verify the live checkout",
    detail:
      "A fresh Fingerprint request ID is checked against the user and checkout IP, then proxycheck.io independently checks the same IP.",
  },
  {
    icon: Gauge,
    title: "Apply blockers and score",
    detail:
      "Duplicate signal keys keep their strongest value. Points are summed, trust credit is applied when eligible, and the result is clamped to 0–100.",
  },
] as const;

export default async function FiatEligibilityPage() {
  await requireAntifraudManagerPage();

  return (
    <div className="space-y-8">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Automatic Fiat eligibility
          </h1>
          <Badge variant="outline">Production + development</Badge>
        </div>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          The checkout backend asks one question: should this exact user, device,
          and IP be allowed to continue with a Fiat deposit right now?
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiTile
          label="Endpoint"
          value="POST"
          sub="/v1/fiat-eligibility/check"
          icon={Route}
          accent="cyan"
        />
        <KpiTile
          label="Deny threshold"
          value="50 pts"
          sub="or any hard blocker"
          icon={Gauge}
          accent="rose"
        />
        <KpiTile
          label="Allow validity"
          value="60 sec"
          sub="bound to one checkout attempt"
          icon={Clock3}
          accent="amber"
        />
        <KpiTile
          label="Result"
          value="True / False"
          sub="automatic and fail-closed"
          icon={ShieldCheck}
          accent="emerald"
        />
      </div>

      <section className="space-y-4">
        <SectionHeading icon={Activity} title="What happens on every check" />
        <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {FLOW.map((step, index) => {
            const Icon = step.icon;
            return (
              <li
                key={step.title}
                className="rounded-xl border border-border/70 bg-card p-4"
              >
                <div className="flex items-center gap-2">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-xs font-semibold text-primary">
                    {index + 1}
                  </span>
                  <Icon className="size-4 text-primary" aria-hidden />
                </div>
                <h3 className="mt-3 text-sm font-semibold">{step.title}</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {step.detail}
                </p>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="space-y-4">
        <SectionHeading icon={ShieldCheck} title="How true or false is decided" />
        <div className="grid gap-3 lg:grid-cols-2">
          <DecisionCard
            allowed
            title="allowed: true"
            detail="Returned only when there are no hard blockers and the final risk score is below 50."
            facts={[
              "decision = allow",
              "allowed = true",
              "expires after 60 seconds",
            ]}
          />
          <DecisionCard
            allowed={false}
            title="allowed: false"
            detail="Returned when any hard blocker exists, the final score reaches 50, or the assessment cannot complete safely."
            facts={[
              "decision = deny",
              "allowed = false",
              "backend must stop checkout",
            ]}
          />
        </div>
        <div className="rounded-xl border border-border/70 bg-card px-4 py-3">
          <code className="block whitespace-pre-wrap text-xs leading-6 text-muted-foreground">
            allowed = no blocking signal AND final risk score &lt; 50
          </code>
        </div>
      </section>

      <RuleSection
        icon={Ban}
        title="Immediate hard blockers"
        description="One match is enough to return false, regardless of the score."
        rules={HARD_BLOCKERS}
      />
      <RuleSection
        icon={BadgeCheck}
        title="Account and signup signals"
        description="Fixed points added before the final threshold check."
        rules={ACCOUNT_RULES}
      />
      <RuleSection
        icon={Network}
        title="Device and network signals"
        description="Live checkout evidence from Fingerprint, proxycheck.io, and shared-account links."
        rules={NETWORK_RULES}
      />
      <RuleSection
        icon={RefreshCw}
        title="History and velocity"
        description="Previous risk and repeated behavior, isolated by environment where applicable."
        rules={HISTORY_RULES}
      />

      <section className="space-y-4">
        <SectionHeading icon={ServerCog} title="Safety and reuse rules" />
        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card">
          <SafetyRow
            title="Environment-bound"
            detail="Dev and production keys, caller allowlists, and read-only source databases are separate. A key cannot claim the other environment."
          />
          <SafetyRow
            title="Single-use Fingerprint event"
            detail="Repeating the exact payload returns the stored result. Reusing the same event with changed input returns false with fingerprint_reused."
          />
          <SafetyRow
            title="Fail closed"
            detail="Invalid auth, disallowed caller IP, malformed input, provider failure, timeout, persistence error, non-200 response, or expired allow result must stop checkout."
          />
          <SafetyRow
            title="Auditable decision"
            detail="The decision ID, environment, score, reason codes, sanitized evidence, and expiry are persisted in the Fraud database without exposing credentials or raw provider payloads."
          />
        </div>
      </section>
    </div>
  );
}

function DecisionCard({
  allowed,
  title,
  detail,
  facts,
}: {
  allowed: boolean;
  title: string;
  detail: string;
  facts: string[];
}) {
  const Icon = allowed ? ShieldCheck : ShieldX;
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        allowed
          ? "border-emerald-500/25 bg-emerald-500/5"
          : "border-rose-500/25 bg-rose-500/5",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            "size-5",
            allowed
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400",
          )}
          aria-hidden
        />
        <h3 className="font-mono text-sm font-semibold">{title}</h3>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {facts.map((fact) => (
          <li key={fact}>
            <Badge variant="outline" className="font-mono text-[10px]">
              {fact}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RuleSection({
  icon,
  title,
  description,
  rules,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  rules: Rule[];
}) {
  return (
    <section className="space-y-4">
      <SectionHeading
        icon={icon}
        title={
          <>
            {title}
            <span className="text-xs font-normal text-muted-foreground">
              {description}
            </span>
          </>
        }
      />
      <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card">
        {rules.map((rule) => (
          <div
            key={rule.title}
            className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{rule.title}</p>
              <p className="text-xs leading-5 text-muted-foreground">
                {rule.detail}
              </p>
            </div>
            <Badge
              variant="outline"
              className={cn(
                "w-fit font-mono text-[10px] tabular-nums",
                rule.blocking &&
                  "border-rose-500/25 bg-rose-500/5 text-rose-600 dark:text-rose-400",
              )}
            >
              {rule.points}
            </Badge>
          </div>
        ))}
      </div>
    </section>
  );
}

function SafetyRow({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}
