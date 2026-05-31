"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Loader2, Ticket } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CardImage } from "@/components/card-image";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { getUpgraderTxDialogDetails } from "./actions";
import type { getTransactionDetail } from "@/lib/queries/transactions";

// Derived shape — whatever the underlying query returns. Awaited+
// NonNullable so we get the actual data type (drop the `| null`).
type TxDetail = NonNullable<Awaited<ReturnType<typeof getTransactionDetail>>>;

// Rarity → badge tone. Mirrors the map on /transactions/[id] so the
// chip styling reads identically across the popup and the full page.
const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-700/90 text-zinc-100",
  uncommon: "bg-emerald-700/90 text-emerald-100",
  rare: "bg-blue-700/90 text-blue-100",
  "ultra rare": "bg-purple-700/90 text-purple-100",
  "secret rare": "bg-yellow-600/90 text-yellow-100",
  legendary: "bg-orange-600/90 text-orange-100",
  holo: "bg-cyan-700/90 text-cyan-100",
  secret: "bg-pink-700/90 text-pink-100",
};

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
  const housePnl = session ? session.housePnl : 0;
  const multiplier = bet > 0 && won > 0 ? won / bet : null;
  // The "card the ticket landed on" — upgrader sessions have exactly
  // one PF roll per spin so we surface the first card chip up top.
  const headlineCard = pfRolls.find((p) => p.card)?.card ?? null;

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

        {loading && (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading…
          </div>
        )}

        {notFound && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Transaction not found.
          </p>
        )}

        {!loading && !notFound && detail && (
          <div className="space-y-4">
            {/* Headline — ticket + card-chip + the three money tiles */}
            <div className="rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="space-y-0.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Ticket
                  </p>
                  {pfRolls[0] ? (
                    <p className="text-3xl font-bold tabular-nums text-pink-600 dark:text-pink-400">
                      {pfRolls[0].ticket.toLocaleString()}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">—</p>
                  )}
                  {multiplier != null && (
                    <span
                      className="mt-1 inline-flex items-center rounded border border-rose-500/30 bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400"
                      title="Realized multiplier (won ÷ bet)"
                    >
                      {formatUpgraderMultiplier(multiplier)}
                    </span>
                  )}
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
                <div className="rounded-lg border bg-card/60 p-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    House P&L
                  </p>
                  <p
                    className={`font-semibold tabular-nums ${
                      housePnl >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400"
                    }`}
                  >
                    {housePnl >= 0 ? "+" : "-"}
                    {formatCurrency(Math.abs(housePnl))}
                  </p>
                </div>
              </div>
            </div>

            {/* Provably Fair detail — same data the full page shows,
                compact here. Multi-roll sessions aren't expected for
                upgrader (one spin per game), but the map handles it
                in case the backend ever emits more than one. */}
            {pfRolls.length > 0 && (
              <div className="rounded-xl border bg-muted/30 p-3 space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Provably Fair
                </p>
                {pfRolls.map((pf, i) => (
                  <div key={pf.id} className="space-y-2 text-[11px]">
                    {pfRolls.length > 1 && (
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Roll #{i + 1}
                      </p>
                    )}
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
                          <p className="font-mono break-all">{pf.serverSeed}</p>
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
                      {pf.resultMetadata != null && (
                        <div className="col-span-2 min-w-0">
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Result Metadata
                          </p>
                          <pre className="font-mono text-[10px] leading-snug overflow-auto rounded bg-muted/60 p-2 max-h-32">
                            {JSON.stringify(pf.resultMetadata, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
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
 * Same multiplier formatter as the data-table / /users/[id] gaming
 * tab — kept inline so the dialog can lazy-load without dragging
 * in either parent.
 */
function formatUpgraderMultiplier(m: number): string {
  if (m < 10) return `${m.toFixed(1)}×`;
  if (m < 1000) return `${Math.round(m)}×`;
  return `${(m / 1000).toFixed(1)}k×`;
}
