import {
  AlertTriangle,
  Ban,
  Infinity as InfinityIcon,
  MailWarning,
  Network,
  ShieldOff,
  Undo2,
} from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import {
  GuideBadge,
  GuideBullets,
  GuideCallout,
  GuidePage,
  GuideSection,
  GuideSteps,
  GuideSubHeading,
  GuideTable,
  type GuideStep,
} from "../_components/guide-primitives";

export const metadata = { title: "Blacklists & Bans Guide · Antifraud" };

/**
 * Sources: services/antifraud-monitor/src/{identifier-blocklists.ts,
 * identifier-blocklist-routes.ts,fiat-email-domains.ts},
 * src/lib/antifraud/{identifier-blocklists-api.ts,user-identifier-blocking.ts},
 * src/app/(antifraud)/antifraud/{_components/identifier-blocklist-*,
 * email-blacklist/*,banned-users/actions.ts}. Citations inline.
 */

// identifier-blocklists.ts:6-7 — effect is "block" | "known_vpn";
// :89 recorded action `match.effect === "block" ? "lock_review" : "no_action"`;
// :97-108 known_vpn emits 15 points, :109-119 block emits 100.
// known_vpn is IP-only: identifier-blocklist-routes.ts:414-417.
const effectRows = [
  {
    key: "block",
    cells: [
      <GuideBadge key="e" accent="rose">
        Blocking
      </GuideBadge>,
      "100 points — a hard policy, so the score is forced to 100",
      "Withdrawal lock plus a staff review",
    ],
  },
  {
    key: "known_vpn",
    cells: [
      <GuideBadge key="e" accent="amber">
        Known VPN
      </GuideBadge>,
      "15 points",
      "Nothing. It raises risk and never directly locks, bans or opens a review.",
    ],
  },
] as const;

// banned-users/actions.ts:48-67 — blockKnownUserIdentifiers is awaited BEFORE
// the `UPDATE "user" SET is_banned=TRUE`. user-identifier-blocking.ts:71-78
// throws when the monitor is unconfigured or unreadable; :120-133 keeps writes
// fail-closed. banned-users/actions.ts:140 rethrows, so no ban is written.
const banSteps: readonly GuideStep[] = [
  {
    title: "Every known identifier is blocked first",
    detail:
      "The account's signup IP, every IP it was ever fingerprinted on, and every fingerprint visitor id — all added permanently to the lists.",
  },
  {
    title: "Only then is the account banned",
    detail: "The ban is written and every session is deleted.",
  },
  {
    title: "If the identifiers cannot be blocked, nothing happens at all",
    detail:
      "An unreachable or unconfigured monitor makes the whole action throw before anything is written. The ban is never applied on partial information.",
  },
  {
    title: "If the ban itself fails, the identifier blocks stay",
    detail:
      "Identifier blocking runs outside the ban transaction, so it is not rolled back with it. The error message tells you when that happened, and a durable partial-failure event is recorded.",
  },
];

export default async function AntifraudBlacklistsGuidePage() {
  await requireAntifraudPageAccess();

  return (
    <GuidePage
      eyebrow="Guide"
      title="Blacklists and bans"
      intro="Four lists — email domains, IPs, fingerprints and banned users — and one thing they all have in common: every entry is permanent. Nothing on these pages expires and nothing can be deleted. Add carefully."
    >
      <GuideSection
        icon={Network}
        title="Blocking versus known VPN"
        description="An IP rule has two effects and they behave completely differently at decision time. Fingerprint rules only ever block — the known-VPN effect is rejected for them."
      >
        <GuideTable
          columns={["Effect", "Score contribution", "What it triggers"]}
          rows={effectRows}
        />
        <GuideCallout icon={Network} tone="note">
          Known VPN is the right call for a public commercial VPN that real
          customers use. It keeps the risk visible without punishing everyone
          behind that exit node. Moving a rule between the two effects is a
          one-click change on the IP page, in both directions.
        </GuideCallout>
        <GuideBullets
          items={[
            "A known-VPN rule survives a ban. If a user behind a downgraded VPN is later banned, that IP stays non-blocking on purpose.",
            "A range rule cannot be wider than /8 for IPv4 or /32 for IPv6. Anything broader is rejected — a near-zero prefix would match every signup and put the entire player base under a withdrawal lock and staff review.",
          ]}
        />
      </GuideSection>

      <GuideSection
        icon={InfinityIcon}
        title="Entries are permanent, and there is no delete"
        description="The underlying API accepts an expiry field, but no page in the panel ever sends one — every rule is created permanent, deliberately."
      >
        <GuideBullets
          accent="amber"
          items={[
            "There is no expiry input anywhere in the panel, and no date picker to find.",
            "There is no delete on any list — not in the UI, not in the API. The routes are list, create and update; no removal endpoint exists.",
            "The closest thing is Disable, which flips a flag and keeps the row, its reason and its history. Reactivate turns it back on.",
            "A ban also repairs rules: if a matching entry is found disabled or carrying an expiry, blocking re-enables it and strips the expiry.",
          ]}
        />
        <GuideCallout icon={AlertTriangle} tone="warning">
          Disabling is the only way back, and it is one entry at a time. Adding
          a broad rule that turns out to be wrong is an entry-by-entry cleanup,
          so prefer a narrow rule you are sure of.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={MailWarning}
        title="Adding a rule does not act on existing accounts"
        description="This applies to email domains, IPs and fingerprints alike, and it is the single most common wrong expectation about these pages."
      >
        <GuideBullets
          accent="cyan"
          items={[
            "New signups and new Whop checkout emails that match a blocked domain are banned automatically and sent to staff review.",
            "Accounts that already matched before you added the rule are backfilled for review only. They are surfaced with an explicit note that no automatic account action was taken, and no lock is ever queued for them.",
            "Same for IP and fingerprint rules — the confirmation prompt says so before you commit.",
          ]}
        />
        <GuideCallout icon={MailWarning} tone="note">
          So blocking a domain is not a purge. If you want the existing accounts
          actioned, you have to work the review-only matches yourself.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={Ban}
        title="What a ban actually does, in order"
        description="Banning from the panel is not just a flag on the user row."
      >
        <GuideSteps steps={banSteps} accent="rose" />
        <GuideSubHeading
          title="Fail-closed, on purpose"
          hint="The order exists so a ban can never leave the identifiers unblocked. Better a loud failure you can retry than a ban that quietly protects nothing."
        />
        <GuideBullets
          accent="amber"
          items={[
            "Banning and unbanning need the ban-users capability, not just antifraud access — the same gate the main user pages and the review quick actions use.",
            "A partial ban is worth checking after any ban error: shared identifiers may now be blocked for other accounts even though this one was never banned.",
          ]}
        />
      </GuideSection>

      <GuideSection
        icon={Undo2}
        title="Unban lifts none of it"
        description="The unban path is a single update on the user row and nothing else."
      >
        <GuideCallout icon={ShieldOff} tone="danger">
          Every IP and fingerprint the ban added stays blocked. There is no
          unblock function anywhere in the codebase — not in the API, not in the
          UI, not internally. The only way to lift them is to find each rule on
          the IP and fingerprint pages and disable it by hand.
        </GuideCallout>
        <GuideBullets
          items={[
            "It also does not release feature locks, restore balance, or undo anything a refund clawback did.",
            "The audit record makes the asymmetry visible: a ban logs how many identifiers it blocked, an unban logs no identifier changes because it makes none.",
            "Practical consequence: unbanning someone who was banned from a shared network may leave them unable to reach the site anyway. Check the IP list before promising a fix.",
          ]}
        />
      </GuideSection>
    </GuidePage>
  );
}
