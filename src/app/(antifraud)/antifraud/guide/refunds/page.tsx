import {
  AlertTriangle,
  Ban,
  CircleHelp,
  Landmark,
  ListChecks,
  MonitorSmartphone,
  RotateCcw,
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

export const metadata = {
  title: "Money Out Guide · Antifraud",
};

/**
 * Every claim below is traced to code in this repo. Citations are inline so a
 * future reader can re-verify instead of trusting the prose.
 */

// src/app/(antifraud)/antifraud/fiat-deposits/actions.ts:106 — decline sets
// status 'containing'; :165-176 locks then sets status = 'declined'.
// src/lib/antifraud/fiat-credit-review.ts:145 — the admin list filters on
// `WHERE review.staff_decision = 'decline'`, NOT on status, so already-resolved
// cases stay on the page with a resolution badge.
const arrivalSteps: readonly GuideStep[] = [
  {
    title: "A reviewer declines the deposit",
    detail: (
      <>
        On <GuideBadge accent="cyan">Deposit reviews</GuideBadge> the case moves
        to <GuideBadge>containing</GuideBadge>, fiat deposits and all
        withdrawals are locked, and the case settles at{" "}
        <GuideBadge accent="rose">declined</GuideBadge>. The payment is still
        with Whop at this point — declining credits nothing and refunds nothing.
      </>
    ),
  },
  {
    title: "It appears under Admin → Deposits",
    detail: (
      <>
        The list is filtered on the staff decision, not on the status, so a case
        you already resolved stays visible with its outcome badge. Rows that
        still need a decision sort to the top.
      </>
    ),
  },
  {
    title: "You pick one of three resolutions",
    detail:
      "Each needs a reason, a typed confirmation and a 2FA step-up. There is no fourth option and no way back to crediting the player.",
  },
];

// src/app/(antifraud)/antifraud/admin/deposits/declined-deposit-decision.tsx:97-99
// (button labels + order), :25-29 (label map), :31-35 (CONFIRMATIONS map).
// src/app/(antifraud)/antifraud/admin/deposits/actions.ts:90-98 re-checks the
// confirmation server-side; :101 requires 2FA.
const resolutionRows = [
  {
    key: "refund",
    cells: [
      "Refund only",
      <GuideBadge key="c" accent="rose">
        REFUND
      </GuideBadge>,
      "Full refund at Whop. The account keeps its decline locks but is not banned.",
    ],
  },
  {
    key: "ban",
    cells: [
      "Ban only",
      <GuideBadge key="c" accent="rose">
        BAN
      </GuideBadge>,
      "Bans the account, blocks every known IP and fingerprint, kills its sessions — and keeps the payment. No refund is sent.",
    ],
  },
  {
    key: "refund_and_ban",
    cells: [
      "Refund + ban",
      <GuideBadge key="c" accent="rose">
        REFUND AND BAN
      </GuideBadge>,
      "Both of the above, in one action.",
    ],
  },
] as const;

// src/app/(antifraud)/antifraud/refunds/refunds-panel.tsx:159-171 — the client
// `runBatch` do/while loop; refund-actions.ts:757 + :780 `LIMIT 1` — one item
// per server-action call; :787 leases for 45 seconds; refunds-panel.tsx:566-574
// is the manual Resume button (there is no server-side worker).
const batchSteps: readonly GuideStep[] = [
  {
    title: "You queue the batch",
    detail: (
      <>
        Type <GuideBadge accent="rose">REFUND</GuideBadge> and confirm with 2FA.
        Candidates already carrying a refund item are silently dropped — a
        payment can only ever be queued once.
      </>
    ),
  },
  {
    title: "Your browser walks the list",
    detail:
      "The page calls a server action once per payment and loops until the batch reports done. Nothing on the server drives this.",
  },
  {
    title: "Closing the tab stops the batch",
    detail: (
      <>
        Items already sent are unaffected, but the rest simply stop. Reopen the
        page and press <GuideBadge accent="cyan">Resume</GuideBadge>; an
        abandoned in-flight item frees itself after its 45-second lease expires.
      </>
    ),
  },
  {
    title: "The last item triggers the clawback",
    detail:
      "Once no item is left pending or leased, account recovery runs automatically. You are not asked again.",
  },
];

// src/app/(antifraud)/antifraud/refunds/refund-actions.ts:737-740 calls
// recoverRefundedAccountsForBatch on finalisation; :220-240 ban + session
// delete; :266-273 balance decrement (+ ledger rows :285-339); :358-362 voucher
// DELETE; :423-438 provably-fair delete + `SET sold_at = NOW()`.
const clawbackRows = [
  {
    key: "ban",
    cells: [
      "Bans the account",
      "Sets is_banned and deletes every session. An existing ban reason is kept.",
    ],
  },
  {
    key: "balance",
    cells: [
      "Takes the balance",
      "Available balance first, then locked balance, each written as an admin_balance_adjustment ledger row.",
    ],
  },
  {
    key: "vouchers",
    cells: [
      "Deletes unclaimed vouchers",
      "Hard DELETE, only rows with no claimed_at. Claimed ones are untouched. Vouchers are taken whole — one that does not fit the remaining budget is skipped, not split.",
    ],
  },
  {
    key: "inventory",
    cells: [
      "Marks inventory sold",
      "Sets sold_at on removable items and deletes their provable-fairness rows. Items already sold, exchanged, withdrawal-locked, or inside a pending card withdrawal are left alone.",
    ],
  },
] as const;

export default async function AntifraudRefundsGuidePage() {
  await requireAntifraudPageAccess();

  return (
    <GuidePage
      eyebrow="Guide"
      title="Money out — declined deposits, refunds and the clawback"
      intro="Everything on this page moves real money at the payment provider or removes value from a live account. None of it can be undone from the panel, and one of the actions runs four separate destructive steps without asking a second time."
    >
      <GuideSection
        icon={Landmark}
        title="How a declined deposit reaches you"
        description="Admin → Deposits is manager-only. It is the end of the fiat pipeline: the money has been taken, a reviewer refused to credit it, and someone now has to decide where it goes."
      >
        <GuideSteps steps={arrivalSteps} />
        <GuideCallout icon={AlertTriangle} tone="warning">
          Declining a deposit is not a refund. Until you resolve it here the
          player has no credit and we still hold the payment.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={ListChecks}
        title="The three resolutions"
        description="Every one of them needs a reason of at least three characters, the exact confirmation word typed in, and a 2FA step-up. The confirmation is checked again on the server, so a modified page does not get you past it."
      >
        <GuideTable
          columns={["Button", "Type to confirm", "What it does"]}
          rows={resolutionRows}
        />
        <GuideCallout icon={RotateCcw} tone="danger">
          A refund is a full refund and it is final. The Whop client sends it
          with no retries and no idempotency key precisely because a repeat
          could pay the same money out twice — so there is nothing to reverse
          and nothing to re-run.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={CircleHelp}
        title="When the refund outcome is unknown"
        description="If Whop times out or answers with a server error after the request went out, the item is stored as unknown rather than failed — we genuinely do not know whether the money left."
      >
        <GuideBullets
          accent="amber"
          items={[
            "Unknown is terminal. The queue only ever re-claims items that are pending or whose lease expired, so nothing will retry it.",
            "It cannot be re-queued either: a payment already carrying an item row is dropped from every future candidate list.",
            "Both refund buttons are disabled for that row. Ban only stays available and is still safe.",
            "The batch itself finishes and closes as completed with issues — an unknown item does not block it.",
            "The only fix is outside the panel: reconcile the payment in Whop and record the truth there.",
          ]}
        />
        <GuideCallout icon={AlertTriangle} tone="warning">
          A case sitting in <GuideBadge>resolving</GuideBadge> for more than
          five minutes is shown as <GuideBadge>resolution failed</GuideBadge>.
          That is a display rule, not a retry — check the payment before acting
          again.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={MonitorSmartphone}
        title="The refund batch is driven by your browser"
        description="Refunds is a bulk workspace: you select banned or fraud-confirmed accounts and it refunds their payments one at a time. The loop lives in the page, not on the server."
      >
        <GuideSteps steps={batchSteps} accent="amber" />
        <GuideCallout icon={AlertTriangle} tone="warning">
          Do not start a large batch and walk away. There is no worker, cron or
          queue consumer that will pick it up — if the tab dies, the batch dies
          with it, and the clawback at the end never fires.
        </GuideCallout>
      </GuideSection>

      <GuideSection
        icon={Ban}
        title="What finishing a batch does automatically"
        description="When the last payment settles, account recovery runs on its own for every user whose refund succeeded or was already refunded. Four destructive steps, one transaction per user, no extra confirmation."
      >
        <GuideTable columns={["Step", "Detail"]} rows={clawbackRows} />
        <GuideSubHeading
          title="It is capped, and it is not a full wipe"
          hint="Each account's budget is the credit that was refunded minus anything already recovered from it before, so a second pass cannot take the same value twice."
        />
        <GuideBullets
          accent="slate"
          items={[
            "Value is taken up to that cap only — cash first, then vouchers, then inventory. An account whose refunded credit was already spent may lose almost nothing.",
            "Unlike the ban on Admin → Deposits, this clawback does not add the account's IPs or fingerprints to the blocklists.",
            "Ban & recover all successful refunds is a separate button. It ignores batch scope and sweeps every successful refund item ever recorded, and it needs 2FA but no typed confirmation.",
          ]}
        />
      </GuideSection>

      <GuideSection
        icon={Undo2}
        title="Unban restores nothing"
        description="Unbanning writes four columns on the user row and stops there."
      >
        <GuideCallout icon={AlertTriangle} tone="danger">
          It does not return the balance, undo the ledger adjustments, restore
          deleted vouchers — those rows are gone, not archived — un-sell
          inventory, release the fiat and withdrawal locks, or lift the IP and
          fingerprint blocks a ban applied. Treat the clawback as the point of
          no return, because it is one.
        </GuideCallout>
        <GuideBullets
          items={[
            "The withdrawal-lock release helper exists, but it is wired to clearing a review case — no unban path calls it.",
            "Everything on this page is written to the admin audit log. The clawback uses the durable writer, so a failed audit is reported to you rather than dropped.",
          ]}
        />
      </GuideSection>
    </GuidePage>
  );
}
