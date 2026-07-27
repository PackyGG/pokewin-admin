import "server-only";

import { unstable_cache } from "next/cache";

import { inArray } from "drizzle-orm";
import { getReadDrizzleDb } from "@/lib/db";
import { user } from "@/lib/db-schema/main/schema";
import { queryMainRows } from "@/lib/drizzle-query";
import { readDbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";

/**
 * Creator Hub — `creators/[id]` **Alt Accounts** tab data (collusion /
 * self-boost detector).
 *
 * GOAL
 * ────
 * Flag when a creator's affiliate-code users look like the SAME person alting
 * to inflate the creator's leaderboard / acquisition numbers. We cluster the
 * creator's referred-user cohort by shared low-level signals and surface the
 * resulting clusters worst-first, with a per-cluster collusion flag.
 *
 * SIGNALS (only fields confirmed READABLE in the MAIN game DB — read-only)
 * ───────────────────────────────────────────────────────────────────────
 *   1. Same IP (exact)        — `audit_events.ip` (Inet) on login/register/
 *                               session events, plus `fingerprints.ip` when
 *                               that table is present (see GAPS).
 *   2. Same IP subnet (/24)   — derived from the same Inet column (IPv4 only).
 *   3. Same device            — `fingerprints.visitor_id` (the device/browser
 *                               fingerprint). GUARDED: the table is newer than
 *                               some DB snapshots (see GAPS).
 *   4. Reused deposit wallet  — `ledger_transactions.source_address` on
 *                               `type='deposit'` (the on-chain sender address).
 *   5. Synchronized deposits  — two cohort users depositing in the SAME second.
 *   6. Identical deposit      — same `crypto_asset` + same `crypto_amount`
 *      amount + same crypto     across two cohort users.
 *   7. Platform alt flag      — `fingerprints.suspected_alt_triggered` (the
 *      (bonus)                  game's OWN alt heuristic), counted as corro-
 *                               borating evidence. GUARDED (see GAPS).
 *
 * Each signal is computed as a set of *edges* (unordered user pairs that share
 * the signal). We union-find the edges into clusters; a cluster of ≥2 cohort
 * users that shares ≥1 signal is a "suspected alt cluster". The collusion flag
 * fires on a cluster when it shows a HARD signal (shared device, reused wallet,
 * synchronized deposit, or the platform's own alt flag) or ≥2 distinct signals.
 *
 * PII / SECURITY
 * ──────────────
 * IP addresses are PII. They are read + correlated ENTIRELY server-side; the
 * value returned to the client is always MASKED (`1.2.3.x` for v4, a `/64`
 * prefix for v6) and de-duplicated to a count. Deposit wallet addresses are
 * likewise masked (`bc1q…last4`). Raw IPs / full wallet addresses NEVER leave
 * the server and are never logged.
 *
 * PERFORMANCE
 * ───────────
 * LAZY — this whole module runs only when the Alt Accounts tab is opened (the
 * tab component is mounted on demand). The cohort is resolved once, then every
 * signal query is a SINGLE grouped round-trip over the resolved id set (no
 * per-row correlated subqueries). The whole computation is wrapped in
 * `unstable_cache` (prod-pinned, 5-min TTL) and each signal sub-query is
 * best-effort: a failure (e.g. a table absent on a DB snapshot, or a timeout)
 * degrades THAT signal to empty and is reported via `gaps`, instead of blanking
 * the tab.
 *
 * MAIN/prod game DB is READ-ONLY — nothing here writes, and no schema changed.
 */

// ─── Public shapes ──────────────────────────────────────────────────────

/** One referred user inside a suspected-alt cluster. */
export type AltClusterMember = {
  userId: string;
  username: string | null;
  /** Email is masked for display (`jo•••@gmail.com`). */
  maskedEmail: string | null;
  /** Account creation time (ISO) — sequential signups are themselves a tell. */
  createdAt: string | null;
  /** Lifetime deposit total booked to this user (USD). */
  depositsUsd: number;
  /** Lifetime wager booked under THIS creator's code for this user (USD). */
  wagerUsd: number;
};

/** A shared-signal cluster of ≥2 cohort users. */
export type AltCluster = {
  /** Stable id (smallest member user-id) — for React keys only. */
  id: string;
  members: AltClusterMember[];
  /** Which signals link this cluster, each with a redacted summary. */
  signals: AltSignalSummary[];
  /** True when the evidence is strong enough to call probable collusion. */
  collusion: boolean;
  /** 0–100 heuristic score (more/stronger signals → higher). */
  score: number;
  /** Σ of members' deposits — the leaderboard exposure this cluster represents. */
  clusterDepositsUsd: number;
  /** Σ of members' wager under this creator's code. */
  clusterWagerUsd: number;
};

export type AltSignalKind =
  | "shared_ip"
  | "shared_subnet"
  | "shared_device"
  | "reused_wallet"
  | "synchronized_deposit"
  | "identical_deposit"
  | "platform_alt_flag";

/** A redacted description of one signal firing within a cluster. */
export type AltSignalSummary = {
  kind: AltSignalKind;
  /** Human label, e.g. "Shared IP" / "Reused deposit wallet". */
  label: string;
  /**
   * Redacted detail safe for the client — masked IP(s), masked wallet,
   * timestamp, or "{crypto} {amount}". Never a raw IP / full address.
   */
  detail: string;
  /** How many cohort users this specific signal instance links. */
  userCount: number;
  /** HARD signals strongly imply same operator; SOFT are corroborating. */
  strength: "hard" | "soft";
};

/** A signal whose backing field could not be read (degraded coverage). */
export type AltDataGap = {
  kind: AltSignalKind | "fingerprints_table";
  label: string;
  reason: string;
};

export type AltAccountsData = {
  /** Resolved code(s) this creator owns (uppercased). */
  codes: string[];
  /** Size of the analysed referred-user cohort (staff/blacklist excluded). */
  cohortSize: number;
  /** Suspected-alt clusters, worst-first. */
  clusters: AltCluster[];
  /** Cohort users flagged by the platform's own alt heuristic (count). */
  platformAltFlaggedCount: number;
  /** Signals we could not evaluate on this DB — surfaced as a notice. */
  gaps: AltDataGap[];
  /**
   * True when at least one signal sub-query failed/degraded, so the cluster
   * set is a LOWER bound (real collusion may be under-counted).
   */
  partial: boolean;
};

// ─── Signal labels ──────────────────────────────────────────────────────

const SIGNAL_LABEL: Record<AltSignalKind, string> = {
  shared_ip: "Shared IP",
  shared_subnet: "Shared IP subnet",
  shared_device: "Shared device",
  reused_wallet: "Reused deposit wallet",
  synchronized_deposit: "Synchronized deposit",
  identical_deposit: "Identical deposit",
  platform_alt_flag: "Platform alt flag",
};

const HARD_SIGNALS: ReadonlySet<AltSignalKind> = new Set<AltSignalKind>([
  "shared_device",
  "reused_wallet",
  "synchronized_deposit",
  "platform_alt_flag",
]);

// ─── Masking helpers (PII never leaves the server unredacted) ────────────

/** `1.2.3.4` → `1.2.3.x`; IPv6 → first 4 groups + `::/64`. */
function maskIp(ip: string): string {
  const v = ip.trim();
  if (v.includes(":")) {
    const groups = v.split(":").filter(Boolean);
    return `${groups.slice(0, 4).join(":")}::/64`;
  }
  const parts = v.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  return "•••";
}

/** A `/24` network host like `1.2.3.0` → `1.2.3.0/24`. */
function maskSubnet(networkHost: string): string {
  const v = networkHost.trim();
  if (v.includes(":")) return `${v}/64`;
  return `${v}/24`;
}

/** Wallet `bc1qxyz…abcd` → `bc1q…abcd` (first 4 + last 4). */
function maskWallet(addr: string): string {
  const v = addr.trim();
  if (v.length <= 10) return `${v.slice(0, 2)}…${v.slice(-2)}`;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/** `john@gmail.com` → `jo•••@gmail.com`. */
function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}•••@${domain}`;
}

// ─── Union-Find (clusters users connected by shared signals) ─────────────

class UnionFind {
  private parent = new Map<string, string>();

  /** Ensure a node exists (self-parented) so `find` never sees undefined. */
  private ensure(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }

  private find(x: string): string {
    this.ensure(x);
    // Walk to the root.
    let root = x;
    let parent = this.parent.get(root)!;
    while (parent !== root) {
      root = parent;
      parent = this.parent.get(root)!;
    }
    // Path-compress: point every node on the walk straight at the root.
    let node = x;
    while (node !== root) {
      const next = this.parent.get(node)!;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    this.ensure(a);
    this.ensure(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const node of this.parent.keys()) {
      const root = this.find(node);
      const list = out.get(root);
      if (list) list.push(node);
      else out.set(root, [node]);
    }
    return out;
  }
}

// ─── Internal: one signal's grouped result ───────────────────────────────

/**
 * A single shared-value group: the cohort user-ids that share one concrete
 * value of a signal (e.g. one IP), plus the redacted detail string.
 */
type SignalGroup = {
  kind: AltSignalKind;
  detail: string;
  userIds: string[];
  strength: "hard" | "soft";
};

// ─── Cohort resolution (mirrors the canonical creator queries) ───────────

/**
 * Resolve the creator's owned code(s) and the referred-user cohort under
 * them. Mirrors `getCodeReferrals` / `getCodeAndWagerByUser`: cohort =
 * DISTINCT `affiliate_code_usages.referred_user_id` for `UPPER(code)` in the
 * creator's codes, joined to `user`, staff + blacklist excluded, and never the
 * creator themselves.
 */
async function resolveCohort(
  creatorUserId: string,
): Promise<{ codes: string[]; userIds: string[] }> {
  const excluded = await getExcludedUserIds();
  const blacklistAnd = blacklistNotInClause("u.id", excluded);

  const codeRows = await queryMainRows<{ code: string }[]>(
    `SELECT code FROM affiliate_codes WHERE user_id = $1 ORDER BY created_at ASC`,
    creatorUserId,
  );
  const codes = codeRows.map((r) => r.code.toUpperCase());
  if (codes.length === 0) return { codes: [], userIds: [] };

  const cohortRows = await queryMainRows<{ referred_user_id: string }[]>(
    // NOTE the space before ${blacklistAnd}: blacklistNotInClause returns
    // "AND <col> NOT IN (…)" with NO leading space. Concatenated directly
    // onto the $2 placeholder it produced `$2AND …` → Postgres 42601
    // "trailing junk after parameter" — which hard-failed the WHOLE alts
    // scan (permanent band) whenever the excluded-users blacklist was
    // non-empty, i.e. always on prod.
    `SELECT DISTINCT acu.referred_user_id
       FROM affiliate_code_usages acu
       JOIN "user" u ON u.id = acu.referred_user_id
      WHERE UPPER(acu.code) = ANY($1::text[])
        AND u.role NOT IN ('admin', 'support', 'creator')
        AND acu.referred_user_id <> $2 ${blacklistAnd}`,
    codes,
    creatorUserId,
  );

  return { codes, userIds: cohortRows.map((r) => r.referred_user_id) };
}

// ─── Signal queries (each best-effort, all server-side) ───────────────────

/**
 * Run a grouped signal query, mapping each shared value → the cohort users
 * that share it. Best-effort: a throw degrades the signal to empty and records
 * a gap (the tab still renders). `mask` redacts the grouping value for the
 * client; the raw value never escapes this function.
 */
async function runSignal(
  run: () => Promise<{ value: string; userIds: string[] }[]>,
  kind: AltSignalKind,
  strength: "hard" | "soft",
  mask: (value: string) => string,
  gaps: AltDataGap[],
  gapReason: string,
): Promise<SignalGroup[]> {
  try {
    const rows = await run();
    return rows
      .filter((r) => r.userIds.length >= 2)
      .map((r) => ({
        kind,
        detail: mask(r.value),
        userIds: r.userIds,
        strength,
      }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 42P01 = undefined_table (a signal's backing table is absent on this
    // snapshot). Anything else = a real read failure; both degrade the same
    // way (signal dropped, gap reported) so the tab never blanks.
    console.error(
      `[creator-hub.alt-accounts] signal '${kind}' degraded, continuing without it: ${msg}`,
    );
    gaps.push({ kind, label: SIGNAL_LABEL[kind], reason: gapReason });
    return [];
  }
}

/**
 * Compute every signal group for a resolved cohort. Returns the groups plus
 * the set of cohort users the PLATFORM flagged as suspected alts, plus any
 * data gaps encountered.
 */
async function computeSignals(
  codes: string[],
  userIds: string[],
): Promise<{
  groups: SignalGroup[];
  platformAltFlagged: Set<string>;
  gaps: AltDataGap[];
}> {
  const gaps: AltDataGap[] = [];

  // Probe once whether the `fingerprints` table exists on this DB snapshot —
  // device + fp-IP + platform-alt-flag all depend on it. If absent we record a
  // single clear gap rather than three identical "table missing" errors.
  let hasFingerprints = false;
  try {
    const probe = await queryMainRows<{ exists: boolean }[]>(
      `SELECT to_regclass('public.fingerprints') IS NOT NULL AS exists`,
    );
    hasFingerprints = probe[0]?.exists === true;
  } catch {
    hasFingerprints = false;
  }
  if (!hasFingerprints) {
    gaps.push({
      kind: "fingerprints_table",
      label: "Device & platform-alt signals",
      reason:
        "The `fingerprints` table (device fingerprint, fingerprint-IP, and the platform's own suspected-alt flag) is not present on the connected database — verify on production. Shared-device, fingerprint-IP, and platform-alt-flag detection are disabled for now; IP (via login/register events), wallet, deposit-timing, and identical-deposit detection are unaffected.",
    });
  }

  // ── Signal 1+2: shared IP (exact) and shared /24 subnet ──
  // Source A: audit_events.ip on identity events (login/register/session).
  // Source B: fingerprints.ip (login/signup), when present. We UNION both so a
  // user's IP from either source counts. Anonymous audit rows (user_id NULL)
  // are naturally excluded by the ANY($ids) filter.
  const ipSelect = hasFingerprints
    ? `WITH user_ips AS (
         SELECT user_id, ip FROM audit_events
          WHERE user_id = ANY($1::text[]) AND ip IS NOT NULL
         UNION
         SELECT user_id, ip FROM fingerprints
          WHERE user_id = ANY($1::text[]) AND ip IS NOT NULL
       )`
    : `WITH user_ips AS (
         SELECT user_id, ip FROM audit_events
          WHERE user_id = ANY($1::text[]) AND ip IS NOT NULL
       )`;

  const sharedIpGroups = await runSignal(
    async () => {
      const rows = await queryMainRows<{ ip: string; ids: string[] }[]>(
        `${ipSelect}
         SELECT host(ip)::text AS ip,
                array_agg(DISTINCT user_id) AS ids
           FROM user_ips
          GROUP BY ip
         HAVING COUNT(DISTINCT user_id) >= 2`,
        userIds,
      );
      return rows.map((r) => ({ value: r.ip, userIds: r.ids }));
    },
    "shared_ip",
    "hard",
    maskIp,
    gaps,
    "Identity-event IP correlation failed to load on this database.",
  );

  const sharedSubnetGroups = await runSignal(
    async () => {
      const rows = await queryMainRows<
        { subnet: string; ids: string[] }[]
      >(
        `${ipSelect}
         SELECT host(network(set_masklen(ip, 24)))::text AS subnet,
                array_agg(DISTINCT user_id) AS ids
           FROM user_ips
          WHERE family(ip) = 4
          GROUP BY network(set_masklen(ip, 24))
         HAVING COUNT(DISTINCT user_id) >= 2`,
        userIds,
      );
      return rows.map((r) => ({ value: r.subnet, userIds: r.ids }));
    },
    "shared_subnet",
    "soft",
    maskSubnet,
    gaps,
    "Subnet correlation failed to load on this database.",
  );

  // ── Signal 3: shared device (fingerprint visitor_id) ──
  const sharedDeviceGroups = hasFingerprints
    ? await runSignal(
        async () => {
          const rows = await queryMainRows<
            { visitor_id: string; ids: string[] }[]
          >(
            `SELECT visitor_id, array_agg(DISTINCT user_id) AS ids
               FROM fingerprints
              WHERE user_id = ANY($1::text[]) AND visitor_id IS NOT NULL
              GROUP BY visitor_id
             HAVING COUNT(DISTINCT user_id) >= 2`,
            userIds,
          );
          // Device id is itself an opaque token, but we still redact it to a
          // short prefix so the full fingerprint never reaches the client.
          return rows.map((r) => ({ value: r.visitor_id, userIds: r.ids }));
        },
        "shared_device",
        "hard",
        (v) => `device ${v.slice(0, 8)}…`,
        gaps,
        "Device-fingerprint correlation failed to load.",
      )
    : [];

  // ── Signal 4: reused deposit wallet (on-chain sender address) ──
  const reusedWalletGroups = await runSignal(
    async () => {
      const rows = await queryMainRows<
        { source_address: string; ids: string[] }[]
      >(
        `SELECT source_address, array_agg(DISTINCT user_id) AS ids
           FROM ledger_transactions
          WHERE user_id = ANY($1::text[])
            AND type = 'deposit'
            AND source_address IS NOT NULL
          GROUP BY source_address
         HAVING COUNT(DISTINCT user_id) >= 2`,
        userIds,
      );
      return rows.map((r) => ({ value: r.source_address, userIds: r.ids }));
    },
    "reused_wallet",
    "hard",
    maskWallet,
    gaps,
    "Deposit-wallet correlation failed to load.",
  );

  // ── Signal 5: synchronized deposits (same second) ──
  const syncDepositGroups = await runSignal(
    async () => {
      const rows = await queryMainRows<{ sec: string; ids: string[] }[]>(
        `SELECT to_char(date_trunc('second', created_at), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sec,
                array_agg(DISTINCT user_id) AS ids
           FROM ledger_transactions
          WHERE user_id = ANY($1::text[])
            AND type = 'deposit'
            AND status = 'completed'
          GROUP BY date_trunc('second', created_at)
         HAVING COUNT(DISTINCT user_id) >= 2`,
        userIds,
      );
      return rows.map((r) => ({ value: r.sec, userIds: r.ids }));
    },
    "synchronized_deposit",
    "hard",
    (v) => `same second · ${v}`,
    gaps,
    "Deposit-timing correlation failed to load.",
  );

  // ── Signal 6: identical deposit amount + same crypto ──
  const identicalDepositGroups = await runSignal(
    async () => {
      const rows = await queryMainRows<
        { asset: string; amt: string; ids: string[] }[]
      >(
        `SELECT crypto_asset AS asset,
                round(crypto_amount, 8)::text AS amt,
                array_agg(DISTINCT user_id) AS ids
           FROM ledger_transactions
          WHERE user_id = ANY($1::text[])
            AND type = 'deposit'
            AND crypto_asset IS NOT NULL
            AND crypto_amount IS NOT NULL
            AND crypto_amount > 0
          GROUP BY crypto_asset, round(crypto_amount, 8)
         HAVING COUNT(DISTINCT user_id) >= 2`,
        userIds,
      );
      return rows.map((r) => ({
        value: `${trimAmount(r.amt)} ${r.asset.toUpperCase()}`,
        userIds: r.ids,
      }));
    },
    "identical_deposit",
    "soft",
    (v) => v,
    gaps,
    "Identical-deposit correlation failed to load.",
  );

  // ── Signal 7 (bonus): the platform's own suspected-alt flag ──
  // This is per-USER, not a pairing, so it doesn't create cluster edges on its
  // own — it's surfaced as a count + attached as corroborating evidence to any
  // cluster whose members carry the flag.
  const platformAltFlagged = new Set<string>();
  if (hasFingerprints) {
    try {
      const rows = await queryMainRows<{ user_id: string }[]>(
        `SELECT DISTINCT user_id
           FROM fingerprints
          WHERE user_id = ANY($1::text[])
            AND suspected_alt_triggered = true`,
        userIds,
      );
      for (const r of rows) platformAltFlagged.add(r.user_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[creator-hub.alt-accounts] platform alt-flag read degraded: ${msg}`,
      );
      gaps.push({
        kind: "platform_alt_flag",
        label: SIGNAL_LABEL.platform_alt_flag,
        reason: "Platform suspected-alt flag failed to load.",
      });
    }
  }

  return {
    groups: [
      ...sharedIpGroups,
      ...sharedSubnetGroups,
      ...sharedDeviceGroups,
      ...reusedWalletGroups,
      ...syncDepositGroups,
      ...identicalDepositGroups,
    ],
    platformAltFlagged,
    gaps,
  };
}

/** Drop trailing zeros from a fixed-8 decimal string ("0.50000000" → "0.5"). */
function trimAmount(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

// ─── Per-member enrichment (deposits + wager, batched) ───────────────────

type MemberStats = { depositsUsd: number; wagerUsd: number };

async function enrichMembers(
  memberIds: string[],
  codes: string[],
): Promise<Map<string, MemberStats & {
  username: string | null;
  email: string | null;
  createdAt: Date | null;
}>> {
  const out = new Map<
    string,
    MemberStats & {
      username: string | null;
      email: string | null;
      createdAt: Date | null;
    }
  >();
  if (memberIds.length === 0) return out;

  const db = await getReadDrizzleDb();

  const [users, deposits, wagers] = await Promise.all([
    db
      .select({
        id: user.id,
        username: user.username,
        email: user.email,
        created_at: user.created_at,
      })
      .from(user)
      .where(inArray(user.id, memberIds))
      .then((rows) =>
        rows.map((row) => ({ ...row, created_at: new Date(row.created_at) })),
      ),
    // Lifetime completed deposits per member (USD `amount`).
    queryMainRows<{ user_id: string; total: string }[]>(
      `SELECT user_id, COALESCE(SUM(amount::numeric), 0)::text AS total
         FROM ledger_transactions
        WHERE user_id = ANY($1::text[])
          AND type = 'deposit'
          AND status = 'completed'
        GROUP BY user_id`,
      memberIds,
    ),
    // Wager booked under THIS creator's code per member (acu wager rows).
    queryMainRows<{ user_id: string; total: string }[]>(
      `SELECT referred_user_id AS user_id,
              COALESCE(SUM(wager_amount_usd::numeric), 0)::text AS total
         FROM affiliate_code_usages
        WHERE referred_user_id = ANY($1::text[])
          AND UPPER(code) = ANY($2::text[])
          AND usage_type::text = 'wager'
        GROUP BY referred_user_id`,
      memberIds,
      codes,
    ),
  ]);

  const depById = new Map(deposits.map((d) => [d.user_id, Number(d.total)]));
  const wagById = new Map(wagers.map((w) => [w.user_id, Number(w.total)]));

  for (const u of users) {
    out.set(u.id, {
      username: u.username,
      email: u.email,
      createdAt: u.created_at,
      depositsUsd: depById.get(u.id) ?? 0,
      wagerUsd: wagById.get(u.id) ?? 0,
    });
  }
  return out;
}

// ─── Scoring ─────────────────────────────────────────────────────────────

/**
 * Heuristic cluster score 0–100. Hard signals weigh heavily; soft signals add
 * corroboration; distinct-signal breadth and the platform flag add on top.
 * Tuned so a single soft-only link reads as "review" (not collusion) while any
 * hard signal or ≥2 distinct signals reads as probable collusion.
 */
function scoreCluster(
  signalKinds: Set<AltSignalKind>,
  hasPlatformFlag: boolean,
): { score: number; collusion: boolean } {
  let score = 0;
  for (const kind of signalKinds) {
    score += HARD_SIGNALS.has(kind) ? 35 : 15;
  }
  if (hasPlatformFlag) score += 25;

  // Breadth bonus: multiple INDEPENDENT signal types agreeing is much stronger
  // than one signal firing on many values.
  if (signalKinds.size >= 2) score += 15;

  score = Math.min(100, score);

  const hasHard = [...signalKinds].some((k) => HARD_SIGNALS.has(k));
  const collusion = hasHard || hasPlatformFlag || signalKinds.size >= 2;
  return { score, collusion };
}

// ─── Orchestration ────────────────────────────────────────────────────────

export async function computeAltAccounts(
  creatorUserId: string,
): Promise<AltAccountsData> {
  const { codes, userIds } = await resolveCohort(creatorUserId);

  if (codes.length === 0 || userIds.length === 0) {
    return {
      codes,
      cohortSize: userIds.length,
      clusters: [],
      platformAltFlaggedCount: 0,
      gaps: [],
      partial: false,
    };
  }

  const { groups, platformAltFlagged, gaps } = await computeSignals(
    codes,
    userIds,
  );

  // Build clusters from signal edges via union-find. Every signal group that
  // links ≥2 users contributes edges between all its members.
  const uf = new UnionFind();
  for (const g of groups) {
    const [first, ...rest] = g.userIds;
    for (const other of rest) uf.union(first, other);
  }
  // Also seed platform-flagged users so a cluster that EXISTS via another
  // signal can absorb the flag; lone flagged users (no shared signal) are NOT
  // promoted to a cluster on the flag alone — they're reported via the count.

  const rawGroups = uf.groups();

  // Map each clustered user → which signal groups touch them, so we can attach
  // per-cluster signal summaries.
  const clustersOut: AltCluster[] = [];

  for (const [, memberIds] of rawGroups) {
    if (memberIds.length < 2) continue; // not a cluster

    const memberSet = new Set(memberIds);

    // Signals that fall ENTIRELY (≥2 of their users) inside this cluster.
    const clusterSignals: AltSignalSummary[] = [];
    const signalKinds = new Set<AltSignalKind>();
    for (const g of groups) {
      const inside = g.userIds.filter((u) => memberSet.has(u));
      if (inside.length >= 2) {
        clusterSignals.push({
          kind: g.kind,
          label: SIGNAL_LABEL[g.kind],
          detail: g.detail,
          userCount: inside.length,
          strength: g.strength,
        });
        signalKinds.add(g.kind);
      }
    }
    if (clusterSignals.length === 0) continue;

    const hasPlatformFlag = memberIds.some((u) => platformAltFlagged.has(u));
    if (hasPlatformFlag) {
      clusterSignals.push({
        kind: "platform_alt_flag",
        label: SIGNAL_LABEL.platform_alt_flag,
        detail: "Game flagged ≥1 member as a suspected alt",
        userCount: memberIds.filter((u) => platformAltFlagged.has(u)).length,
        strength: "hard",
      });
    }

    const enriched = await enrichMembers(memberIds, codes);
    const members: AltClusterMember[] = memberIds
      .map((id) => {
        const e = enriched.get(id);
        return {
          userId: id,
          username: e?.username ?? null,
          maskedEmail: maskEmail(e?.email ?? null),
          createdAt: e?.createdAt ? e.createdAt.toISOString() : null,
          depositsUsd: e?.depositsUsd ?? 0,
          wagerUsd: e?.wagerUsd ?? 0,
        };
      })
      // Show the highest-deposit (highest-exposure) member first.
      .sort((a, b) => b.depositsUsd - a.depositsUsd);

    const { score, collusion } = scoreCluster(signalKinds, hasPlatformFlag);

    // Order signal summaries hard-first, then by userCount.
    clusterSignals.sort((a, b) => {
      if (a.strength !== b.strength) return a.strength === "hard" ? -1 : 1;
      return b.userCount - a.userCount;
    });

    clustersOut.push({
      id: [...memberIds].sort()[0],
      members,
      signals: clusterSignals,
      collusion,
      score,
      clusterDepositsUsd: members.reduce((s, m) => s + m.depositsUsd, 0),
      clusterWagerUsd: members.reduce((s, m) => s + m.wagerUsd, 0),
    });
  }

  // Worst-first: collusion-flagged before review, then by score, then size.
  clustersOut.sort((a, b) => {
    if (a.collusion !== b.collusion) return a.collusion ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return b.members.length - a.members.length;
  });

  return {
    codes,
    cohortSize: userIds.length,
    clusters: clustersOut,
    platformAltFlaggedCount: platformAltFlagged.size,
    gaps,
    // A run is partial if any signal degraded. The fingerprints-table notice is
    // an expected-coverage gap (not a transient failure), so it alone does not
    // mark the run partial — but a real per-signal failure does.
    partial: gaps.some((g) => g.kind !== "fingerprints_table"),
  };
}

// ─── Cached public entry (prod-pinned, same pattern as _pnl-cache.ts) ─────

const REVALIDATE_SECONDS = 300;

const cachedAltAccounts = unstable_cache(
  (creatorUserId: string): Promise<AltAccountsData> =>
    computeAltAccounts(creatorUserId),
  ["creator-hub-alt-accounts-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: ["creator-hub-alt-accounts"] },
);

/**
 * Cached on prod; direct (uncached) on a dev-toggled admin so they see live dev
 * data. `unstable_cache` runs its callback OUTSIDE the request's dynamic scope,
 * so the inner request-scoped resolver falls back to "prod"; we therefore
 * only cache when the request is itself on prod (the default), exactly like
 * `getCreatorPnlCached`.
 */
export async function getAltAccountsData(
  creatorUserId: string,
): Promise<AltAccountsData> {
  const env = await readDbEnv();
  if (env !== "prod") return computeAltAccounts(creatorUserId);
  return cachedAltAccounts(creatorUserId);
}
