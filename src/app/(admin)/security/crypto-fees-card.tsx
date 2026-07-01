"use client";

import { Fragment, useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ux";
import { updateCryptoFeesAction } from "./crypto-fees-actions";
// Runtime constant from the plain shared module — a VALUE import from
// crypto-fees.ts would pull "server-only" into this client bundle.
import {
  CRYPTO_FEE_ASSETS,
  type CryptoFeeAsset,
} from "@/lib/backend-api/crypto-fees-assets";
import type {
  CryptoFees,
  CryptoFeeConfig,
  UpdateCryptoFeesInput,
} from "@/lib/backend-api/crypto-fees";

/**
 * Crypto exchange-rate fee editor — per coin and per direction (deposit /
 * withdrawal) an on/off toggle plus a min/max fee range. Each transaction
 * rolls a random fee in [min, max]; deposits credit at price × (1 − fee),
 * withdrawals send at price × (1 + fee).
 *
 * Stored on the backend in basis points (ints 0..500), but admins think in
 * percent, so the inputs are % with 2 decimals (0.35 = 35 bps). On save we
 * convert % → bps (Math.round(pct * 100)), validate 0–5% and min ≤ max per
 * row client-side, and send ONLY the changed fields so the audit event
 * records exactly what moved. Save stays disabled while nothing differs
 * from the loaded config.
 *
 * `initial === null` means the backend read failed (the crypto-fees branch
 * isn't deployed yet) — render a muted "awaiting backend deploy" state with
 * no editable inputs rather than crashing /security.
 */

const BPS_PER_PCT = 100;
const MAX_BPS = 500; // 5%

type Direction = "deposit" | "withdrawal";

const DIRECTIONS: { key: Direction; title: string; help: string }[] = [
  {
    key: "deposit",
    title: "Deposits",
    help: "Fee on crypto deposits — the user is credited at price × (1 − fee). Each deposit rolls a random fee in [min, max].",
  },
  {
    key: "withdrawal",
    title: "Withdrawals",
    help: "Fee on crypto withdrawals — coins are sent at price × (1 + fee). Each withdrawal rolls a random fee in [min, max].",
  },
];

const ASSET_LABELS: Record<CryptoFeeAsset, string> = {
  BTC: "Bitcoin (BTC)",
  ETH: "Ethereum (ETH)",
  LTC: "Litecoin (LTC)",
  SOL: "Solana (SOL)",
  USDT_ERC20: "USDT (ERC-20)",
  USDT_TRC20: "USDT (TRC-20)",
  USDT_SOL: "USDT (Solana)",
  USDC_ERC20: "USDC (ERC-20)",
  USDC_SOL: "USDC (Solana)",
  DOGE: "Dogecoin (DOGE)",
  XRP: "XRP",
};

type RowState = { enabled: boolean; min: string; max: string };

const rowKey = (d: Direction, a: CryptoFeeAsset) => `${d}.${a}`;

const bpsToPct = (bps: number): string => String(bps / BPS_PER_PCT);

/**
 * Parse a % input into bps. Returns null for an empty field (= leave
 * unchanged, same convention as the wager-weight cards) and NaN when the
 * text isn't a finite number — the caller turns NaN / out-of-range into a
 * per-row toast.
 */
const parsePctToBps = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const pct = Number(trimmed);
  if (!Number.isFinite(pct)) return NaN;
  return Math.round(pct * BPS_PER_PCT);
};

export function CryptoFeesCard({ initial }: { initial: CryptoFees | null }) {
  const [isPending, startTransition] = useTransition();

  // Server-truth baseline for dirty-tracking. Seeded from the initial prop and
  // re-baselined to the saved config after a successful write, so the card
  // reflects the saved values in place WITHOUT a router.refresh() (no scroll
  // jump). Re-editing then diffs against what was actually persisted.
  const [baseline, setBaseline] = useState<CryptoFees | null>(initial);

  // Form state: one row (enabled + min% + max% strings) per
  // (direction, asset). Hooks must run unconditionally, so this is declared
  // even when initial is null (the degraded branch returns before using it).
  const [values, setValues] = useState<Record<string, RowState>>(() => {
    const seed: Record<string, RowState> = {};
    for (const d of DIRECTIONS) {
      for (const asset of CRYPTO_FEE_ASSETS) {
        const cfg = initial?.[d.key][asset];
        seed[rowKey(d.key, asset)] = cfg
          ? {
              enabled: cfg.enabled,
              min: bpsToPct(cfg.min_bps),
              max: bpsToPct(cfg.max_bps),
            }
          : { enabled: false, min: "", max: "" };
      }
    }
    return seed;
  });

  if (!initial) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Crypto Exchange-Rate Fees
          </CardTitle>
          <CardDescription>
            Per-coin exchange-rate fee on crypto deposits and withdrawals —
            toggle plus a min/max % range; each transaction rolls a random
            fee in between.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The crypto-fee endpoints aren&apos;t reachable on the current
                backend deploy. This card becomes editable once the feature
                ships to the backend.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Past the `!initial` guard above, initial is non-null; baseline is seeded
  // from it (and re-baselined on save), so this is the current server truth.
  const base = baseline ?? initial;

  // Dirty-tracking for the Save button: a cell counts as changed when the
  // toggle differs from the loaded config or a non-empty % field parses to
  // different bps (unparseable text counts as dirty — the save click then
  // surfaces the validation toast). Empty fields mean "leave unchanged".
  const isDirty = DIRECTIONS.some((d) =>
    CRYPTO_FEE_ASSETS.some((asset) => {
      const cell = base[d.key][asset];
      const row = values[rowKey(d.key, asset)];
      if (row.enabled !== cell.enabled) return true;
      const minBps = parsePctToBps(row.min);
      if (minBps !== null && minBps !== cell.min_bps) return true;
      const maxBps = parsePctToBps(row.max);
      if (maxBps !== null && maxBps !== cell.max_bps) return true;
      return false;
    }),
  );

  const setRow = (key: string, patch: Partial<RowState>) =>
    setValues((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const handleSave = () => {
    const payload: UpdateCryptoFeesInput = {};

    for (const d of DIRECTIONS) {
      for (const asset of CRYPTO_FEE_ASSETS) {
        const cell = base[d.key][asset];
        const row = values[rowKey(d.key, asset)];
        const rowName = `${d.title} · ${ASSET_LABELS[asset]}`;
        const patch: Partial<CryptoFeeConfig> = {};

        if (row.enabled !== cell.enabled) patch.enabled = row.enabled;

        const minBps = parsePctToBps(row.min);
        if (minBps !== null) {
          if (Number.isNaN(minBps) || minBps < 0 || minBps > MAX_BPS) {
            toast.error(`${rowName}: min fee must be between 0% and 5%`);
            return;
          }
          if (minBps !== cell.min_bps) patch.min_bps = minBps;
        }

        const maxBps = parsePctToBps(row.max);
        if (maxBps !== null) {
          if (Number.isNaN(maxBps) || maxBps < 0 || maxBps > MAX_BPS) {
            toast.error(`${rowName}: max fee must be between 0% and 5%`);
            return;
          }
          if (maxBps !== cell.max_bps) patch.max_bps = maxBps;
        }

        // Validate min ≤ max on the EFFECTIVE merged pair (what the backend
        // will hold after this PUT) — mirrors the backend's merged check so
        // the admin gets the error before the request fires.
        const effMin = minBps ?? cell.min_bps;
        const effMax = maxBps ?? cell.max_bps;
        if (effMin > effMax) {
          toast.error(`${rowName}: min fee must be ≤ max fee`);
          return;
        }

        if (Object.keys(patch).length > 0) {
          (payload[d.key] ??= {})[asset] = patch;
        }
      }
    }

    if (!payload.deposit && !payload.withdrawal) {
      toast.info("No changes to save");
      return;
    }

    startTransition(async () => {
      const result = await updateCryptoFeesAction(payload);
      if (result.success) {
        toast.success("Crypto exchange-rate fees updated");
        // Re-baseline to the saved config in place — no router.refresh(), so
        // scroll never jumps. The controlled inputs already show these values;
        // updating baseline just re-arms the dirty-check (Save disables again).
        setBaseline(result.data);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Crypto Exchange-Rate Fees
        </CardTitle>
        <CardDescription>
          Per-coin exchange-rate fee on crypto deposits and withdrawals.
          Values are percent of the exchange rate (0.35% = 35 bps, max 5%);
          each transaction rolls a random fee between min and max. Disabled
          coins charge no fee. Saving writes through the backend, which
          re-validates the merged config.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {DIRECTIONS.map((d) => (
          <div key={d.key} className="space-y-3">
            <div>
              <h4 className="text-sm font-medium">{d.title}</h4>
              <p className="text-[11px] text-muted-foreground">{d.help}</p>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto_4.5rem_4.5rem] items-center gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto_6rem_6rem]">
              <span className="text-[11px] font-medium text-muted-foreground">
                Coin
              </span>
              <span className="text-[11px] font-medium text-muted-foreground">
                Fee
              </span>
              <span className="text-[11px] font-medium text-muted-foreground">
                Min %
              </span>
              <span className="text-[11px] font-medium text-muted-foreground">
                Max %
              </span>
              {CRYPTO_FEE_ASSETS.map((asset) => {
                const key = rowKey(d.key, asset);
                const row = values[key];
                return (
                  <Fragment key={key}>
                    <Label
                      htmlFor={`cf-${key}-min`}
                      className="block truncate text-sm font-normal"
                      title={ASSET_LABELS[asset]}
                    >
                      {ASSET_LABELS[asset]}
                    </Label>
                    <Switch
                      checked={row.enabled}
                      onCheckedChange={(checked) =>
                        setRow(key, { enabled: checked })
                      }
                      disabled={isPending}
                      aria-label={`${d.title} ${ASSET_LABELS[asset]} fee enabled`}
                    />
                    <Input
                      id={`cf-${key}-min`}
                      type="number"
                      step="0.01"
                      min="0"
                      max="5"
                      value={row.min}
                      onChange={(e) => setRow(key, { min: e.target.value })}
                      disabled={isPending}
                      aria-label={`${d.title} ${ASSET_LABELS[asset]} min fee %`}
                    />
                    <Input
                      id={`cf-${key}-max`}
                      type="number"
                      step="0.01"
                      min="0"
                      max="5"
                      value={row.max}
                      onChange={(e) => setRow(key, { max: e.target.value })}
                      disabled={isPending}
                      aria-label={`${d.title} ${ASSET_LABELS[asset]} max fee %`}
                    />
                  </Fragment>
                );
              })}
            </div>
          </div>
        ))}

        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={isPending || !isDirty}>
            {isPending && <Spinner size={15} className="text-current" />}
            {isPending ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
