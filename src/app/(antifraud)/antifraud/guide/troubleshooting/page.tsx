import {
  Activity,
  AlertTriangle,
  KeyRound,
  Plug,
  Siren,
  TriangleAlert,
  Webhook,
} from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import {
  GuideBadge,
  GuideBullets,
  GuideCallout,
  GuidePage,
  GuideSection,
  GuideSubHeading,
  GuideTable,
} from "../_components/guide-primitives";

export const metadata = { title: "Troubleshooting Guide · Antifraud" };

/**
 * Sources: src/app/(antifraud)/antifraud/settings/_sections/{health.tsx,
 * integrations.tsx}, src/lib/antifraud/{monitor-api.ts,containment-outbox.ts,
 * identifier-blocklists-api.ts}, services/antifraud-monitor/src/auth.ts,
 * src/lib/discord-notifications/router.ts,
 * services/antifraud-monitor/src/fiat-deposit-access-control.ts,
 * src/app/(antifraud)/antifraud/refunds/refund-actions.ts. Citations inline.
 */

// settings/_sections/health.tsx:135-140 STATUS_ACCENT; :142-155 statusSub
// disambiguates the four things "degraded" means.
const statusRows = [
  {
    key: "healthy",
    cells: [
      <GuideBadge key="s" accent="emerald">
        Healthy
      </GuideBadge>,
      "The ingestion loop ticked successfully and is not behind.",
    ],
  },
  {
    key: "starting",
    cells: [
      <GuideBadge key="s" accent="amber">
        Starting
      </GuideBadge>,
      "The service came up and has not completed a tick yet. Wait before acting.",
    ],
  },
  {
    key: "standby",
    cells: [
      <GuideBadge key="s" accent="blue">
        Standby
      </GuideBadge>,
      "This replica is a follower. Not a fault — another instance holds the lead.",
    ],
  },
  {
    key: "degraded",
    cells: [
      <GuideBadge key="s" accent="rose">
        Degraded
      </GuideBadge>,
      "Four different conditions share this word. Read the line under it: ticks are failing, signups queued for recovery, cursor is behind new signups, or no recent successful tick. Only the first and last are faults.",
    ],
  },
] as const;

export default async function AntifraudTroubleshootingGuidePage() {
  await requireAntifraudPageAccess();

  return (
    <GuidePage
      eyebrow="Guide"
      title="When something looks broken"
      intro="Most antifraud outages are quiet. The queue simply stops filling, or a save fails while every dashboard stays green. This page covers the failure modes that do not announce themselves, and the two states with no way out from the panel."
    >
      <GuideSection
        icon={Activity}
        title="Start at Settings → Engine health"
        description="It reports the monitor's own runtime state: the ingestion loop, the alert families, and the fiat eligibility gate."
      >
        <GuideTable columns={["Status", "What it means"]} rows={statusRows} />
        <GuideBullets
          items={[
            "The counters below the tiles are where the real diagnosis is: last tick started and completed, skipped ticks, signups processed, recovered and pending recovery, and the signup cursor lag.",
            "Cases stopped arriving but the loop looks fine? Check pending recovery and cursor lag before assuming a quiet day — provider outages park signups in the dead letter without opening anything.",
            "If the panel says the monitor reports no health at all, the service is not configured for this environment. That is a different problem from a failing one.",
          ]}
        />
      </GuideSection>

      <GuideSection
        icon={Plug}
        title="A half-configured integration is a dead integration"
        description="Several integrations need a URL and a credential together. Setting only one half is worse than setting neither, because it looks deliberate."
      >
        <GuideCallout icon={TriangleAlert} tone="warning" title="Amber means dead, not degraded">
          <GuideBadge accent="amber">Half-configured</GuideBadge> renders amber
          on the Integrations panel and never green. Both halves are required —
          with one missing the integration does nothing at all. The panel names
          the missing variable for you.
        </GuideCallout>
        <GuideBullets
          accent="amber"
          items={[
            "Monitor API — URL plus read token. Missing either and the Live events and Rules & Scoring pages read nothing.",
            "Signed ingest — the dashboard receiver's secret plus the monitor's sender configuration. Incomplete on either side and durable delivery is not working end to end.",
            "Monitor live transport — Redis, both tokens and the exact allowed origins.",
            "Unavailable renders the same amber as half-configured. It means the monitor did not answer, not that a variable is missing.",
          ]}
        />
      </GuideSection>

      <GuideSection
        icon={KeyRound}
        title="Everything green, every save fails"
        description="This one wastes the most time, so it is worth knowing before it happens."
      >
        <GuideBullets
          accent="rose"
          items={[
            "Reads and writes use two different monitor tokens. The read token covers reads only; the admin token covers both.",
            "Engine health and the Integrations panel only ever check the read token. A missing or wrong admin token is invisible to both.",
            "The symptom is specific: every page loads correctly, and every attempt to add a blocklist rule, an email domain or a settings change fails with the monitor rejecting the credentials.",
            "If you can see data but cannot save anything, check the admin token. Do not go looking for a broken feature.",
          ]}
        />
      </GuideSection>

      <GuideSection
        icon={Siren}
        title="Containment is asynchronous"
        description="The lock does not land inside the request that decided on it."
      >
        <GuideBullets
          items={[
            "The first attempt runs immediately after the decision commits, outside the transaction — so it usually lands within the same second.",
            "If it fails, a durable outbox retries it on a cron sweep. The lock can arrive noticeably later.",
            "After twenty attempts the row is left failed for manual investigation. It stops retrying, and nothing surfaces it in the antifraud queues.",
            "So an account that a containing decision should have locked, and has not, is worth one refresh before it is worth an incident.",
          ]}
        />
      </GuideSection>

      <GuideSection
        icon={Webhook}
        title="An enabled Discord alert with no route is a silent failure"
        description="The one failure mode where every indicator lies."
      >
        <GuideBullets
          accent="rose"
          items={[
            "Enqueueing an alert is a database join against the configured routes. No matching enabled route means zero rows inserted — and that is not treated as an error.",
            "The API answers 200 with a success body, so the monitor records the alert as delivered, resets its failure counter and never trips its circuit breaker.",
            "Engine health still shows the alert family as Configured, because that badge only checks environment variables — never whether a route exists.",
            "Net effect: nothing is logged, nothing is red, and no alert is ever sent.",
          ]}
        />
        <GuideCallout icon={Webhook} tone="warning">
          The only place that tells you the truth is Discord routing, which
          shows which channels actually have an enabled route for an enabled
          event. If a family has gone quiet, check there — not Engine health.
          The same silence applies when the target channel loses view, send or
          embed permission.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={AlertTriangle}
        title="A stalled fiat-access rollout is recoverable"
        description="Stalled means at least one account is in retry backoff. The monitor retries with no attempt ceiling, so a single permanently-failing user used to wedge existing-account fiat policy forever."
      >
        <GuideBullets
          accent="amber"
          items={[
            "Only a queued or running rollout locks the switches now. A stalled one leaves them usable.",
            "Confirming a new rollout supersedes the stalled one and cancels its outstanding retries — the confirm dialog says so explicitly when that is what you are about to do.",
            "There is still no cancel or force-complete button. Running the rollout you actually want is the recovery, and it is the intended one.",
            "A refusal now comes back as a real operator message rather than an opaque failure.",
          ]}
        />
        <GuideCallout icon={AlertTriangle} tone="warning">
          The existing-accounts rollout is durable and per-user. It cannot be
          undone by cancelling — only by running the opposite rollout
          afterwards. Read the confirm dialog: it names the direction and
          states plainly whether it grants or revokes access for the entire
          existing account base.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={AlertTriangle}
        title="The one dead end with no way out from the panel"
        description="Recoverable, but not by anything you can click."
      >
        <GuideSubHeading
          title="A refund item stuck on unknown"
          hint="It means the refund request may or may not have reached Whop — the money may already have moved."
        />
        <GuideBullets
          accent="rose"
          items={[
            "The claim query only picks up pending items and expired leases, and the item's lease was cleared. Nothing will ever retry it.",
            "It cannot be re-queued either: a payment already carrying an item row is dropped from every future candidate list.",
            "The batch still closes, permanently marked completed with issues. The row renders as a badge inside a read-only block with no action on it.",
            "The fix is outside the panel: reconcile the payment at Whop.",
          ]}
        />
      </GuideSection>
    </GuidePage>
  );
}
