import {
  AlertTriangle,
  Ban,
  BadgeCheck,
  CreditCard,
  Fingerprint,
  Gauge,
  ListChecks,
  Lock,
  Search,
  ShieldCheck,
  Users,
  Wallet,
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
  GuideSteps,
  GuideSubHeading,
  GuideTable,
  type GuideFact,
} from "../_components/guide-primitives";

export const metadata = { title: "Fiat Deposits Guide · Antifraud" };

/**
 * Sources: services/antifraud-monitor/src/{fiat-eligibility-policy.ts,
 * fiat-eligibility.ts,fiat-eligibility-routes.ts,fiat-deposit-identity-policy.ts,
 * fiat-observations.ts,fiat-risk.ts}, src/lib/antifraud/{fiat-credit-review.ts,
 * fiat-eligibility-containment.ts,fiat-identity-containment.ts},
 * src/app/(antifraud)/antifraud/fiat-deposits/*. Citations inline.
 */

// fiat-eligibility-policy.ts:29-30 AUTOMATIC_DENY_SCORE = 50, applied at :914.
// fiat-eligibility-policy.ts:46-47 MAX_TRUST_CREDIT = 30, granted only inside
// the `if (!blocked)` block at :896-906.
// Containment floor 70: src/lib/antifraud/fiat-eligibility-containment.ts:72.
// fiat-deposit-identity-policy.ts:26-29 — card changes are time-sensitive:
// withdrawal lock below 2h, review below 24h, watch-only afterwards.
const gateFacts: readonly GuideFact[] = [
  {
    icon: Gauge,
    label: "Deny floor",
    value: "50",
    detail: "At or above this the checkout is refused on score alone.",
    accent: "amber",
  },
  {
    icon: Lock,
    label: "Contain floor",
    value: "70",
    detail: "Higher than the deny floor. Most denials restrict nothing.",
    accent: "rose",
  },
  {
    icon: ShieldCheck,
    label: "Trust credit cap",
    value: "30",
    detail: "All good-history credits combined, and only for a clean request.",
    accent: "emerald",
  },
  {
    icon: CreditCard,
    label: "Card-change clock",
    value: "2h / 24h",
    detail: "Lock below 2h, review below 24h, watch after one day.",
    accent: "cyan",
  },
];

// fiat-eligibility-policy.ts:473-521 — the six account checks, each
// `points: 100, blocking: true, source: "account"`. Header comment at :470-472
// explains why they deny but never contain.
const accountBlockers = [
  "Account banned",
  "Account locked",
  "Account self-excluded",
  "Fiat deposits disabled for this user",
  "Fiat deposits disabled for the country",
  "A required KYC is not cleared",
] as const;

// fiat-eligibility-policy.ts:525-529 (stale_request vs MAX_REQUEST_AGE_MS),
// :539-555 (fingerprint + proxycheck are mandatory; unavailable = deny),
// :574-607 (linked-ID mismatch/missing, IP mismatch, stale/replayed event),
// :708 recent_login_identity_mismatch, :744 repeat_fiat_within_sixty_seconds,
// :654 disposable_email_domain_match, :633-644 blocklist matches.
const requestBlockers = [
  "The request or the fingerprint event is too old, or dated in the future beyond the tolerated clock skew",
  "The fingerprint event was replayed, or its linked identity does not match the account",
  "The fingerprint event's IP does not match the request IP",
  "The fingerprint provider or the IP reputation provider could not be reached — both are mandatory, so an outage denies rather than waves through",
  "The checkout identity does not match a recent login, and reputation is bad",
  "A second checkout within sixty seconds of a paid deposit",
  "A disposable email domain, or a hit on the IP, fingerprint or email-domain blocklist",
] as const;

// fiat-deposit-identity-policy.ts (no baseline = no drift rules; email review;
// time-sensitive card handling; IP/device pairing),
// :23 "Missing evidence never contains."
const driftRows = [
  {
    key: "email",
    cells: [
      "Checkout email changed",
      <GuideBadge key="e" accent="amber">
        Review
      </GuideBadge>,
      "A different payer email opens staff review. It never locks the account or requires KYC by itself.",
    ],
  },
  {
    key: "card",
    cells: [
      "Card changed (brand + last four)",
      <GuideBadge key="e" accent="amber">
        Time-based
      </GuideBadge>,
      "Within 2 hours: lock withdrawals and review. From 2–24 hours: review only. After 24 hours: watch only.",
    ],
  },
  {
    key: "ipdevice",
    cells: [
      "IP and device both changed",
      <GuideBadge key="e" accent="rose">
        Contains
      </GuideBadge>,
      "Only when both moved together.",
    ],
  },
  {
    key: "ip",
    cells: [
      "IP changed alone",
      <GuideBadge key="e" accent="slate">
        Watch only
      </GuideBadge>,
      "A phone leaving wifi. Recorded, not acted on.",
    ],
  },
  {
    key: "device",
    cells: [
      "Device changed alone",
      <GuideBadge key="e" accent="slate">
        Watch only
      </GuideBadge>,
      "A laptop swapped for that phone. Recorded, not acted on.",
    ],
  },
] as const;

const postPaymentActionRows = [
  {
    key: "review",
    cells: [
      "Email changed, catch-all or undeliverable; card changed within 2–24 hours",
      <GuideBadge key="r" accent="amber">Review</GuideBadge>,
      "No automatic KYC and no automatic lock from this reason alone.",
    ],
  },
  {
    key: "withdrawals",
    cells: [
      "Card changed within 2 hours; blacklisted email domain; refunded-amount campaign",
      <GuideBadge key="w" accent="rose">Lock withdrawals</GuideBadge>,
      "Fiat access stays unchanged unless another rule also locks it.",
    ],
  },
  {
    key: "all-money",
    cells: [
      "IP and device both changed; checkout IP or device matches an active blocklist",
      <GuideBadge key="a" accent="rose">Lock Fiat + withdrawals</GuideBadge>,
      "The account remains usable, but its money rails are contained for staff review.",
    ],
  },
  {
    key: "watch",
    cells: [
      "IP alone, device alone, known VPN, card change after 24 hours, or missing evidence",
      <GuideBadge key="o" accent="slate">Watch only</GuideBadge>,
      "Stored as context. It does not lock, ban, or require KYC.",
    ],
  },
] as const;

// fiat-observations.ts:184-232 — six cross-account reuse rules, tiered by how
// exact the match is. Scored for staff only; nothing here locks or bans.
const reuseItems = [
  {
    term: "Whop customer, payment method",
    detail: "The most exact matches, and the heaviest scoring.",
  },
  {
    term: "Checkout device",
    detail: "Same browser fingerprint funding more than one account.",
  },
  {
    term: "Checkout email",
    detail: "Same email at Whop across accounts.",
  },
  {
    term: "Checkout IP",
    detail: "The weakest of the set — shared networks are ordinary.",
  },
  {
    term: "Card signature (brand + last four)",
    detail: "Deliberately weighted low; it is not a unique card identifier.",
  },
] as const;

export default async function AntifraudFiatDepositsGuidePage() {
  await requireAntifraudPageAccess();

  return (
    <GuidePage
      eyebrow="Staff playbook"
      title="How to review a Fiat deposit"
      intro="Start with the action already taken, then read the score and its strongest triggers. Approve only when the payment evidence is coherent; decline when the evidence points to another payer, coordinated abuse, or an unsafe payment. Decline is not a refund."
    >
      <GuideSection
        icon={ListChecks}
        title="The staff workflow"
        description="Use this order for every deposit. It prevents a high score, an automatic lock, or one unusual detail from being mistaken for a final verdict."
      >
        <GuideSteps
          accent="cyan"
          steps={[
            {
              title: "Read the current safeguards",
              detail: "Check whether the system only requested review, locked withdrawals, or locked Fiat plus withdrawals. A lock protects funds while you investigate; it is not proof of fraud.",
            },
            {
              title: "Read score → strongest triggers → missing evidence",
              detail: "The total tells you urgency. The trigger details explain why. Missing payer email, 3DS, IP/device history, or payment identity history lowers confidence and must stay visible.",
            },
            {
              title: "Compare the payment with the account",
              detail: "Look at checkout email, card brand and last four, 3DS, account age, previous Fiat history, and whether the identity is reused by other accounts.",
            },
            {
              title: "Approve or decline this payment",
              detail: "Approve credits only this deposit. Decline locks money movement and sends the charged-but-uncredited payment to Admin Deposits for a separate refund and/or ban decision.",
            },
          ]}
        />
        <GuideCallout icon={Search} tone="note" title="What deserves the closest look">
          A platform-wide same-amount cluster across distinct accounts and
          payment identities, a rapidly changed card, combined IP and device
          drift, a blocklist hit, failed 3DS, or several independent signals
          pointing in the same direction.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={Gauge}
        title="The numbers staff will see"
        description="A score prioritizes investigation. It does not replace the trigger details and it does not tell you whether an account was automatically locked."
      >
        <GuideFacts facts={gateFacts} />
      </GuideSection>

      <GuideSection
        icon={ShieldCheck}
        title="Before payment — can checkout open?"
        description="This gate runs before Whop receives money. A denial here means the player was not allowed to continue with this checkout attempt."
      >
        <GuideSubHeading
          title="Hard blockers — deny regardless of score"
          hint="Account state that is already correct. These deny but deliberately never contain: re-locking an account staff already handled would overwrite their reason and re-stamp the timestamps."
        />
        <GuideBullets accent="rose" items={accountBlockers} />

        <GuideSubHeading
          title="Request integrity — also deny regardless of score"
          hint="Evidence that the checkout request itself cannot be trusted."
        />
        <GuideBullets accent="orange" items={requestBlockers} />

        <GuideSubHeading
          title="Everything else is scored"
          hint="Account age, shared identity, velocity and provider risk add points. Clean established funding history can subtract points."
        />
        <GuideCallout icon={AlertTriangle} tone="warning" title="Credits are all-or-nothing">
          The credits are capped at 30 combined, and they are only granted when
          no blocking signal fired at all. One blocking signal discards the
          entire credit block — a long-standing customer gets no benefit of the
          doubt on a request that failed integrity.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={BadgeCheck}
        title="A pass cannot be reused"
        description="There is no allow that a client can hold on to and reuse."
      >
        <GuideBullets
          accent="cyan"
          items={[
            "The response carries only the decision id, whether it was allowed, and a timestamp. No validity window is returned, because there is nothing to return.",
            "A one-minute freshness value is stamped on the stored assessment row for our own bookkeeping. It is not a grant and it is never sent to the caller.",
            "A new checkout means a new fingerprint event, which means a new assessment. Replaying the same event with different parameters is rejected as a conflict.",
          ]}
        />
        <GuideCallout icon={AlertTriangle} tone="note">
          New checkout, new Fingerprint event, new decision.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={Lock}
        title="When the gate contains"
        description="Containment is a separate, stricter decision than denial — and it only ever happens in production."
      >
        <GuideBullets
          accent="rose"
          items={[
            "The score must be 70 or above, and the reason must be one the dashboard recognises as a containment reason. A denial at 55 restricts nothing.",
            "It locks fiat deposits, crypto withdrawals and item withdrawals.",
            "A hit on your email-domain blacklist is one of those reasons, so blocking a domain now restricts the account rather than only refusing the checkout.",
            "It never bans, never kills sessions, never sets the account-locked flag and never touches KYC. The account keeps working; its money rails do not.",
            "A repeat containment never overwrites the first reason or timestamp — so what you read is who locked it first, including a human.",
          ]}
        />
        <GuideCallout icon={AlertTriangle} tone="warning">
          Containment does not land inside the request. The first attempt runs
          immediately after the decision commits, and a failure is retried by a
          cron sweep. A lock can therefore appear a second later or several
          sweeps later — an account that looks unrestricted right after a
          containing decision is not necessarily a bug.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={Fingerprint}
        title="After payment — did the payer identity change?"
        description="After authorization, the system compares the payment with the immediately previous authorized Fiat deposit. The first deposit has no previous baseline, so drift rules cannot run yet. Absolute blocklist, email-reputation, and refunded-campaign rules can still run on the first deposit."
      >
        <GuideSubHeading
          title="Exact automatic action by trigger"
          hint="Use this when you need to know what the system already did before staff opened the review."
        />
        <GuideTable
          columns={["Trigger", "Automatic action", "Meaning"]}
          rows={postPaymentActionRows}
        />

        <GuideSubHeading title="How identity drift is timed" />
        <GuideTable
          columns={["What moved", "Result", "Detail"]}
          rows={driftRows}
        />
        <GuideCallout icon={Fingerprint} tone="note">
          Missing evidence never contains. If either side of a comparison is
          absent the rule cannot run, and it is recorded as missing evidence
          rather than treated as a match.
        </GuideCallout>

        <GuideCallout icon={BadgeCheck} tone="note" title="KYC is always a staff decision">
          No email change, card change, IP/device change, deliverability result,
          or deposit cluster automatically requires KYC. Staff may require KYC
          separately when the complete account evidence justifies it.
        </GuideCallout>

        <GuideSubHeading
          title="Cross-account and platform-wide clusters"
          hint="These checks run across deposits from all users, not only the current player's history. Reuse evidence raises the score and recommendation; it does not automatically require KYC."
        />
        <GuideDefList items={reuseItems} />
      </GuideSection>

      <GuideSection
        icon={Wallet}
        title="Staff decision — credit or contain"
        description="Deposit reviews puts the score, strongest triggers, missing evidence, identity facts, platform-wide cluster counts, and recommendation beside the decision. Expand All risk evidence before deciding a close case."
      >
        <GuideSubHeading
          title="Approve"
          hint="Three things happen, in one transaction."
        />
        <GuideBullets
          accent="emerald"
          items={[
            "A deposit row is written to the ledger, with the paired coin grant. This is the only point at which the money becomes balance.",
            "A wager requirement is added — by default the full deposit amount, overridable per site and per user.",
            "A deposit bonus is applied only if the account has a valid affiliate and is inside its bonus window. No affiliate, or an expired window, means no bonus. Staff and creator roles are excluded.",
          ]}
        />
        <GuideSubHeading
          title="Decline"
          hint="A refusal to credit, not a refund."
        />
        <GuideBullets
          accent="rose"
          items={[
            "Fiat deposits and all withdrawals are locked.",
            "The payment stays with Whop. No refund call is made anywhere on this path.",
            "The case moves to Admin → Deposits, where the refund or ban decision is made separately.",
          ]}
        />
        <GuideCallout icon={Ban} tone="danger">
          Declining leaves the player charged and uncredited. That state is only
          resolved by acting on it in Admin → Deposits — see the money-out
          guide.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={Users}
        title="Do not make these mistakes"
        description="These are the most common ways a correct signal becomes a wrong staff decision."
      >
        <GuideBullets
          items={[
            "Denied is not restricted. Most denials leave the account completely untouched.",
            "Contained is not banned and not automatically KYC-gated. Containment protects money rails while staff review the account.",
            "An assessment score is not a signup score. They are separate engines with separate versions, separate weights and separate thresholds.",
            "A shared IP is weak evidence on its own. A shared payment identity or a coordinated same-amount cluster across distinct users deserves more weight.",
            "Decline is not refund. Always resolve the charged payment afterwards in Admin Deposits.",
          ]}
        />
      </GuideSection>
    </GuidePage>
  );
}
