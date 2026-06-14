"use client";

/**
 * Transaction detail modal — split out of user-tabs-transactions.tsx so it
 * can be lazy-loaded via next/dynamic. The modal pulls in the Dialog
 * primitives, the provably-fair game-session viewer, and a large
 * metadata-label map; none of that is needed until an admin actually
 * clicks a transaction row, so keeping it out of the table's critical
 * bundle shaves weight off the user-detail page's first paint.
 *
 * Behaviour is identical to the previous in-file implementation.
 */

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Gauge } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { STATUS_COLORS } from "@/lib/constants";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import {
  amountColorFor,
  balanceMovementSign,
  ledgerDirection,
} from "@/lib/utils/ledger-direction";
import { ledgerTypeLabel } from "@/lib/utils/ledger-labels";
import { getGameSessionDetails } from "./actions";
import { battleUrl } from "@/lib/utils/main-site";
import { BattlePasswordReveal } from "@/components/battle-password-reveal";
import type { WagerRequirementSummary } from "@/lib/queries/users-wager-progress-shared";
import type { Transaction, GameSessionDetails } from "./user-tabs-types";

const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
  uncommon: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  rare: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  "ultra rare": "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  "secret rare": "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  legendary: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  holo: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
};

export function TransactionDetailModal({
  transaction,
  userId,
  onClose,
  isAdmin = false,
  wagerRequirement = null,
}: {
  transaction: Transaction | null;
  userId: string;
  onClose: () => void;
  /**
   * Gates the Battle Password row at the bottom of the modal — the row
   * only renders for admin viewers on rows whose linked battle has a
   * password set. The server action (`revealBattlePassword`) also
   * re-validates the admin role on every call, so a non-admin who
   * spoofed this prop still can't read the value.
   */
  isAdmin?: boolean;
  /**
   * The user's withdrawal wager-requirement status (filled vs required +
   * %). Account-level (one value per user, not per-tx), surfaced here on
   * the Deposits & Withdrawals popup so an operator sees how far the user
   * is from being able to cash out without leaving the row. Plain
   * serializable object (no function props over the RSC boundary). null
   * when the connected DB lacks the sweepstakes columns or the backend
   * config was unreachable → the block self-hides.
   */
  wagerRequirement?: WagerRequirementSummary | null;
}) {
  const [gameSession, setGameSession] = useState<GameSessionDetails | null>(
    null,
  );
  const [loadingSession, setLoadingSession] = useState(false);
  // A rejected getGameSessionDetails used to be UNHANDLED (then/finally
  // with no catch) — surface it as an inline row instead, distinguishable
  // from the legitimate "Game session not found" null result.
  const [sessionError, setSessionError] = useState(false);

  useEffect(() => {
    if (!transaction?.gameSessionId) {
      setGameSession(null);
      setSessionError(false);
      return;
    }
    setLoadingSession(true);
    setGameSession(null);
    setSessionError(false);
    // Pass the URL's userId through so the server can verify ownership
    // before returning provably_fair_results (server-seed leak guard).
    getGameSessionDetails(transaction.gameSessionId, userId)
      .then((data) => setGameSession(data))
      .catch(() => setSessionError(true))
      .finally(() => setLoadingSession(false));
  }, [transaction?.id, transaction?.gameSessionId, userId]);

  if (!transaction) return null;
  const t = transaction;

  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: "ID",
      value: <span className="font-mono text-xs break-all">{t.id}</span>,
    },
    {
      label: "Type",
      value: (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-mono text-xs">
            {t.type}
          </Badge>
          {/* Friendly label — Instant rakeback when early-claimed, the shared
              display label otherwise (challenge_prize → "Challenge prize"). */}
          <span className="text-xs text-muted-foreground">
            {t.type === "rakeback_claim"
              ? t.isInstantRakeback === true
                ? "Instant rakeback"
                : "Rakeback"
              : ledgerTypeLabel(t.type)}
          </span>
        </div>
      ),
    },
    {
      label: "Amount",
      value: (() => {
        // COLOR is house-POV (classify by ledger type): a rakeback claim is a
        // house loss → rose, even though it CREDITS the user. The SIGN, in
        // contrast, follows the user's real balance movement so it can never
        // contradict the Balance Before/After rows below (a credit reads "+",
        // a debit "−"). `amount` is a positive magnitude here, so abs-guard it
        // against the rare genuinely-signed row (admin_balance_adjustment).
        const dir = ledgerDirection(t.type);
        return (
          <span className={amountColorFor(dir)}>
            {balanceMovementSign(t.balanceBefore, t.balanceAfter)}
            {formatCurrency(Math.abs(t.amount))}
          </span>
        );
      })(),
    },
    // Worth = TOTAL worth at that point = cash balance + held inventory
    // (cards + vouchers), so a battle/pack that trades cash for items reads
    // as the true total-worth change instead of looking like a pure cash
    // loss. Computed server-side (getUserTransactions) and reused by the
    // table row too, so the two surfaces can never drift apart. The cash leg
    // is shown right below as Balance Before/After, so the held-inventory
    // value is implicit (Worth − Balance) and doesn't need its own row.
    {
      label: "Worth Before",
      value: (
        <span title={`Cash ${formatCurrency(t.balanceBefore)} + inventory ${formatCurrency(Math.max(0, t.worthBefore - t.balanceBefore))}`}>
          {formatCurrency(t.worthBefore)}
        </span>
      ),
    },
    {
      label: "Worth After",
      value: (
        <span title={`Cash ${formatCurrency(t.balanceAfter)} + inventory ${formatCurrency(t.inventoryValue)}`}>
          {formatCurrency(t.worthAfter)}
        </span>
      ),
    },
    { label: "Balance Before", value: formatCurrency(t.balanceBefore) },
    { label: "Balance After", value: formatCurrency(t.balanceAfter) },
    {
      label: "Status",
      value: (
        <Badge variant="outline" className={STATUS_COLORS[t.status] ?? ""}>
          {t.status}
        </Badge>
      ),
    },
    { label: "Description", value: t.description },
    { label: "Created", value: formatDateTime(t.createdAt) },
    { label: "Updated", value: formatDateTime(t.updatedAt) },
  ];

  if (t.failureReason) {
    rows.push({
      label: "Failure Reason",
      value: <span className="text-rose-400">{t.failureReason}</span>,
    });
  }
  if (t.cryptoAsset) {
    rows.push({ label: "Crypto Asset", value: t.cryptoAsset });
  }
  if (t.cryptoAmount != null) {
    rows.push({ label: "Crypto Amount", value: String(t.cryptoAmount) });
  }
  if (t.exchangeRate != null) {
    rows.push({ label: "Exchange Rate", value: String(t.exchangeRate) });
  }
  if (t.blockchainTxHash) {
    rows.push({
      label: "Blockchain TX",
      value: (
        <span className="font-mono text-xs break-all">
          {t.blockchainTxHash}
        </span>
      ),
    });
  }
  if (t.sourceAddress) {
    rows.push({
      label: "Source Address",
      value: (
        <span className="font-mono text-xs break-all">{t.sourceAddress}</span>
      ),
    });
  }
  if (t.destinationAddress) {
    rows.push({
      label: "Destination Address",
      value: (
        <span className="font-mono text-xs break-all">
          {t.destinationAddress}
        </span>
      ),
    });
  }
  if (t.depositAddressId) {
    rows.push({
      label: "Deposit Address ID",
      value: (
        <span className="font-mono text-xs break-all">
          {t.depositAddressId}
        </span>
      ),
    });
  }
  if (t.gameSessionId) {
    rows.push({
      label: "Game Session ID",
      value: (
        <span className="font-mono text-xs break-all">{t.gameSessionId}</span>
      ),
    });
  }
  if (t.battleId) {
    rows.push({
      label: "Battle",
      value: (
        <a
          href={battleUrl(t.battleId)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-xs text-blue-400 break-all hover:underline"
          title="Open the live battle on packy.gg"
        >
          {t.battleId}
          <ExternalLink className="size-3 shrink-0" />
        </a>
      ),
    });
    // Battle Password row — admins only, only when the linked battle
    // has a password set. Reuses the shared BattlePasswordReveal which
    // fetches the plaintext on demand via revealBattlePassword
    // (audit-logged per reveal). The `hasPassword` boolean is the only
    // thing about the password that ever travels in this row's payload.
    if (isAdmin && t.hasPassword === true) {
      rows.push({
        label: "Battle Password",
        value: <BattlePasswordReveal battleId={t.battleId} />,
      });
    }
  }
  if (t.fireblocksTxId) {
    rows.push({
      label: "Fireblocks TX ID",
      value: (
        <span className="font-mono text-xs break-all">{t.fireblocksTxId}</span>
      ),
    });
  }
  if (t.externalTxId) {
    rows.push({
      label: "External TX ID",
      value: (
        <span className="font-mono text-xs break-all">{t.externalTxId}</span>
      ),
    });
  }
  if (t.soldCard) {
    rows.push({
      label: "Card Sold",
      value: (
        <div className="flex items-center gap-3 rounded-lg border p-2">
          {t.soldCard.imageUrl ? (
            <img
              src={t.soldCard.imageUrl}
              alt={t.soldCard.name}
              className="h-16 w-auto rounded object-contain"
            />
          ) : (
            <div className="h-16 w-10 rounded bg-muted flex items-center justify-center text-xs text-muted-foreground">
              ?
            </div>
          )}
          <div>
            <p className="text-sm font-medium">{t.soldCard.name}</p>
            {t.soldCard.rarity && (
              <Badge
                variant="outline"
                className={`text-[10px] ${RARITY_COLORS[t.soldCard.rarity.toLowerCase()] ?? ""}`}
              >
                {t.soldCard.rarity}
              </Badge>
            )}
          </div>
        </div>
      ),
    });
  }
  if (t.metadata && typeof t.metadata === "object") {
    const meta = t.metadata as Record<string, unknown>;
    const KNOWN_LABELS: Record<string, string> = {
      source_type: "Source Type",
      inventory_item_id: "Inventory Item",
      card_id: "Card",
      pack_id: "Pack",
      pack_name: "Pack Name",
      promo_code: "Promo Code",
      promo_code_id: "Promo Code",
      gift_card_code: "Gift Card Code",
      gift_card_id: "Gift Card",
      battle_id: "Battle",
      vault_id: "Vault",
      race_id: "Race",
      race_name: "Race Name",
      affiliate_code: "Affiliate Code",
      affiliate_id: "Affiliate",
      amount: "Amount",
      reason: "Reason",
      adjusted_by: "Adjusted By",
      action: "Action",
      bonus_percent: "Bonus %",
      deposit_tx_id: "Deposit TX",
      sender_id: "Sender",
      sender_username: "Sender",
      recipient_id: "Recipient",
      recipient_username: "Recipient",
      creator_id: "Creator",
      creator_username: "Creator",
      tip_amount: "Tip Amount",
      voucher_id: "Voucher",
      voucher_code: "Voucher Code",
      exchange_id: "Exchange",
      origin: "Origin",
      origin_id: "Origin ID",
      origin_type: "Origin Type",
      battle_name: "Battle Name",
      pack_count: "Pack Count",
      cards_count: "Cards Count",
      total_value: "Total Value",
      fee: "Fee",
      fee_percent: "Fee %",
      level: "Level",
      xp: "XP",
      reward_type: "Reward Type",
      reward_id: "Reward",
      reward_name: "Reward Name",
      claim_id: "Claim",
      period: "Period",
      tier: "Tier",
      percentage: "Percentage",
      shipping_fee: "Shipping Fee",
      withdrawal_id: "Withdrawal",
      rain_id: "Rain",
    };

    const knownEntries: { label: string; value: string }[] = [];
    const unknownEntries: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(meta)) {
      if (t.soldCard && key === "inventory_item_id") continue; // already shown as card
      const label = KNOWN_LABELS[key];
      if (label && val != null) {
        knownEntries.push({ label, value: String(val) });
      } else if (val != null) {
        unknownEntries[key] = val;
      }
    }

    for (const entry of knownEntries) {
      rows.push({
        label: entry.label,
        value: (
          <span className="font-mono text-xs break-all">{entry.value}</span>
        ),
      });
    }

    if (Object.keys(unknownEntries).length > 0) {
      rows.push({
        label: "Metadata",
        value: (
          <pre className="font-mono text-xs bg-muted rounded p-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-all">
            {JSON.stringify(unknownEntries, null, 2)}
          </pre>
        ),
      });
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl flex flex-col max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>Transaction Details</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto flex-1 -mx-4 px-4 space-y-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            {rows.map((row) => (
              <div key={row.label} className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {row.label}
                </span>
                <div className="text-sm">{row.value}</div>
              </div>
            ))}
          </div>

          {/* Withdrawal wager-requirement status — account-level (gates ALL
              withdrawals of this user's balance), shown on the deposit/
              withdrawal popup so an operator sees "how far from cashing out"
              without leaving the row. Self-hides when no data. */}
          <WagerRequirementBlock wagerRequirement={wagerRequirement} />

          {t.gameSessionId && (
            <div className="border-t pt-4 space-y-3">
              {loadingSession ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Loading game details...
                </p>
              ) : sessionError ? (
                // Load FAILURE — distinct from the "not found" null below so
                // a transient query error never reads as a missing session.
                <p className="text-sm text-amber-600 dark:text-amber-400 text-center py-2">
                  Couldn&apos;t load session details — close and reopen to
                  retry.
                </p>
              ) : gameSession ? (
                <>
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">
                      {gameSession.gameType === "pack"
                        ? "Pack Opening"
                        : "Battle"}{" "}
                      Details
                    </h3>
                    <Badge variant="outline" className="font-mono text-xs">
                      {gameSession.result}
                    </Badge>
                  </div>

                  {gameSession.pack && (
                    <Link
                      href={`/packs/${gameSession.pack.id}`}
                      className="flex items-center gap-4 py-2 group"
                    >
                      {gameSession.pack.imageUrl && (
                        <img
                          src={gameSession.pack.imageUrl}
                          alt={gameSession.pack.name}
                          className="h-20 w-auto rounded-lg object-contain drop-shadow-lg"
                        />
                      )}
                      <div>
                        <p className="text-sm font-semibold text-blue-400 group-hover:underline">
                          {gameSession.pack.name}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Bet: {formatCurrency(gameSession.betAmount)}
                        </p>
                      </div>
                    </Link>
                  )}

                  {gameSession.items.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-3">
                        Cards Obtained ({gameSession.items.length})
                      </p>
                      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                        {gameSession.items.map((item) => (
                          <div
                            key={item.id}
                            className="flex flex-col items-center gap-1.5"
                          >
                            {item.imageUrl ? (
                              <img
                                src={item.imageUrl}
                                alt={item.cardName}
                                className="h-28 w-auto rounded-lg object-contain drop-shadow-md"
                              />
                            ) : (
                              <div className="h-28 w-20 rounded-lg bg-muted/50 flex items-center justify-center text-xs text-muted-foreground">
                                ?
                              </div>
                            )}
                            <p className="text-xs font-medium text-center truncate w-full">
                              {item.cardName}
                            </p>
                            {item.rarity && (
                              <Badge
                                variant="outline"
                                className={`text-[10px] ${RARITY_COLORS[item.rarity.toLowerCase()] ?? ""}`}
                              >
                                {item.rarity}
                              </Badge>
                            )}
                            <p className="text-xs text-muted-foreground">
                              {formatCurrency(item.valueAtObtained)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {gameSession.pfResults.length > 0 && (
                    <div className="border-t pt-3 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Provably Fair
                      </p>
                      {gameSession.pfResults.map((pf, i) => (
                        <div
                          key={pf.id}
                          className="rounded-lg border bg-muted/30 p-3 space-y-1.5"
                        >
                          {gameSession.pfResults.length > 1 && (
                            <p className="text-[11px] font-medium text-muted-foreground">
                              Roll #{i + 1}
                            </p>
                          )}
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                            <div>
                              <p className="text-[10px] text-muted-foreground">
                                Client Seed
                              </p>
                              <p className="text-[11px] font-mono break-all">
                                {pf.clientSeed}
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">
                                Server Seed Hash
                              </p>
                              <p className="text-[11px] font-mono break-all">
                                {pf.serverSeedHash}
                              </p>
                            </div>
                            {pf.serverSeed && (
                              <div className="col-span-2">
                                <p className="text-[10px] text-muted-foreground">
                                  Server Seed
                                </p>
                                <p className="text-[11px] font-mono break-all">
                                  {pf.serverSeed}
                                </p>
                              </div>
                            )}
                            <div>
                              <p className="text-[10px] text-muted-foreground">
                                Nonce
                              </p>
                              <p className="text-[11px] font-mono">
                                {pf.nonce}
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">
                                Ticket
                              </p>
                              <p className="text-[11px] font-mono">
                                {pf.ticket}
                              </p>
                            </div>
                            <div className="col-span-2">
                              <p className="text-[10px] text-muted-foreground">
                                Result Hash
                              </p>
                              <p className="text-[11px] font-mono break-all">
                                {pf.resultHash}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-2">
                  Game session not found
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Withdrawal wager-requirement status block for the transaction-detail popup.
 *
 * Surfaces the user's progress toward the lifetime wager requirement that
 * gates every balance withdrawal: "filled $X of $Y required — Z% complete",
 * with a progress bar. The requirement is an ACCOUNT-LEVEL value (one per
 * user, read from the backend-maintained `balances` columns via
 * `getUserWagerProgress`), not a per-transaction figure — so the same status
 * shows on every row in the Deposits & Withdrawals popup.
 *
 * House-POV / neutral-info coloring (CLAUDE.md): the requirement progress is
 * informational, not a user gain/loss, so the bar + figures are blue/neutral
 * (the dedicated Account-tab card uses the same blue treatment). The bar turns
 * emerald only when the requirement is fully met — from the house POV a met
 * requirement means the user can now cash out (a house liability unlocks),
 * which is signalled, not celebrated.
 *
 * `completed` is backend truth; `required` / `remaining` are DERIVED estimates
 * (see getUserWagerProgress) and labeled as such. Self-hides on null data.
 */
function WagerRequirementBlock({
  wagerRequirement,
}: {
  wagerRequirement: WagerRequirementSummary | null;
}) {
  if (!wagerRequirement) return null;
  const { completedUsd, requiredUsd, remainingUsd, pct, exempt, met, backendAvailable } =
    wagerRequirement;

  return (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-blue-500/15 text-blue-600 dark:text-blue-400">
          <Gauge className="size-3.5" />
        </span>
        <p className="text-sm font-medium">Withdrawal wager requirement</p>
        {exempt ? (
          <Badge
            variant="outline"
            className="ml-auto border-amber-500/30 bg-amber-500/15 text-[10px] font-medium text-amber-600 dark:text-amber-400"
          >
            Exempt
          </Badge>
        ) : met ? (
          <Badge
            variant="outline"
            className="ml-auto border-emerald-500/30 bg-emerald-500/15 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
          >
            Met
          </Badge>
        ) : null}
      </div>

      {exempt ? (
        <p className="text-xs text-muted-foreground">
          User is{" "}
          <span className="font-medium text-amber-600 dark:text-amber-400">
            exempt (0× override)
          </span>{" "}
          — no wager requirement gates their withdrawals.
        </p>
      ) : requiredUsd != null && requiredUsd > 0 ? (
        <>
          <p className="text-sm tabular-nums">
            Filled{" "}
            <span className="font-semibold text-foreground">
              {formatCurrency(completedUsd)}
            </span>{" "}
            of{" "}
            <span className="font-semibold text-foreground">
              {formatCurrency(requiredUsd)}
            </span>{" "}
            required
            {pct != null && (
              <span className="text-muted-foreground">
                {" "}
                — {pct.toFixed(1)}% complete
              </span>
            )}
          </p>
          {pct != null && (
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full motion-safe:transition-[width] motion-safe:duration-700 ${
                  met
                    ? "bg-emerald-500"
                    : "bg-blue-500"
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          {!met && remainingUsd != null && (
            <p className="text-[11px] tabular-nums text-muted-foreground">
              {formatCurrency(remainingUsd)} left to wager before withdrawal.
            </p>
          )}
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Completed is backend truth; the requirement total is an estimate
            derived from lifetime source totals × their multipliers.
          </p>
        </>
      ) : (
        // backend bps unreachable → only the backend-truth completed figure
        // is meaningful; don't show a fabricated requirement total.
        <>
          <p className="text-sm tabular-nums">
            Wagered{" "}
            <span className="font-semibold text-foreground">
              {formatCurrency(completedUsd)}
            </span>{" "}
            cleared toward the requirement.
          </p>
          {!backendAvailable && (
            <p className="text-[11px] text-muted-foreground">
              Requirement total unavailable — the wager-weight backend config
              couldn&apos;t be reached, so only the cleared amount is shown.
            </p>
          )}
        </>
      )}
    </div>
  );
}
