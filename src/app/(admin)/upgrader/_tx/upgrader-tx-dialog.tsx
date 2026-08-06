"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ChevronRight,
  ExternalLink,
  Sliders,
  Ticket,
  Trophy,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CardImage } from "@/components/card-image";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import {
  parseUpgraderMetadata,
  formatUpgraderWinChanceLabel,
  formatUpgraderMultiplier as formatTargetMultiplier,
} from "@/lib/utils/upgrader-metadata";
import { getUpgraderTxDialogDetails } from "./actions";
import type { getTransactionDetail } from "@/lib/queries/transactions";
import { RARITY_COLORS } from "../../transactions/_shared/rarity-colors";

// Derived shape — whatever the underlying query returns. Awaited+
// NonNullable so we get the actual data type (drop the `| null`).
type TxDetail = NonNullable<Awaited<ReturnType<typeof getTransactionDetail>>>;

// Rarity → badge tone. Mirrors the map on /transactions/[id] so the
// chip styling reads identically across the popup and the full page.

/**
 * Click-an-ID popup for /transactions/upgrader rows.
 *
 * Lightweight focused subset of the full /transactions/[id] page —
 * surfaces the headline operator question ("what ticket did they
 * hit, and what card did they take home?") plus the PF proof
 * material, without forcing a navigation. Lazy-fetches on open via
 * the shared `getTransactionDetail` query so the popup and the full
 * page can never drift apart.
 *
 * `ledgerTxId === null` closes the dialog. The "View full page" link
 * deep-links to /transactions/[id] for admins who want the broader
 * context (related transactions, breakdown panel, full metadata).
 */
export function UpgraderTxDialog({
  ledgerTxId,
  onClose,
}: {
  ledgerTxId: string | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<TxDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!ledgerTxId) {
      setDetail(null);
      setNotFound(false);
      return;
    }
    setLoading(true);
    setNotFound(false);
    setDetail(null);
    let cancelled = false;
    getUpgraderTxDialogDetails(ledgerTxId)
      .then((data) => {
        if (cancelled) return;
        if (!data) setNotFound(true);
        else setDetail(data);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ledgerTxId]);

  const open = ledgerTxId !== null;

  // Headline summary derived once per render. Falsy guards handle the
  // loading / not-found states cleanly; downstream JSX assumes the
  // happy path.
  const session = detail?.gameSession ?? null;
  const pfRolls = session?.pfResults ?? [];
  const won = session ? session.itemsWon : 0;
  const bet = session ? session.betAmount : 0;
  const multiplier = bet > 0 && won > 0 ? won / bet : null;
  // The "card the ticket landed on" — upgrader sessions have exactly
  // one PF roll per spin so we surface the first card chip up top.
  const headlineCard = pfRolls.find((p) => p.card)?.card ?? null;
  // Upgrader is single-spin per game, so the configuration the user
  // picked (target multiplier / chance / roll) lives on the first PF
  // row's result_metadata blob. Parsed defensively — see
  // upgrader-metadata.ts for the candidate-key list. Any missing field
  // renders as "—"; the raw JSON disclosure at the bottom still shows
  // everything for audit.
  const upgraderConfig = pfRolls.length > 0
    ? parseUpgraderMetadata(pfRolls[0].resultMetadata)
    : null;
  // Net P&L for the house on this row. Same number as session.housePnl
  // but recomputed locally so the "Outcome" tile reads as a
  // self-contained derivation. Positive = house kept money (emerald);
  // negative = user pulled above stake (rose).
  const netForHouse = bet - won;
  // Outcome — user won = rose (house lost), user lost = emerald (house
  // gained). Matches the OUTCOME_COLORS map in the data-table.
  const outcome: "win" | "loss" = won > 0 ? "win" : "loss";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ticket className="size-4 text-pink-500" />
            Upgrader spin
          </DialogTitle>
        </DialogHeader>

        {loading && <UpgraderTxDialogSkeleton />}

        {notFound && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Transaction not found.
          </p>
        )}

        {!loading && !notFound && detail && (
          <div className="space-y-4">
            {/* OUTCOME — win/lost badge + bet + won + net-for-house.
                House-POV colors: badge ROSE for a user win (the house
                paid out), EMERALD for a user loss (the house kept the
                wager). Net-for-house mirrors the same rule. */}
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Outcome
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge
                      variant="outline"
                      className={
                        "capitalize text-sm px-2 py-0.5 " +
                        (outcome === "win"
                          ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
                          : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30")
                      }
                    >
                      {outcome === "win" ? (
                        <>
                          <Trophy className="size-3.5 mr-1" />
                          Won
                        </>
                      ) : (
                        "Lost"
                      )}
                    </Badge>
                    {multiplier != null && (
                      <span
                        className="inline-flex items-center rounded border border-rose-500/30 bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400"
                        title="Realized multiplier (won ÷ bet)"
                      >
                        {formatTargetMultiplier(multiplier)}
                      </span>
                    )}
                  </div>
                </div>

                {headlineCard && (
                  <div className="flex items-center gap-2 rounded-lg border bg-card p-2">
                    <div className="aspect-[2/3] h-20 overflow-hidden rounded bg-muted shrink-0">
                      <CardImage
                        src={headlineCard.imageUrl}
                        alt={headlineCard.name}
                        className="size-full"
                      />
                    </div>
                    <div className="min-w-0 space-y-1 max-w-[160px]">
                      <p
                        className="text-xs font-medium truncate"
                        title={headlineCard.name}
                      >
                        {headlineCard.name}
                      </p>
                      {headlineCard.rarity && (
                        <span
                          className={`inline-block rounded px-1 py-0.5 text-[10px] font-semibold leading-none ${
                            RARITY_COLORS[headlineCard.rarity.toLowerCase()] ??
                            "bg-black/80 text-white"
                          }`}
                        >
                          {headlineCard.rarity}
                        </span>
                      )}
                      <p className="text-[11px] font-medium tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(headlineCard.valueAtObtained)}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Money tiles — Bet (house gain → emerald), Won (house
                  loss → rose), Net for house (signed, color follows
                  sign on house-POV). Same data the data-table row
                  carries; keeping it inside the popup means an admin
                  never has to re-read the row to verify the numbers. */}
              <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-lg border bg-card/60 p-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Bet
                  </p>
                  <p className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                    +{formatCurrency(bet)}
                  </p>
                </div>
                <div className="rounded-lg border bg-card/60 p-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Won
                  </p>
                  {won > 0 ? (
                    <p className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                      -{formatCurrency(won)}
                    </p>
                  ) : (
                    <p className="font-semibold tabular-nums text-muted-foreground">
                      —
                    </p>
                  )}
                </div>
                <div
                  className="rounded-lg border bg-card/60 p-2"
                  title="Net for the house = bet − won. Positive = we kept money, negative = user pulled above stake."
                >
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Net for house
                  </p>
                  <p
                    className={`font-semibold tabular-nums ${
                      netForHouse >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400"
                    }`}
                  >
                    {netForHouse >= 0 ? "+" : "-"}
                    {formatCurrency(Math.abs(netForHouse))}
                  </p>
                </div>
              </div>
            </div>

            {/* CONFIGURATION — the slider settings the user was
                running at. Parsed defensively out of the first PF
                row's result_metadata (see upgrader-metadata.ts).
                Anything the blob didn't carry renders as "—" so the
                operator can tell what the backend ACTUALLY stored
                versus what's missing; the raw blob disclosure at the
                bottom still surfaces every other key for audit. */}
            {upgraderConfig && (
              <div className="rounded-xl border bg-muted/30 p-3 space-y-2.5">
                <div className="flex items-center gap-2">
                  <Sliders className="size-3.5 text-cyan-500" />
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Configuration
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <ConfigTile
                    label="Target multiplier"
                    value={
                      upgraderConfig.targetMultiplier != null
                        ? formatTargetMultiplier(
                            upgraderConfig.targetMultiplier,
                          )
                        : "—"
                    }
                    tooltip="The cashout multiplier the user picked before the spin."
                  />
                  <ConfigTile
                    label="Target chance"
                    value={
                      upgraderConfig.targetChance != null
                        ? (formatUpgraderWinChanceLabel(
                            upgraderConfig.targetChance,
                            upgraderConfig.targetChanceDerived,
                          )?.text ?? "—")
                        : "—"
                    }
                    tooltip={
                      upgraderConfig.targetChance != null
                        ? (formatUpgraderWinChanceLabel(
                            upgraderConfig.targetChance,
                            upgraderConfig.targetChanceDerived,
                          )?.title ?? undefined)
                        : undefined
                    }
                  />
                  <ConfigTile
                    label="House edge"
                    value={
                      upgraderConfig.houseEdge != null
                        ? `${(upgraderConfig.houseEdge * 100).toFixed(2).replace(/\.?0+$/, "")}%`
                        : "—"
                    }
                    tooltip="Edge taken on the configured multiplier. Empty when the backend didn't store it."
                  />
                </div>
              </div>
            )}

            {/* Provably Fair detail — same data the full page shows,
                compact here. Multi-roll sessions aren't expected for
                upgrader (one spin per game), but the map handles it
                in case the backend ever emits more than one. Each
                roll surfaces the random ROLL VALUE up top (parsed
                from result_metadata) so the audit chain reads
                "configured X% chance → server rolled Y → outcome".
                Raw metadata is collapsed into a <details> at the
                bottom of each roll so the proof material stays
                scannable while the full blob is still one click away
                for verification. */}
            {pfRolls.length > 0 && (
              <div className="rounded-xl border bg-muted/30 p-3 space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Provably Fair
                </p>
                {pfRolls.map((pf, i) => {
                  const rollMeta = parseUpgraderMetadata(pf.resultMetadata);
                  return (
                    <div key={pf.id} className="space-y-2 text-[11px]">
                      {pfRolls.length > 1 && (
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Roll #{i + 1}
                        </p>
                      )}
                      {/* Ticket (server-rolled number that decided the
                          spin) + roll value (the parsed random value
                          from metadata, if present). Tickets are
                          always present; the rolled value is only
                          present when the backend stored it on the
                          blob. */}
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-lg border bg-card/60 p-2">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Ticket
                          </p>
                          <p className="text-lg font-bold tabular-nums text-pink-600 dark:text-pink-400">
                            {pf.ticket.toLocaleString()}
                          </p>
                        </div>
                        <div className="rounded-lg border bg-card/60 p-2">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Roll
                          </p>
                          {rollMeta.roll != null ? (
                            <p className="text-lg font-bold tabular-nums text-cyan-600 dark:text-cyan-400">
                              {rollMeta.roll}
                            </p>
                          ) : (
                            <p className="text-lg font-bold tabular-nums text-muted-foreground">
                              —
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                        <div className="min-w-0">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Client Seed
                          </p>
                          <p className="font-mono break-all">{pf.clientSeed}</p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Server Seed Hash
                          </p>
                          <p className="font-mono break-all">
                            {pf.serverSeedHash}
                          </p>
                        </div>
                        {pf.serverSeed && (
                          <div className="col-span-2 min-w-0">
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                              Server Seed
                            </p>
                            <p className="font-mono break-all">
                              {pf.serverSeed}
                            </p>
                          </div>
                        )}
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Nonce
                          </p>
                          <p className="font-mono">{pf.nonce}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Cursor
                          </p>
                          <p className="font-mono">{pf.cursor}</p>
                        </div>
                        <div className="col-span-2 min-w-0">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Result Hash
                          </p>
                          <p className="font-mono break-all">{pf.resultHash}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Raw metadata — collapsed by default, always last. Holds
                anything the structured parser above missed (or simply
                doesn't know about yet). Use a native <details> so it
                stays accessible without pulling in a Disclosure
                primitive just for this. */}
            {pfRolls.some((pf) => pf.resultMetadata != null) && (
              <details className="group rounded-xl border bg-muted/30 p-3 [&_summary]:cursor-pointer">
                <summary className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground list-none [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                  Raw metadata
                  <span className="text-[10px] font-normal normal-case tracking-normal text-muted-foreground/70">
                    (everything the parser couldn&apos;t structure)
                  </span>
                </summary>
                <div className="mt-2 space-y-2">
                  {pfRolls.map((pf, i) =>
                    pf.resultMetadata != null ? (
                      <div key={pf.id} className="space-y-1">
                        {pfRolls.length > 1 && (
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Roll #{i + 1}
                          </p>
                        )}
                        <pre className="font-mono text-[10px] leading-snug overflow-auto rounded bg-muted/60 p-2 max-h-48">
                          {JSON.stringify(pf.resultMetadata, null, 2)}
                        </pre>
                      </div>
                    ) : null,
                  )}
                </div>
              </details>
            )}

            {/* Footer chrome — user + date and a deep-link to the
                full transaction page for context the popup omits. */}
            <div className="flex items-center justify-between gap-3 flex-wrap text-xs text-muted-foreground">
              <div className="space-y-0.5 min-w-0">
                <p>
                  User:{" "}
                  <Link
                    href={`/users/${detail.userId}`}
                    className="text-foreground hover:underline"
                    onClick={onClose}
                  >
                    {detail.username ?? detail.email ?? detail.userId}
                  </Link>
                </p>
                <p>{formatDateTime(detail.createdAt)}</p>
              </div>
              <Link
                href={`/transactions/${detail.id}`}
                onClick={onClose}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent"
              >
                <ExternalLink className="size-3" />
                Full transaction page
              </Link>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Loading shell for the dialog body. Mirrors the resolved layout —
 * outcome panel (badge + card chip + 3 money tiles), configuration
 * panel (3 tiles), and a provably-fair panel (2 ticket tiles + seed
 * rows) — so the spinner→content swap doesn't pop or shift. Shimmer +
 * reduced-motion are inherited from the base <Skeleton>; the wrapper is
 * aria-hidden and the dialog title already announces the busy context.
 */
function UpgraderTxDialogSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      {/* Outcome panel */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="space-y-2">
            <Skeleton className="h-2.5 w-16 rounded" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-20 rounded-full" />
              <Skeleton className="h-5 w-12 rounded" />
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border bg-card p-2">
            <Skeleton className="h-20 w-[3.33rem] rounded" />
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-24 rounded" />
              <Skeleton className="h-4 w-14 rounded" />
              <Skeleton className="h-3 w-12 rounded" />
            </div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-card/60 p-2 space-y-1.5">
              <Skeleton className="h-2.5 w-12 rounded" />
              <Skeleton className="h-4 w-16 rounded" />
            </div>
          ))}
        </div>
      </div>
      {/* Configuration panel */}
      <div className="rounded-xl border bg-muted/30 p-3 space-y-2.5">
        <Skeleton className="h-3 w-28 rounded" />
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-card/60 p-2 space-y-1.5">
              <Skeleton className="h-2.5 w-14 rounded" />
              <Skeleton className="h-4 w-12 rounded" />
            </div>
          ))}
        </div>
      </div>
      {/* Provably-fair panel */}
      <div className="rounded-xl border bg-muted/30 p-3 space-y-3">
        <Skeleton className="h-3 w-24 rounded" />
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-card/60 p-2 space-y-1.5">
              <Skeleton className="h-2.5 w-12 rounded" />
              <Skeleton className="h-5 w-16 rounded" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-2.5 w-16 rounded" />
              <Skeleton className="h-3 w-full rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Compact label/value pill for the Configuration section. Mirrors the
 * tile style already used by the Bet / Won / Net for house row above
 * so the two sections read as a coherent set.
 */
function ConfigTile({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: string;
  tooltip?: string;
}) {
  return (
    <div
      className="rounded-lg border bg-card/60 p-2"
      title={tooltip}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  );
}
