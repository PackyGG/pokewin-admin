import {
  Activity,
  AlertTriangle,
  Ban,
  Bot,
  Gauge,
  Lock,
  PlugZap,
  Radar,
  ShieldAlert,
  Tags,
  TimerReset,
} from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import {
  GuideBadge,
  GuideBullets,
  GuideCallout,
  GuideDefList,
  GuideFacts,
  GuidePage,
  GuideSection,
  GuideSubHeading,
  GuideTable,
  type GuideFact,
} from "../_components/guide-primitives";

export const metadata = { title: "Signup Risk Guide · Antifraud" };

/**
 * Every number on this page is traced to a constant in this repo; the citation
 * sits next to the data it backs so it can be re-checked, not trusted.
 */

// Bands: services/antifraud-monitor/src/score-catalog.ts:254-259 (SEVERITY_BANDS)
// and the duplicate resolver profile-risk.ts:158-163.
// Badge text: src/lib/antifraud/constants.ts:67-72 (REVIEW_SEVERITY_LABELS)
// rendered by _components/badges.tsx:38.
// Monitor length: services/antifraud-monitor/src/signup-alerts.ts:21-26.
// Discord event key: monitor.ts:1612-1622; below 21 the alert kind is null
// (signup-alerts.ts:12-19) so nothing is sent at all.
const bandRows = [
  {
    key: "low",
    cells: [
      "0 – 20",
      <GuideBadge key="b" accent="slate">
        Low
      </GuideBadge>,
      "No risk",
      "None",
      "None",
      "None",
    ],
  },
  {
    key: "medium",
    cells: [
      "21 – 49",
      <GuideBadge key="b" accent="blue">
        Medium
      </GuideBadge>,
      "Low risk",
      "5 minutes",
      "Low-risk route",
      "None",
    ],
  },
  {
    key: "high",
    cells: [
      "50 – 69",
      <GuideBadge key="b" accent="amber">
        High
      </GuideBadge>,
      "High risk",
      "10 minutes",
      "High-risk route",
      "Account review",
    ],
  },
  {
    key: "critical",
    cells: [
      "70 – 100",
      <GuideBadge key="b" accent="rose">
        Critical
      </GuideBadge>,
      "Critical risk",
      "15 minutes",
      "Critical route",
      "Account review + containment",
    ],
  },
] as const;

// monitor.ts:2576 `const trustFloor = Math.max(0, session.initial_score - 30);`
// clamped in SQL at monitor.ts:2596; profile-risk.ts:263 applies the same −30 to
// assessment-time trust credit.
// Review floor: src/lib/antifraud/ws.ts:109-110 SIGNUP_REVIEW_SCORE_FLOOR = 50.
// Containment floor: profile-risk.ts:366-372 (`score >= 70 || priorityLock ||
// deterministicBan`) and the ingest admission check at
// src/app/api/antifraud/ingest/route.ts:712-722.
// ends_at is written once on INSERT (monitor.ts:2416-2431) and no UPDATE in the
// service ever touches it.
const scoreFacts: readonly GuideFact[] = [
  {
    icon: Gauge,
    label: "Review floor",
    value: "50",
    detail: "At or above this, a case is opened for a human. Below it, nobody is asked to look.",
    accent: "amber",
  },
  {
    icon: Lock,
    label: "Containment floor",
    value: "70",
    detail: "The only score band that automatically restricts the account.",
    accent: "rose",
  },
  {
    icon: TimerReset,
    label: "Trust floor",
    value: "start − 30",
    detail: "Good behaviour during the window can pull the score down by 30 points, never more.",
    accent: "emerald",
  },
  {
    icon: Radar,
    label: "Deadline",
    value: "Fixed",
    detail: "Set once when the window opens. Nothing that happens afterwards moves it.",
    accent: "cyan",
  },
];

// profile-risk.ts:95-108 CONTAINMENT_POLICIES — these pin the score to 100
// (:345-348 `containmentMatches`) and drive the lock branch at :433.
// deterministicBan :405-407; priorityLock :411-422.
const containmentPolicyItems = [
  {
    term: "Email — catch-all domain, blacklisted domain",
    detail:
      "A first-seen catch-all gets full temporary locks and staff review. A domain staff already confirmed and blacklisted automatically bans the account.",
  },
  {
    term: "Blocklist hit — IP, fingerprint",
    detail: "The identifier is already on one of our lists.",
  },
  {
    term: "Clustering — third account on one fingerprint or exact IP in 30 days",
    detail: "Counted over a rolling 30-day window.",
  },
  {
    term: "Fingerprint — replayed event, linked-ID mismatch",
    detail: "Evidence the client is not who it claims to be.",
  },
  {
    term: "Funding — active use of restricted downstream funds",
    detail:
      "Money received from an account that is itself banned, locked, suspected alt, or KYC-gated.",
  },
  {
    term: "Promotions — third promo redemption on a fresh account",
    detail: "Redemption farming inside the first minutes of the account's life.",
  },
] as const;

// profile-risk.ts:109-121 EVIDENCE_POLICIES + the comment at :109-115.
// Weights read from score-catalog.ts:26 (bad bot 80), :29 + :60 (Tor 65),
// :35 (confirmed VM 25). They land in `policyMatches`, so the outcome is
// review_required (:398-403), but they are excluded from `containmentMatches`
// so they neither pin the score nor set priorityLock.
const evidencePolicyRows = [
  {
    key: "badbot",
    cells: [
      "Automation / bad bot",
      "80",
      "Scores above the containment floor on its own, so in practice it still locks.",
    ],
  },
  {
    key: "tor",
    cells: [
      "Tor exit node",
      "65",
      "Above the review floor, below the containment floor. Reviewed, not locked, unless something else adds points.",
    ],
  },
  {
    key: "vm",
    cells: [
      "Confirmed virtual machine",
      "25",
      "Barely moves the score by itself. It still forces the review outcome, but it will not lock anything.",
    ],
  },
] as const;

export default async function AntifraudSignupGuidePage() {
  await requireAntifraudPageAccess();

  return (
    <GuidePage
      eyebrow="Guide"
      title="Signup risk and the monitor window"
      intro="Every new account is scored once at signup. That single number decides whether anyone is told, whether a case is opened, whether the account is restricted, and how long we watch it. Nothing about that decision is revisited later — only the score moves."
    >
      <GuideSection
        icon={Tags}
        title="The four bands"
        description="One score, two vocabularies. The scoring catalog has its own band names, the badge in the UI shows the severity key. They do not match, and the mismatch is the single most common source of confusion when reading a case."
      >
        <GuideTable
          columns={[
            "Score",
            "Badge you see",
            "Name in scoring",
            "Monitor",
            "Discord",
            "Action",
          ]}
          rows={bandRows}
        />
        <GuideCallout icon={AlertTriangle} tone="warning" title="Read the badge, not the name">
          A signup that scored 30 is filed as{" "}
          <GuideBadge accent="blue">Medium</GuideBadge> everywhere in the panel,
          even though the scoring page calls that band &ldquo;Low risk&rdquo;.
          Likewise a 10 shows as <GuideBadge accent="slate">Low</GuideBadge>,
          not &ldquo;No risk&rdquo;. Same score, two words — the badge is what
          filters and queues actually use.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={Gauge}
        title="The four numbers that matter"
        description="Everything else in signup scoring is a weight you can tune. These four are structural."
      >
        <GuideFacts facts={scoreFacts} />
      </GuideSection>

      <GuideSection
        icon={Radar}
        title="The monitor window"
        description="A score of 21 or more opens one watch window, timed from the signup. It exists to catch what the account does in its first minutes, when a farmed account behaves nothing like a real one."
      >
        <GuideSubHeading
          title="The length is decided once, at the moment it opens"
          hint="The band sets the base — 5, 10 or 15 minutes. Two things can make it longer, and both apply before the window starts."
        />
        <GuideBullets
          accent="cyan"
          items={[
            "A hard policy hit, or any critical score, forces at least 15 minutes.",
            "A risky-location policy for the signup country can specify a longer window; the longer of the two wins.",
          ]}
        />
        <GuideCallout icon={TimerReset} tone="note" title="It never extends">
          The deadline is written when the session is created and no code path
          updates it afterwards. New activity raises the score; a second signup
          event for the same account raises the score. Neither moves the clock.
          If you see a flow described as &ldquo;extend the live monitor
          window&rdquo;, that only affects the length chosen at open time.
        </GuideCallout>

        <GuideSubHeading
          title="What the score does during the window"
          hint="Most tracked activity is trust-building, so the usual direction of travel is down."
        />
        <GuideBullets
          items={[
            "A crypto deposit is the strongest positive signal. Paid pack opens, battle bets and normal reward claims also pull the score down.",
            "Only two activity types add risk by default: session hopping and a dormant device switch.",
            "Every event is recorded once. A replayed batch or a second service replica cannot double-count it.",
            "Reward-enrollment rows created by signup itself are dropped, not scored — they are plumbing, not player behaviour.",
            "The case severity follows the live score and can drop back down. The peak score never does — that is what to read when a case looks calm but was not.",
          ]}
        />
      </GuideSection>

      <GuideSection
        icon={ShieldAlert}
        title="Containment policies — the signals that force 100"
        description="These bypass the weights entirely. If one of them matches, the score is 100 no matter what the rest of the evidence says, the monitor runs the full 15 minutes, and the account is contained. The underlying fact is binary, not a judgement call."
      >
        <GuideDefList items={containmentPolicyItems} />
        <GuideCallout icon={Ban} tone="note">
          Two of them go further than containment: a catch-all email and a
          blacklisted email domain both mark the account for an automatic ban.
          The rest lock it and ask for a review.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={Bot}
        title="Privacy and automation evidence is no longer a hard policy"
        description="Tor, confirmed virtual machines and automation used to pin the score to 100 and lock withdrawals like any other hard policy. They no longer do — a Tor exit node or a VM at signup is a large false-positive surface among ordinary privacy-tool users."
      >
        <GuideTable
          columns={["Signal", "Points", "What that means in practice"]}
          rows={evidencePolicyRows}
        />
        <GuideCallout icon={AlertTriangle} tone="note">
          They are still recorded as a policy match and still force the
          review outcome. What changed is that the configured weight now
          actually governs the score — so these are tunable from Rules &amp;
          Scoring, and setting a weight to zero genuinely disables its effect.
          A Tor signup that used to arrive locked at 100 now arrives at 65:
          reviewed, not contained.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={Lock}
        title="What containment at 70 actually locks"
        description="Only the critical-signup path applies the full set, and only in production. The account keeps working — it just cannot move money."
      >
        <GuideBullets
          accent="rose"
          items={[
            "Fiat deposits",
            "Crypto withdrawals",
            "Item withdrawals",
            "Tip rewards",
          ]}
        />
        <GuideCallout icon={AlertTriangle} tone="warning">
          The other containment paths lock less. Behavioural containment, risky
          free-battle containment and blocklist containment lock crypto and item
          withdrawals only — no fiat-deposit block, no tips lock. If you are
          looking at a locked account and fiat deposits are still open, it was
          not the critical-signup path that locked it.
        </GuideCallout>
        <GuideBullets
          items={[
            "A re-delivered duplicate never re-applies containment — staff may have reviewed and unlocked the account in between, and re-locking would erase that.",
          ]}
        />
      </GuideSection>

      <GuideSection
        icon={PlugZap}
        title="When a provider is down, the signup is not scored"
        description="Fingerprint and IP reputation are mandatory. If either of those, or any other enrichment provider, fails while a signup is being assessed, the assessment is abandoned rather than completed on partial evidence."
      >
        <GuideBullets
          accent="amber"
          items={[
            "A partial assessment row is still written, marked incomplete — so the signup is visible, but it has no band you should act on.",
            "No case, no monitor session, no Discord alert and no review are created. A silent gap in the queue during an outage is this, not a quiet day.",
            "The signup lands in the ingestion dead letter and retries every 60 seconds. Provider failures retry forever; other failures give up after five attempts.",
            "The ingestion cursor still advances, so one bad signup never blocks the stream behind it.",
            "One exception: a confirmed catch-all email is contained before the assessment is abandoned, so an unrelated outage cannot delay it.",
          ]}
        />
      </GuideSection>

      <GuideSection
        icon={Activity}
        title="What happens at the end"
        description="At the deadline the session closes on whatever the score is at that moment. There is no second decision."
      >
        <GuideBullets
          items={[
            "The entry band already decided the alert, the review and the locks. A score that fell during the window does not undo any of them.",
            "Clearing a case is a human action on Account reviews — it is the only thing that lifts a signup lock.",
          ]}
        />
      </GuideSection>
    </GuidePage>
  );
}
