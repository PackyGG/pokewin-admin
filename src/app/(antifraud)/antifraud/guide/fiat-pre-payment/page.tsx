import {
  Fingerprint,
  Gauge,
  KeyRound,
  ShieldAlert,
  UserRoundCheck,
} from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import {
  GuideBadge,
  GuideBullets,
  GuideCallout,
  GuideFacts,
  GuidePage,
  GuideSection,
  GuideSteps,
  GuideTable,
  type GuideFact,
} from "../_components/guide-primitives";

export const metadata = { title: "Pre-Fiat Checks · Antifraud" };

/**
 * Sources: services/antifraud-monitor/src/{fiat-eligibility-routes.ts,
 * fiat-eligibility-auth.ts,fiat-eligibility.ts,fiat-eligibility-policy.ts}.
 * This page intentionally covers only the check before payment. The full Fiat
 * guide owns post-payment identity review, crediting, refunds, and staff work.
 */

const decisionFacts: readonly GuideFact[] = [
  {
    icon: Gauge,
    label: "Allow",
    value: "0–49",
    detail: "Only when no hard blocker fired.",
    accent: "emerald",
  },
  {
    icon: ShieldAlert,
    label: "Deny",
    value: "50+",
    detail: "The checkout does not open.",
    accent: "amber",
  },
  {
    icon: ShieldAlert,
    label: "Contain",
    value: "70+",
    detail: "Only for a recognised high-confidence containment reason.",
    accent: "rose",
  },
  {
    icon: UserRoundCheck,
    label: "Good-history credit",
    value: "Max −30",
    detail: "Granted only when the request has no hard blocker.",
    accent: "cyan",
  },
];

const immediateDenials = [
  "The account is banned, locked, self-excluded, blocked from Fiat, in a blocked country, or has required KYC that is not cleared.",
  "The request or Fingerprint event is stale, replayed, linked to another user, or the Fingerprint event IP does not match the submitted checkout IP.",
  "Fingerprint or proxycheck.io fails. Both are mandatory, so the check fails closed instead of guessing.",
  "An active IP, device, or email-domain blocklist matches; the email is disposable; or a new checkout follows a paid Fiat deposit within 60 seconds.",
  "The checkout IP and device both disagree with a recent verified login, or both changed and the new identity has bad reputation.",
] as const;

const scoreRows = [
  {
    key: "identity",
    cells: [
      "Checkout identity",
      "IP/device changes from signup and latest verified login, shared devices, and shared networks.",
    ],
  },
  {
    key: "providers",
    cells: [
      "Live provider evidence",
      "VPN, proxy, Tor, hosting, bot, tampering, automation, attack history, and device integrity signals.",
    ],
  },
  {
    key: "history",
    cells: [
      "Account history",
      "Account age, suspected-alt state, signup risk, active high-risk cases, repeated attempts, and previous denials.",
    ],
  },
  {
    key: "behaviour",
    cells: [
      "Funding and play",
      "Real crypto/Fiat funding and normal paid play can reduce risk; reward-heavy or funded-without-play behaviour can add risk.",
    ],
  },
] as const;

const outcomeRows = [
  {
    key: "allow",
    cells: [
      <GuideBadge key="allow" accent="emerald">Allow</GuideBadge>,
      "Returns a decision ID, allowed=true, and a timestamp. The checkout must use a fresh assessment; this is not a reusable pass.",
    ],
  },
  {
    key: "deny",
    cells: [
      <GuideBadge key="deny" accent="amber">Deny</GuideBadge>,
      "Stops this checkout. Most denials do not lock, ban, refund, or change KYC.",
    ],
  },
  {
    key: "contain",
    cells: [
      <GuideBadge key="contain" accent="rose">Deny + contain</GuideBadge>,
      "For recognised high-confidence reasons in production, it also queues Fiat and withdrawal locks for staff review.",
    ],
  },
] as const;

export default async function AntifraudFiatPrePaymentGuidePage() {
  await requireAntifraudPageAccess();

  return (
    <GuidePage
      eyebrow="Quick guide"
      title="What the pre-Fiat check actually does"
      intro="Before a player reaches payment, the backend sends one checkout attempt to Antifraud. Antifraud verifies the account, the live browser event, the customer IP, reputation, and account history, then returns allow or deny."
    >
      <GuideSection
        icon={KeyRound}
        title="What is sent"
        description="The check is server-to-server and uses the credential for the declared environment."
      >
        <GuideTable
          columns={["Input", "Purpose"]}
          rows={[
            {
              key: "required",
              cells: [
                "Required",
                "Environment, request time, customer checkout IP, fresh Fingerprint request ID, and user ID.",
              ],
            },
            {
              key: "optional",
              cells: [
                "Optional context",
                "Amount, currency, locale, and timezone. These help record patterns but do not authenticate the caller.",
              ],
            },
          ]}
        />
        <GuideCallout icon={KeyRound} tone="note" title="No caller-IP allowlist">
          The endpoint no longer checks which network IP the calling backend
          came from. It still requires the correct DEV or PROD Bearer key, and
          the key must match the environment in the request.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={Fingerprint}
        title="How the customer IP is checked"
        description="The IP in the request is the player's checkout IP, not the calling server's IP."
      >
        <GuideSteps
          accent="cyan"
          steps={[
            {
              title: "Bind the live browser event",
              detail: "Fingerprint must return a fresh event linked to this user. Its authoritative event IP must equal the checkout IP sent by the backend.",
            },
            {
              title: "Check independent IP reputation",
              detail: "proxycheck.io checks the same IP for proxy, VPN, Tor, hosting, abuse, and risk. Fingerprint and proxycheck.io are mandatory.",
            },
            {
              title: "Add a second opinion",
              detail: "Abstract IP Intelligence corroborates network risk. If it fails, the check adds risk but does not deny by itself.",
            },
            {
              title: "Compare known identities",
              detail: "The checkout IP and device are compared with signup and the latest verified login. One ordinary change is scored; stronger combined drift can deny or contain.",
            },
          ]}
        />
      </GuideSection>

      <GuideSection
        icon={ShieldAlert}
        title="What denies immediately"
        description="These are hard blockers. The score cannot rescue them."
      >
        <GuideBullets accent="rose" items={immediateDenials} />
      </GuideSection>

      <GuideSection
        icon={Gauge}
        title="How the score is built"
        description="If no hard blocker decided the result, risk signals add points and clean history can subtract a limited amount."
      >
        <GuideFacts facts={decisionFacts} />
        <GuideTable
          columns={["Area", "What it looks at"]}
          rows={scoreRows}
        />
        <GuideCallout icon={Gauge} tone="warning" title="A shared IP is not enough">
          Shared IP and cross-account reuse are context, not automatic proof of
          fraud. Strong action needs the total score or a specific hard rule.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={UserRoundCheck}
        title="What happens after the check"
        description="The response is deliberately small. Payment and post-payment review are separate stages."
      >
        <GuideTable
          columns={["Result", "Effect"]}
          rows={outcomeRows}
        />
        <GuideBullets
          items={[
            "Every new checkout runs a new assessment with a fresh Fingerprint event.",
            "An allow does not credit balance and a deny does not refund anything; no payment has happened yet.",
            "The stored assessment keeps the score and evidence so staff can see why the decision happened.",
          ]}
        />
      </GuideSection>
    </GuidePage>
  );
}
