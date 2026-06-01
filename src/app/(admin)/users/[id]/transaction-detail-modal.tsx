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
import { ExternalLink } from "lucide-react";
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
  amountSignFor,
  ledgerDirection,
} from "@/lib/utils/ledger-direction";
import { getGameSessionDetails } from "./actions";
import { battleUrl } from "@/lib/utils/main-site";
import { BattlePasswordReveal } from "@/components/battle-password-reveal";
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
}) {
  const [gameSession, setGameSession] = useState<GameSessionDetails | null>(
    null,
  );
  const [loadingSession, setLoadingSession] = useState(false);

  useEffect(() => {
    if (!transaction?.gameSessionId) {
      setGameSession(null);
      return;
    }
    setLoadingSession(true);
    setGameSession(null);
    // Pass the URL's userId through so the server can verify ownership
    // before returning provably_fair_results (server-seed leak guard).
    getGameSessionDetails(transaction.gameSessionId, userId)
      .then((data) => setGameSession(data))
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
        <Badge variant="outline" className="font-mono text-xs">
          {t.type}
        </Badge>
      ),
    },
    {
      label: "Amount",
      value: (() => {
        // Same house-POV treatment as the list row above — classify by
        // ledger type, not balance delta.
        const dir = ledgerDirection(t.type);
        return (
          <span className={amountColorFor(dir)}>
            {amountSignFor(dir)}
            {formatCurrency(t.amount)}
          </span>
        );
      })(),
    },
    // Worth = cash balance + held inventory (cards + vouchers) at that
    // point, so a battle/pack that trades cash for items reads as the true
    // total-worth change instead of looking like a pure cash loss. Computed
    // server-side (getUserTransactions) and reused by the table row too, so
    // the two surfaces can never drift apart.
    { label: "Worth Before", value: formatCurrency(t.worthBefore) },
    { label: "Worth After", value: formatCurrency(t.worthAfter) },
    { label: "Balance Before", value: formatCurrency(t.balanceBefore) },
    { label: "Balance After", value: formatCurrency(t.balanceAfter) },
    { label: "Inventory Value", value: formatCurrency(t.inventoryValue) },
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

          {t.gameSessionId && (
            <div className="border-t pt-4 space-y-3">
              {loadingSession ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Loading game details...
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
