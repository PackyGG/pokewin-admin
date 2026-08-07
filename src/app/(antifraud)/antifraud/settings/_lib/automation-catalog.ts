import type { LucideIcon } from "lucide-react";
import {
  Ban,
  Banknote,
  BellRing,
  CircleAlert,
  Fingerprint,
  KeyRound,
  ListChecks,
  MapPinned,
  Network,
  RefreshCw,
  ScanSearch,
  ShieldAlert,
} from "lucide-react";

type AutomationLink = {
  label: string;
  href: string;
};

export type AutomationFlow = {
  name: string;
  scope: string;
  trigger: string;
  actions: string[];
  discordEvents: string[];
  controls: AutomationLink[];
  mode: "editable" | "mixed" | "fixed";
  icon: LucideIcon;
};

/**
 * The operator-facing map of built-in Antifraud behavior. Dynamic point flows
 * and Discord routes are appended from their live stores by the page. Keep
 * this list focused on code-owned detectors and response rails so operators
 * can tell which safety behavior is editable and which needs a code release.
 */
export const AUTOMATION_FLOWS: AutomationFlow[] = [
  {
    name: "Signup assessment",
    scope: "Every compatible new account",
    trigger:
      "Internal identity checks and all configured signup providers produce a bounded 0–100 risk assessment.",
    actions: [
      "Persist the score and provider evidence",
      "Open or update Account Review at the review threshold",
      "At critical risk, lock Fiat deposits, withdrawals, and tips",
    ],
    discordEvents: [
      "antifraud.signup_low_risk",
      "antifraud.signup_high",
      "antifraud.signup_critical",
    ],
    controls: [
      { label: "Edit risk points", href: "/antifraud/settings?tab=scoring" },
      { label: "Provider status", href: "/antifraud/settings?tab=integrations" },
      { label: "Review queue", href: "/antifraud/reviews" },
    ],
    mode: "mixed",
    icon: ScanSearch,
  },
  {
    name: "Live behavior and point flows",
    scope: "Accepted events during an active monitor window",
    trigger:
      "Ordered event sequences match inside their configured time window, with optional exclusion events.",
    actions: [
      "Add or subtract the configured points",
      "Send the account to manual review",
      "Store immutable flow-match evidence on the case",
    ],
    discordEvents: ["antifraud.rule_matched"],
    controls: [
      { label: "Edit point flows", href: "/antifraud/settings?tab=flows" },
      { label: "Browse event sources", href: "/antifraud/settings?tab=events" },
    ],
    mode: "editable",
    icon: ListChecks,
  },
  {
    name: "Free and sponsored battle abuse",
    scope: "Global continuous battle-participant scan",
    trigger:
      "Distinct sponsored joins correlate with creator risk, fraud KYC, suspected-alt, and connected-account evidence.",
    actions: [
      "Keep the first qualifying battle as evidence",
      "Lock withdrawals and item shipping after two qualifying battles",
      "Open Account Review without automatically requiring KYC",
    ],
    discordEvents: ["antifraud.rule_matched"],
    controls: [
      { label: "Review cases", href: "/antifraud/reviews" },
      { label: "Edit related point flows", href: "/antifraud/settings?tab=flows" },
    ],
    mode: "mixed",
    icon: Network,
  },
  {
    name: "Email containment",
    scope: "New signups and Whop checkouts",
    trigger:
      "An email matches an enabled exact-domain rule or the confirmed suspicious checkout-cluster policy.",
    actions: [
      "Persist the source-specific match",
      "Apply the signed account containment command",
      "Ban confirmed blocked-domain accounts and open review",
    ],
    discordEvents: ["antifraud.email_blacklist"],
    controls: [
      { label: "Edit blocked domains", href: "/antifraud/email-blacklist" },
      { label: "Review contained accounts", href: "/antifraud/reviews" },
    ],
    mode: "mixed",
    icon: Ban,
  },
  {
    name: "IP and fingerprint policy",
    scope: "Signup, Fiat checks, and staff ban actions",
    trigger:
      "An exact IP, CIDR, or Fingerprint visitor ID matches an enabled operator rule.",
    actions: [
      "Hard blocks contain the account and open review",
      "Known VPN rules add bounded risk without direct containment",
      "Single-account bans permanently save all known identifiers first",
    ],
    discordEvents: [
      "antifraud.signup_high",
      "antifraud.signup_critical",
      "antifraud.fiat_risk",
    ],
    controls: [
      { label: "Edit IP rules", href: "/antifraud/ip-blacklist" },
      {
        label: "Edit fingerprint rules",
        href: "/antifraud/fingerprint-blacklist",
      },
      { label: "Manage banned users", href: "/antifraud/banned-users" },
    ],
    mode: "editable",
    icon: Fingerprint,
  },
  {
    name: "Risky signup locations",
    scope: "New signups from configured countries",
    trigger:
      "The signup country matches an enabled location rule during its configured monitoring duration.",
    actions: [
      "Add the configured bounded risk weight",
      "Extend the live monitor window",
      "Never contain, ban, or require KYC from country evidence alone",
    ],
    discordEvents: [
      "antifraud.signup_high",
      "antifraud.signup_critical",
    ],
    controls: [
      { label: "Edit location rules", href: "/antifraud/risky-locations" },
    ],
    mode: "editable",
    icon: MapPinned,
  },
  {
    name: "Fiat payment risk and operations",
    scope: "Whop payment lifecycle and MAIN reconciliation",
    trigger:
      "A payment is risky, locked, failed, delayed, disputed, refunded, or paid without completed reconciliation.",
    actions: [
      "Persist a versioned Fiat assessment",
      "Route risky accounts into review",
      "Keep financial and operational failures separate",
    ],
    discordEvents: ["antifraud.fiat_risk", "antifraud.fiat_operations"],
    controls: [
      { label: "Open deposit queue", href: "/antifraud/fiat-deposits" },
      { label: "Edit risk points", href: "/antifraud/settings?tab=scoring" },
      { label: "Refund operations", href: "/antifraud/refunds" },
    ],
    mode: "mixed",
    icon: Banknote,
  },
  {
    name: "Automatic Fiat eligibility",
    scope: "Every backend checkout eligibility request",
    trigger:
      "The environment-bound gate evaluates account state, current device/network evidence, risk policy, and the master switch.",
    actions: [
      "Return a short-lived allow or deny decision",
      "Persist the full internal decision evidence",
      "Queue containment only for explicit containing rules",
    ],
    discordEvents: [],
    controls: [
      { label: "Inspect decision policy", href: "/antifraud/fiat-eligibility" },
      { label: "Global Fiat controls", href: "/antifraud/config" },
    ],
    mode: "mixed",
    icon: KeyRound,
  },
  {
    name: "Automatic withdrawal hold",
    scope: "Lifetime Fiat threshold state",
    trigger:
      "The monitor observes the backend-owned automatic lifetime-deposit withdrawal lock on the read-only mirror.",
    actions: [
      "Persist a high-severity risk event",
      "Open or update Account Review",
      "Keep the backend lock authoritative",
    ],
    discordEvents: ["antifraud.withdrawal_hold"],
    controls: [{ label: "Review held accounts", href: "/antifraud/reviews" }],
    mode: "fixed",
    icon: ShieldAlert,
  },
  {
    name: "KYC and Sumsub lifecycle",
    scope: "Staff-requested KYC cycles",
    trigger:
      "A manager starts KYC for an eligible locked account, or Sumsub reports a provider lifecycle change.",
    actions: [
      "Track active and completed KYC evidence",
      "Move Account Review into or out of Waiting KYC",
      "Notify when a review starts or becomes ready",
    ],
    discordEvents: ["antifraud.sumsub_started", "antifraud.sumsub_ready"],
    controls: [
      { label: "Open KYC queue", href: "/antifraud/kyc" },
      { label: "Review account cases", href: "/antifraud/reviews" },
    ],
    mode: "mixed",
    icon: RefreshCw,
  },
  {
    name: "Review operations and reminders",
    scope: "Open Account Review cases",
    trigger:
      "A case opens, changes containment state, is postponed, or reaches its reminder cadence.",
    actions: [
      "Assign, postpone, resolve, or record analyst notes",
      "Fine, ban, lock or unlock withdrawals, and require KYC when eligible",
      "Send durable review and account-action notifications",
    ],
    discordEvents: [
      "antifraud.review_reminder",
      "antifraud.account_banned",
      "antifraud.account_locked",
      "antifraud.kyc_required",
    ],
    controls: [
      { label: "Operate review queue", href: "/antifraud/reviews" },
      { label: "Edit Discord routing", href: "/antifraud/discord" },
    ],
    mode: "mixed",
    icon: BellRing,
  },
  {
    name: "Error routing",
    scope: "Webapps, third-party APIs, Discord, and uncategorized operational failures",
    trigger:
      "A webapp or code path fails, a provider key or request fails, Discord has a problem, or an uncategorized operational error occurs.",
    actions: [
      "Route Admin, Marketing, Packs, and Fraud code errors to Webapp errors",
      "Keep provider timeouts and unexpected responses with Third-party API",
      "Keep Discord problems with Discord and use General only as the fallback",
    ],
    discordEvents: [
      "antifraud.error.third_party_api",
      "antifraud.error.discord_command",
      "antifraud.error.webapp",
      "antifraud.error.general",
    ],
    controls: [
      { label: "Edit error routing", href: "/antifraud/discord" },
      { label: "Inspect integrations", href: "/antifraud/settings?tab=integrations" },
    ],
    mode: "mixed",
    icon: CircleAlert,
  },
];
