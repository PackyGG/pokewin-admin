import {
  AlertTriangle,
  Ban,
  BellRing,
  CheckCircle2,
  Fingerprint,
  Inbox,
  ListChecks,
  Timer,
  UserCheck,
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

export const metadata = { title: "Account Review Guide · Antifraud" };

/**
 * Sources: src/app/(antifraud)/antifraud/reviews/{page.tsx,actions.ts} and its
 * _components/*, src/lib/antifraud/{reviews.ts,withdrawal-release.ts},
 * src/app/(antifraud)/antifraud/kyc/actions.ts,
 * src/lib/discord-notifications/antifraud-policy.ts. Citations inline.
 */

// reviews/page.tsx:114-123 — `severities: ["critical", "high"]`, status
// "unresolved" = open | in_review | escalated (reviews.ts:45-48). The tab
// counts use the same filter (reviews.ts:751).
const stateRows = [
  {
    key: "open",
    cells: [
      <GuideBadge key="s" accent="blue">
        Open
      </GuideBadge>,
      "Nobody has picked it up. This is where automation leaves a case.",
    ],
  },
  {
    key: "in_review",
    cells: [
      <GuideBadge key="s" accent="amber">
        In review
      </GuideBadge>,
      "Someone clicked Review. The case is assigned to them.",
    ],
  },
  {
    key: "cleared",
    cells: [
      <GuideBadge key="s" accent="emerald">
        Cleared
      </GuideBadge>,
      "Closed by Approve. Terminal — the action buttons disappear.",
    ],
  },
  {
    key: "flagged",
    cells: [
      <GuideBadge key="s" accent="rose">
        Flagged
      </GuideBadge>,
      "Closed by Ban. Terminal.",
    ],
  },
] as const;

// Button render order: _components/quick-review-actions.tsx:106-128 —
// the ACTIONS array (:52-73, Approve then Ban) maps first, then
// <RequireKycButton> (:117-122), then <PostponeButton> (:123-128).
// All four are hidden on a terminal case (:89, :102).
const actionRows = [
  {
    key: "approve",
    cells: [
      "Approve",
      "Closes the case as cleared and releases the automatic critical-signup locks. See the section below — it releases less than the dialog claims.",
    ],
  },
  {
    key: "ban",
    cells: [
      "Ban",
      "Requires a preset or custom written reason. Blocks every known IP and fingerprint first, then bans the account and kills its sessions. Closes the case as flagged. Needs the ban permission and a fresh 2FA step-up.",
    ],
  },
  {
    key: "kyc",
    cells: [
      "Require KYC",
      "Locks fiat deposits, all withdrawals and tips, then opens a KYC cycle. Owner or admin only, with 2FA. Deliberately leaves the case status where it is — it is evidence gathering, not a verdict.",
    ],
  },
  {
    key: "postpone",
    cells: [
      "Postpone",
      "Pushes the case out of the live queue for two hours. It comes back in the Postponed tab.",
    ],
  },
] as const;

const approveSteps: readonly GuideStep[] = [
  {
    title: "The case closes as cleared",
    detail:
      "This always happens, and it is the only part that is unconditional.",
  },
  {
    title: "Locks whose reason starts with the automatic critical-signup text are released",
    detail: (
      <>
        Fiat deposits, crypto withdrawals, item withdrawals and the tips reward
        lock — but only where the stored reason came from that automation.
      </>
    ),
  },
  {
    title: "Everything else is left exactly as it was",
    detail:
      "The release is matched on the lock's reason string. A lock placed by any other path does not match and is not touched.",
  },
];

export default async function AntifraudAccountReviewGuidePage() {
  await requireAntifraudPageAccess();

  return (
    <GuidePage
      eyebrow="Guide"
      title="Account review — how to work a case"
      intro="A review is the fraud team's working record about one account: why it was pulled, who is on it, and what the verdict was. Opening one makes it yours. Closing one is the only thing that lifts an automatic signup lock."
    >
      <GuideSection
        icon={Inbox}
        title="What is actually in the queue"
        description="Two tabs — Reviews and Postponed — and both of them are filtered hard."
      >
        <GuideBullets
          accent="cyan"
          items={[
            "Only Critical and High severity cases are listed. Nothing else reaches either tab, or either tab's badge count.",
            "Only cases that are still live: open, in review, or escalated. Cleared and flagged cases drop out.",
            "Reviews shows what is available right now. Postponed shows what someone parked, until its two hours lapse.",
          ]}
        />
        <GuideCallout
          icon={AlertTriangle}
          tone="warning"
          title="A case you open by hand will not show up here"
        >
          Opening a review manually creates it at{" "}
          <GuideBadge accent="blue">Medium</GuideBadge> severity, and there is
          no way to set the severity on that path. Because the queue only lists
          High and Critical, that case is invisible in both tabs and both
          counts. It still exists and is still reachable by its direct link, so
          keep the link if you create one — otherwise you have effectively
          filed it in a drawer nobody opens.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={ListChecks}
        title="The state machine"
        description="Four states, two of them terminal. There is no reopen."
      >
        <GuideTable columns={["State", "Meaning"]} rows={stateRows} />
        <GuideBullets
          items={[
            "Clicking Review moves an open case to in review and assigns it to you. It only works from open — a case someone else already started refuses with a stale-case error.",
            "Assigning a case to somebody (including yourself) also parks it for two hours so it stops sitting in everyone else's queue. Removing the assignment clears that immediately and puts it straight back.",
          ]}
        />
      </GuideSection>

      <GuideSection
        icon={UserCheck}
        title="The four buttons, in the order they appear"
        description="They are hidden entirely once the case is cleared or flagged, so a closed case cannot be acted on from the dialog."
      >
        <GuideTable columns={["Button", "What it does"]} rows={actionRows} />
      </GuideSection>

      <GuideSection
        icon={Fingerprint}
        title="Linked accounts are evidence, not a verdict"
        description="Linked accounts opens a live list of exact signup-IP and high-confidence Fingerprint matches. It also shows account age, deposits, withdrawals and wagering so normal household or long-standing activity is visible before anybody acts."
      >
        <GuideBullets
          accent="amber"
          items={[
            "A shared IP or device does not automatically mean fraud. Legitimate linked accounts can be left alone and the reviewed case can be approved.",
            "Admins and owners can select individual linked accounts and mass-ban only that reviewed selection, with a reason and fresh 2FA.",
            "The mass action does not block the shared IP or fingerprint, so unselected legitimate accounts are not indirectly affected.",
            "Staff, creators, former creators, protected analytics accounts and already-banned accounts cannot be selected.",
          ]}
        />
      </GuideSection>

      <GuideSection
        icon={CheckCircle2}
        title="What Approve really releases"
        description="This is the single most misread action in the workspace. The confirmation dialog says every automatic review lock will be removed. That is not what the code does."
      >
        <GuideSteps steps={approveSteps} accent="emerald" />
        <GuideSubHeading
          title="Locks that survive Approve"
          hint="Each of these is written with a different reason string, so the release skips it — and the toast still says the account was approved."
        />
        <GuideBullets
          accent="rose"
          items={[
            "Anything the quick Lock withdrawals action placed from inside the case.",
            "The locks Require KYC applied.",
            "The locks a declined fiat deposit applied.",
            "The crypto deposit block — only the fiat deposit block is ever cleared here.",
            "Opening, exchange and vault locks. Approve does not deal in those at all.",
            "IP and fingerprint blocklist entries. There is no unblock function anywhere in the codebase.",
            "The KYC requirement itself, always.",
          ]}
        />
        <GuideCallout icon={AlertTriangle} tone="warning" title="Verify, do not assume">
          If the account was locked by anything other than the critical-signup
          automation, Approve will report success and change nothing about its
          restrictions. Check the account&rsquo;s locks afterwards rather than
          trusting the toast.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={Fingerprint}
        title="The KYC gate"
        description="An account awaiting a KYC decision is handled differently — and not in the way the wording suggests."
      >
        <GuideBullets
          accent="amber"
          items={[
            "Approve does not refuse. The case still closes as cleared.",
            "What is skipped is the lock release. The account stays restricted until KYC is approved, and you get a warning toast saying so rather than a success one.",
            "It fails closed: if we cannot prove the account is not awaiting a KYC decision, the locks are left alone.",
            "Only an owner or admin can make the KYC decision, with 2FA. Clearing a case never substitutes for it.",
          ]}
        />
      </GuideSection>

      <GuideSection
        icon={Timer}
        title="Postponing — including the kind you do by accident"
        description="Closing the dialog is a decision, even when you did not mean it to be."
      >
        <GuideBullets
          accent="amber"
          items={[
            "Clicking the X, pressing Escape or clicking outside the dialog postpones the case for two hours and tells you it did.",
            "That only happens when you completed no action. If you approved, banned or required KYC, closing does nothing extra.",
            "A postponed case is skipped by reminders while it is parked, then re-enters the queue when the window lapses.",
          ]}
        />
        <GuideCallout icon={BellRing} tone="note">
          A live case reminds every two hours, repeating, and the first reminder
          fires two hours after the case was created. The only thing that stops
          it is closing the case — approving, banning, or otherwise resolving
          it. Postponing just moves the next one.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={Ban}
        title="Ban and Require KYC in detail"
        description="Both are step-up actions and both do more than the case record."
      >
        <GuideSubHeading
          title="Ban"
          hint="Order matters: identifiers first, account second."
        />
        <GuideBullets
          accent="rose"
          items={[
            "Every known IP and fingerprint for the account is added to the blocklists before the ban is written.",
            "Then the account is banned and all its sessions are deleted.",
            "If any step fails, the whole thing fails and nothing is hidden — you get told the account could not be banned.",
            "The case closes as flagged. Ban never releases anything.",
          ]}
        />
        <GuideSubHeading
          title="Require KYC"
          hint="This used to refuse unless the account was already locked. It no longer does."
        />
        <GuideBullets
          accent="amber"
          items={[
            "It now applies the locks itself: fiat deposits, all withdrawals, then tips — in that order, before it calls the KYC service.",
            "If the lock fails, KYC is not required and you get an error. If only the tips lock fails, it continues anyway and tips stay open — worth checking on a high-value account.",
            "The case status is untouched by design.",
          ]}
        />
        <GuideCallout icon={AlertTriangle} tone="warning" title="Stale wording in the dialog">
          The Require KYC dialog still says it is &ldquo;available only while
          balance and item withdrawals are already locked&rdquo;. That
          precondition was removed — ignore the sentence, the button works on an
          unlocked account and locks it for you.
        </GuideCallout>
      </GuideSection>
    </GuidePage>
  );
}
