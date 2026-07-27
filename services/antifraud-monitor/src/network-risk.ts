import { createHash } from "node:crypto";
import { isIP } from "node:net";

import type { FastifyBaseLogger } from "fastify";
import type { Databases } from "./db.js";
import { disposableEmailDomain } from "./scoring.js";
import { severity } from "./scoring.js";

const MAX_NETWORK_ACCOUNTS = 50_000;
const SOURCE_BATCH_SIZE = 1_000;
const WORKER_INTERVAL_MS = 30_000;
const RECONCILIATION_INTERVAL_MS = 15 * 60_000;
const CREATOR_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60_000;

export const CREATOR_WINDOW_KEYS = ["7d", "30d", "90d", "lifetime"] as const;
export type CreatorWindowKey = (typeof CREATOR_WINDOW_KEYS)[number];

type SourceAccount = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  signup_ip: string | null;
  country: string | null;
  country_code: string | null;
  state: string | null;
  city: string | null;
  affiliate_code: string | null;
  referred_by: string | null;
  is_suspected_alt: boolean;
  created_at: Date;
};

type AnalysisRule = {
  key: string;
  category: "network" | "creator";
  name: string;
  description: string;
  enabled: boolean;
  points: number;
  threshold: number;
};

export type AnalysisSignal = {
  key: string;
  title: string;
  detail: string;
  points: number;
  value: number;
  threshold: number;
  category: "network" | "affiliate" | "behavior";
};

type CreatorEvidenceMember = {
  userId: string;
  username: string | null;
};

type CreatorEvidenceGroup = {
  accountCount: number;
  rootUserId: string;
  members: CreatorEvidenceMember[];
};

type GraphNode = {
  key: string;
  type: "account" | "ip" | "device";
  userId: string | null;
  label: string;
  metadata: Record<string, unknown>;
  degree: number;
  secret?: string;
};

type GraphEdge = {
  source: string;
  target: string;
  type: "shared_ip" | "shared_device";
};

function chunks<T>(values: T[], size = SOURCE_BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function maskIp(value: string): string {
  const ip = value.trim();
  if (ip.includes(":")) {
    const groups = ip.split(":").filter(Boolean);
    return `${groups.slice(0, 4).join(":")}::/64`;
  }
  const parts = ip.split(".");
  return parts.length === 4
    ? `${parts[0]}.${parts[1]}.${parts[2]}.x`
    : "Hidden IP";
}

function maskEmail(value: string | null): string | null {
  if (!value) return null;
  const [local, domain] = value.split("@");
  if (!local || !domain) return "•••";
  return `${local.slice(0, 2)}•••@${domain}`;
}

function windowDays(key: CreatorWindowKey): number | null {
  if (key === "7d") return 7;
  if (key === "30d") return 30;
  if (key === "90d") return 90;
  return null;
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function validIp(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return isIP(normalized) ? normalized : null;
}

export function scoreAnalysisSignals(signals: AnalysisSignal[]): {
  rawScore: number;
  score: number;
  severity: ReturnType<typeof severity>;
  breakdown: { network: number; affiliate: number; behavior: number };
} {
  const rawScore = Math.max(
    0,
    signals.reduce((total, signal) => total + signal.points, 0),
  );
  const score = Math.min(100, rawScore);
  return {
    rawScore,
    score,
    severity: severity(rawScore),
    breakdown: {
      network: signals
        .filter((signal) => signal.category === "network")
        .reduce((total, signal) => total + signal.points, 0),
      affiliate: signals
        .filter((signal) => signal.category === "affiliate")
        .reduce((total, signal) => total + signal.points, 0),
      behavior: signals
        .filter((signal) => signal.category === "behavior")
        .reduce((total, signal) => total + signal.points, 0),
    },
  };
}

export class NetworkRiskService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastAccountReconciliationAt = 0;
  private lastCreatorReconciliationAt = 0;

  constructor(
    private readonly db: Databases,
    private readonly log: FastifyBaseLogger,
  ) {}

  async start(): Promise<void> {
    await this.enqueueReconciliation("accounts");
    await this.enqueueReconciliation("creators:30d");
    await this.work();
    this.timer = setInterval(() => void this.work(), WORKER_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  async enqueueAccount(userId: string, requestedBy?: string): Promise<string> {
    return this.enqueue("account", userId, null, requestedBy);
  }

  async enqueueCreator(
    creatorUserId: string,
    window: CreatorWindowKey,
    requestedBy?: string,
  ): Promise<string> {
    return this.enqueue(
      "creator",
      creatorUserId,
      windowDays(window),
      requestedBy,
    );
  }

  async enqueueCreatorReconciliation(
    window: CreatorWindowKey,
    requestedBy?: string,
  ): Promise<string> {
    return this.enqueueReconciliation(`creators:${window}`, requestedBy);
  }

  private async enqueueReconciliation(
    targetId: string,
    requestedBy?: string,
  ): Promise<string> {
    return this.enqueue("reconciliation", targetId, null, requestedBy);
  }

  private async enqueue(
    targetKind: "account" | "creator" | "reconciliation",
    targetId: string,
    days: number | null,
    requestedBy?: string,
  ): Promise<string> {
    const result = await this.db.antifraud.query<{ id: string }>(
      `
        INSERT INTO network_scan_jobs(
          target_kind, target_id, window_days, requested_by
        ) VALUES ($1,$2,$3,$4)
        ON CONFLICT (
          target_kind, target_id, (COALESCE(window_days, -1))
        ) WHERE status IN ('pending', 'running')
        DO UPDATE SET requested_by = COALESCE(EXCLUDED.requested_by, network_scan_jobs.requested_by)
        RETURNING id
      `,
      [targetKind, targetId, days, requestedBy ?? null],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Failed to queue network scan");
    return id;
  }

  private async work(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      if (now - this.lastAccountReconciliationAt >= RECONCILIATION_INTERVAL_MS) {
        this.lastAccountReconciliationAt = now;
        await this.enqueueReconciliation("accounts");
      }
      if (
        now - this.lastCreatorReconciliationAt >=
        CREATOR_RECONCILIATION_INTERVAL_MS
      ) {
        this.lastCreatorReconciliationAt = now;
        await this.enqueueReconciliation("creators:30d");
      }

      for (let processed = 0; processed < 10; processed += 1) {
        const job = await this.claimJob();
        if (!job) break;
        try {
          if (job.target_kind === "account") {
            await this.scanAccount(job.target_id);
          } else if (job.target_kind === "creator") {
            await this.assessCreator(
              job.target_id,
              job.window_days === 7
                ? "7d"
                : job.window_days === 90
                  ? "90d"
                  : job.window_days === null
                    ? "lifetime"
                    : "30d",
            );
          } else {
            await this.reconcile(job.target_id);
          }
          await this.completeJob(job.id, null);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.error(
            { err: error, jobId: job.id, target: job.target_id },
            "Antifraud network scan failed",
          );
          await this.completeJob(job.id, message.slice(0, 1_000));
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async claimJob(): Promise<{
    id: string;
    target_kind: "account" | "creator" | "reconciliation";
    target_id: string;
    window_days: number | null;
  } | null> {
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        id: string;
        target_kind: "account" | "creator" | "reconciliation";
        target_id: string;
        window_days: number | null;
      }>(
        `
          SELECT id, target_kind, target_id, window_days
          FROM network_scan_jobs
          WHERE status = 'pending'
          ORDER BY (requested_by IS NULL), created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `,
      );
      const job = result.rows[0];
      if (!job) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        "UPDATE network_scan_jobs SET status='running', started_at=now() WHERE id=$1",
        [job.id],
      );
      await client.query("COMMIT");
      return job;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async completeJob(id: string, error: string | null): Promise<void> {
    await this.db.antifraud.query(
      `
        UPDATE network_scan_jobs
        SET status=$2, error_text=$3, completed_at=now()
        WHERE id=$1
      `,
      [id, error ? "failed" : "completed", error],
    );
  }

  private async reconcile(target: string): Promise<void> {
    if (target === "accounts") {
      const recent = await this.db.antifraud.query<{ user_id: string }>(
        `
          SELECT user_id
          FROM subjects
          WHERE updated_at >= now() - interval '20 minutes'
          ORDER BY updated_at DESC
          LIMIT 500
        `,
      );
      for (const row of recent.rows) await this.enqueueAccount(row.user_id);
      return;
    }
    const rawWindow = target.split(":", 2)[1] ?? "30d";
    const window = CREATOR_WINDOW_KEYS.includes(rawWindow as CreatorWindowKey)
      ? (rawWindow as CreatorWindowKey)
      : "30d";
    const creators = await this.db.source.query<{ user_id: string }>(
      `
        SELECT DISTINCT user_id
        FROM affiliate_codes
        ORDER BY user_id
        LIMIT 5_000
      `,
    );
    for (const row of creators.rows) {
      await this.enqueueCreator(row.user_id, window);
    }
  }

  async scanAccount(rootUserId: string): Promise<string> {
    const accounts = new Map<string, SourceAccount>();
    const accountDevices = new Map<string, Set<string>>();
    const expandedAccounts = new Set<string>();
    const expandedIps = new Set<string>();
    const expandedDevices = new Set<string>();
    let frontier = new Set([rootUserId]);
    let truncated = false;

    while (frontier.size > 0) {
      const current = [...frontier].filter((id) => !expandedAccounts.has(id));
      frontier = new Set();
      if (current.length === 0) break;
      for (const id of current) expandedAccounts.add(id);

      for (const batch of chunks(current)) {
        const rows = await this.fetchAccountsByIds(batch);
        for (const row of rows) accounts.set(row.id, row);
        const devices = await this.fetchDevicesForAccounts(batch);
        for (const row of devices) {
          const values = accountDevices.get(row.user_id) ?? new Set<string>();
          values.add(row.visitor_id);
          accountDevices.set(row.user_id, values);
        }
      }

      const newIps = [...accounts.values()]
        .map((account) => validIp(account.signup_ip) ?? "")
        .filter((ip) => ip && !expandedIps.has(ip));
      const newDevices = [...accountDevices.values()]
        .flatMap((values) => [...values])
        .filter((device) => !expandedDevices.has(device));
      for (const ip of newIps) expandedIps.add(ip);
      for (const device of newDevices) expandedDevices.add(device);

      for (const batch of chunks(newIps)) {
        const rows = await this.fetchAccountsByIps(batch);
        for (const row of rows) {
          if (!accounts.has(row.id)) frontier.add(row.id);
          accounts.set(row.id, row);
        }
      }
      for (const batch of chunks(newDevices)) {
        const rows = await this.fetchAccountsByDevices(batch);
        for (const row of rows) {
          if (!accounts.has(row.id)) frontier.add(row.id);
          accounts.set(row.id, row);
          const values = accountDevices.get(row.id) ?? new Set<string>();
          values.add(row.visitor_id);
          accountDevices.set(row.id, values);
        }
      }

      if (accounts.size >= MAX_NETWORK_ACCOUNTS) {
        truncated = true;
        break;
      }
    }

    if (!accounts.has(rootUserId)) {
      throw new Error("Account was not found in the source database");
    }
    const graph = await this.buildGraph(accounts, accountDevices);
    const networkKey = stableHash(
      [...accounts.keys()].sort().join("\n"),
    );
    return this.persistNetwork(
      rootUserId,
      networkKey,
      graph.nodes,
      graph.edges,
      graph.signals,
      truncated,
      accounts,
    );
  }

  private async fetchAccountsByIds(ids: string[]): Promise<SourceAccount[]> {
    if (ids.length === 0) return [];
    const result = await this.db.source.query<SourceAccount>(
      `
        SELECT id, username, email, image, signup_ip, country, country_code,
               state, city, affiliate_code, referred_by, is_suspected_alt,
               created_at AT TIME ZONE 'UTC' AS created_at
        FROM "user"
        WHERE id = ANY($1::text[])
      `,
      [ids],
    );
    return result.rows;
  }

  private async fetchAccountsByIps(ips: string[]): Promise<SourceAccount[]> {
    if (ips.length === 0) return [];
    const result = await this.db.source.query<SourceAccount>(
      `
        SELECT id, username, email, image, signup_ip, country, country_code,
               state, city, affiliate_code, referred_by, is_suspected_alt,
               created_at AT TIME ZONE 'UTC' AS created_at
        FROM "user"
        WHERE signup_ip = ANY($1::text[])
        LIMIT ${MAX_NETWORK_ACCOUNTS}
      `,
      [ips],
    );
    return result.rows;
  }

  private async fetchDevicesForAccounts(
    ids: string[],
  ): Promise<Array<{ user_id: string; visitor_id: string }>> {
    if (ids.length === 0) return [];
    const result = await this.db.source.query<{
      user_id: string;
      visitor_id: string;
    }>(
      `
        SELECT DISTINCT user_id, visitor_id
        FROM fingerprints
        WHERE user_id = ANY($1::text[])
          AND confidence >= 0.9
      `,
      [ids],
    );
    return result.rows;
  }

  private async fetchAccountsByDevices(
    devices: string[],
  ): Promise<Array<SourceAccount & { visitor_id: string }>> {
    if (devices.length === 0) return [];
    const result = await this.db.source.query<
      SourceAccount & { visitor_id: string }
    >(
      `
        SELECT DISTINCT u.id, u.username, u.email, u.image, u.signup_ip,
               u.country, u.country_code, u.state, u.city, u.affiliate_code,
               u.referred_by, u.is_suspected_alt,
               u.created_at AT TIME ZONE 'UTC' AS created_at,
               f.visitor_id
        FROM fingerprints f
        JOIN "user" u ON u.id = f.user_id
        WHERE f.visitor_id = ANY($1::text[])
          AND f.confidence >= 0.9
        LIMIT ${MAX_NETWORK_ACCOUNTS}
      `,
      [devices],
    );
    return result.rows;
  }

  private async analysisRules(category: AnalysisRule["category"]): Promise<Map<string, AnalysisRule>> {
    const result = await this.db.antifraud.query<AnalysisRule>(
      `
        SELECT key, category, name, description, enabled, points,
               threshold::float8 AS threshold
        FROM analysis_rules
        WHERE category=$1
      `,
      [category],
    );
    return new Map(result.rows.map((rule) => [rule.key, rule]));
  }

  private addSignal(
    signals: AnalysisSignal[],
    rules: Map<string, AnalysisRule>,
    key: string,
    value: number,
    detail: string,
    category: AnalysisSignal["category"],
  ): void {
    const rule = rules.get(key);
    if (!rule?.enabled || value < rule.threshold) return;
    signals.push({
      key,
      title: rule.name,
      detail,
      points: rule.points,
      value,
      threshold: rule.threshold,
      category,
    });
  }

  private async buildGraph(
    accounts: Map<string, SourceAccount>,
    accountDevices: Map<string, Set<string>>,
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; signals: AnalysisSignal[] }> {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const ipMembers = new Map<string, Set<string>>();
    const deviceMembers = new Map<string, Set<string>>();

    for (const account of accounts.values()) {
      nodes.set(`account:${account.id}`, {
        key: `account:${account.id}`,
        type: "account",
        userId: account.id,
        label: account.username ?? account.id,
        degree: 0,
        metadata: {
          username: account.username,
          maskedEmail: maskEmail(account.email),
          avatarUrl: account.image,
          countryCode: account.country_code,
          affiliateCode: account.affiliate_code,
          referredBy: account.referred_by,
          suspectedAlt: account.is_suspected_alt,
          createdAt: account.created_at.toISOString(),
        },
      });
      const signupIp = validIp(account.signup_ip);
      if (signupIp) {
        const members = ipMembers.get(signupIp) ?? new Set<string>();
        members.add(account.id);
        ipMembers.set(signupIp, members);
      }
      for (const device of accountDevices.get(account.id) ?? []) {
        const members = deviceMembers.get(device) ?? new Set<string>();
        members.add(account.id);
        deviceMembers.set(device, members);
      }
    }

    for (const [ip, members] of ipMembers) {
      const key = `ip:${stableHash(ip)}`;
      nodes.set(key, {
        key,
        type: "ip",
        userId: null,
        label: maskIp(ip),
        degree: members.size,
        secret: ip,
        metadata: { accountCount: members.size },
      });
      for (const userId of members) {
        edges.push({ source: `account:${userId}`, target: key, type: "shared_ip" });
      }
    }
    for (const [device, members] of deviceMembers) {
      const key = `device:${stableHash(device)}`;
      nodes.set(key, {
        key,
        type: "device",
        userId: null,
        label: `Device ${stableHash(device).slice(0, 8)}`,
        degree: members.size,
        metadata: { accountCount: members.size },
      });
      for (const userId of members) {
        edges.push({
          source: `account:${userId}`,
          target: key,
          type: "shared_device",
        });
      }
    }
    for (const edge of edges) {
      const account = nodes.get(edge.source);
      if (account) account.degree += 1;
    }

    const rules = await this.analysisRules("network");
    const signals: AnalysisSignal[] = [];
    const largestIp = Math.max(0, ...[...ipMembers.values()].map((set) => set.size));
    const largestDevice = Math.max(
      0,
      ...[...deviceMembers.values()].map((set) => set.size),
    );
    const suspectedAlts = [...accounts.values()].filter(
      (account) => account.is_suspected_alt,
    ).length;
    const proxyAccounts = await this.proxyAccountCount([...accounts.keys()]);
    this.addSignal(
      signals,
      rules,
      "network_shared_ip",
      largestIp,
      `Largest exact signup-IP group contains ${largestIp} accounts.`,
      "network",
    );
    this.addSignal(
      signals,
      rules,
      "network_shared_device",
      largestDevice,
      `Largest Fingerprint device group contains ${largestDevice} accounts.`,
      "network",
    );
    this.addSignal(
      signals,
      rules,
      "network_dense_component",
      accounts.size,
      `The connected component contains ${accounts.size} accounts.`,
      "network",
    );
    this.addSignal(
      signals,
      rules,
      "network_platform_alt",
      suspectedAlts,
      `${suspectedAlts} connected accounts carry the platform alt flag.`,
      "network",
    );
    this.addSignal(
      signals,
      rules,
      "network_proxy_accounts",
      proxyAccounts,
      `${proxyAccounts} connected accounts have proxy, VPN, Tor, hosting or anonymity evidence.`,
      "network",
    );
    return { nodes: [...nodes.values()], edges, signals };
  }

  private async proxyAccountCount(userIds: string[]): Promise<number> {
    if (userIds.length === 0) return 0;
    const result = await this.db.antifraud.query<{ count: number }>(
      `
        SELECT COUNT(DISTINCT user_id)::int AS count
        FROM provider_checks
        WHERE user_id = ANY($1::text[])
          AND provider = 'proxycheck'
          AND status = 'success'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(signals) signal
            WHERE (signal->>'points')::int > 0
          )
      `,
      [userIds],
    );
    return result.rows[0]?.count ?? 0;
  }

  private async persistNetwork(
    rootUserId: string,
    networkKey: string,
    nodes: GraphNode[],
    edges: GraphEdge[],
    signals: AnalysisSignal[],
    truncated: boolean,
    accounts: Map<string, SourceAccount>,
  ): Promise<string> {
    const scored = scoreAnalysisSignals(signals);
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      const accountRows = [...accounts.values()];
      await client.query(
        `
          INSERT INTO subjects(
            user_id, username, email, avatar_url, signup_ip, country,
            country_code, state, city, affiliate_code, referred_by,
            source_created_at
          )
          SELECT *
          FROM unnest(
            $1::text[], $2::text[], $3::text[], $4::text[], $5::inet[],
            $6::text[], $7::text[], $8::text[], $9::text[], $10::text[],
            $11::text[], $12::timestamptz[]
          )
          ON CONFLICT (user_id) DO UPDATE SET
            username=EXCLUDED.username,
            email=EXCLUDED.email,
            avatar_url=EXCLUDED.avatar_url,
            signup_ip=EXCLUDED.signup_ip,
            country=EXCLUDED.country,
            country_code=EXCLUDED.country_code,
            state=EXCLUDED.state,
            city=EXCLUDED.city,
            affiliate_code=EXCLUDED.affiliate_code,
            referred_by=EXCLUDED.referred_by,
            updated_at=now()
        `,
        [
          accountRows.map((row) => row.id),
          accountRows.map((row) => row.username),
          accountRows.map((row) => row.email),
          accountRows.map((row) => row.image),
          accountRows.map((row) => validIp(row.signup_ip)),
          accountRows.map((row) => row.country),
          accountRows.map((row) => row.country_code),
          accountRows.map((row) => row.state),
          accountRows.map((row) => row.city),
          accountRows.map((row) => row.affiliate_code),
          accountRows.map((row) => row.referred_by),
          accountRows.map((row) => row.created_at),
        ],
      );
      const snapshot = await client.query<{ id: string }>(
        `
          INSERT INTO network_snapshots(
            root_user_id, network_key, status, raw_score, score, severity,
            signals, node_count, edge_count, account_count, ip_count,
            device_count, truncated
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
          ) RETURNING id
        `,
        [
          rootUserId,
          networkKey,
          truncated ? "partial" : "ready",
          scored.rawScore,
          scored.score,
          scored.severity,
          JSON.stringify(signals),
          nodes.length,
          edges.length,
          nodes.filter((node) => node.type === "account").length,
          nodes.filter((node) => node.type === "ip").length,
          nodes.filter((node) => node.type === "device").length,
          truncated,
        ],
      );
      const snapshotId = snapshot.rows[0]?.id;
      if (!snapshotId) throw new Error("Failed to persist network snapshot");
      await client.query(
        `
          INSERT INTO network_nodes(
            snapshot_id, node_key, node_type, user_id, label, metadata, degree
          )
          SELECT $1, *
          FROM unnest(
            $2::text[], $3::text[], $4::text[], $5::text[],
            $6::jsonb[], $7::int[]
          )
        `,
        [
          snapshotId,
          nodes.map((node) => node.key),
          nodes.map((node) => node.type),
          nodes.map((node) => node.userId),
          nodes.map((node) => node.label),
          nodes.map((node) => JSON.stringify(node.metadata)),
          nodes.map((node) => node.degree),
        ],
      );
      const secrets = nodes.filter((node) => node.secret);
      if (secrets.length > 0) {
        await client.query(
          `
            INSERT INTO network_node_secrets(snapshot_id, node_key, exact_value)
            SELECT $1, * FROM unnest($2::text[], $3::text[])
          `,
          [
            snapshotId,
            secrets.map((node) => node.key),
            secrets.map((node) => node.secret),
          ],
        );
      }
      if (edges.length > 0) {
        await client.query(
          `
            INSERT INTO network_edges(
              snapshot_id, source_key, target_key, edge_type
            )
            SELECT $1, * FROM unnest(
              $2::text[], $3::text[], $4::text[]
            )
          `,
          [
            snapshotId,
            edges.map((edge) => edge.source),
            edges.map((edge) => edge.target),
            edges.map((edge) => edge.type),
          ],
        );
      }
      await client.query("COMMIT");
      return snapshotId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async assessCreator(
    creatorUserId: string,
    window: CreatorWindowKey,
  ): Promise<void> {
    const days = windowDays(window);
    const codesResult = await this.db.source.query<{ code: string }>(
      "SELECT code FROM affiliate_codes WHERE user_id=$1 ORDER BY created_at",
      [creatorUserId],
    );
    const codes = codesResult.rows.map((row) => row.code.toUpperCase());
    if (codes.length === 0) return;
    const cohortResult = await this.db.source.query<{
      referred_user_id: string;
    }>(
      `
        SELECT DISTINCT referred_user_id
        FROM affiliate_code_usages
        WHERE affiliate_user_id=$1
          AND referred_user_id <> $1
          AND ($2::int IS NULL OR created_at >= (now() AT TIME ZONE 'UTC') - ($2::int * interval '1 day'))
        LIMIT 50_000
      `,
      [creatorUserId, days],
    );
    const cohortIds = cohortResult.rows.map((row) => row.referred_user_id);
    const accounts = new Map<string, SourceAccount>();
    for (const batch of chunks(cohortIds)) {
      for (const account of await this.fetchAccountsByIds(batch)) {
        accounts.set(account.id, account);
      }
    }
    const usage = await this.db.source.query<{
      deposits: string;
      wager: string;
      referrer_cut: string;
      user_bonus: string;
    }>(
      `
        SELECT
          COALESCE(SUM(deposit_amount_usd),0)::text AS deposits,
          COALESCE(SUM(wager_amount_usd),0)::text AS wager,
          COALESCE(SUM(referrer_cut_usd),0)::text AS referrer_cut,
          COALESCE(SUM(user_bonus_usd),0)::text AS user_bonus
        FROM affiliate_code_usages
        WHERE affiliate_user_id=$1
          AND referred_user_id <> $1
          AND ($2::int IS NULL OR created_at >= (now() AT TIME ZONE 'UTC') - ($2::int * interval '1 day'))
      `,
      [creatorUserId, days],
    );
    const depositSignals = cohortIds.length
      ? await this.db.source.query<{
          reused_wallet_accounts: number;
          reused_wallet_groups: unknown;
          synchronized_accounts: number;
          withdrawals: string;
        }>(
          `
            WITH deposits AS (
              SELECT user_id, source_address, date_trunc('second', created_at) AS second
              FROM ledger_transactions
              WHERE user_id = ANY($1::text[])
                AND type::text='deposit' AND status::text='completed'
                AND ($2::int IS NULL OR created_at >= (now() AT TIME ZONE 'UTC') - ($2::int * interval '1 day'))
            ),
            wallets AS (
              SELECT
                COUNT(DISTINCT user_id)::int AS accounts,
                array_agg(DISTINCT user_id ORDER BY user_id) AS member_ids
              FROM deposits
              WHERE source_address IS NOT NULL
              GROUP BY source_address
              HAVING COUNT(DISTINCT user_id) >= 2
            ),
            synchronized AS (
              SELECT COUNT(DISTINCT user_id)::int AS accounts
              FROM deposits
              GROUP BY second
              HAVING COUNT(DISTINCT user_id) >= 2
              ORDER BY accounts DESC LIMIT 1
            ),
            withdrawals AS (
              SELECT COALESCE(SUM(total_value_usd),0)::text AS amount
              FROM card_withdrawal_requests
              WHERE user_id = ANY($1::text[])
                AND status::text IN ('completed','shipped')
                AND ($2::int IS NULL OR created_at >= (now() AT TIME ZONE 'UTC') - ($2::int * interval '1 day'))
            )
            SELECT
              COALESCE((SELECT MAX(accounts) FROM wallets),0)::int AS reused_wallet_accounts,
              COALESCE((
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'accountCount', accounts,
                    'memberIds', member_ids
                  )
                  ORDER BY accounts DESC, member_ids::text
                )
                FROM wallets
              ), '[]'::jsonb) AS reused_wallet_groups,
              COALESCE((SELECT accounts FROM synchronized),0)::int AS synchronized_accounts,
              (SELECT amount FROM withdrawals) AS withdrawals
          `,
          [cohortIds, days],
        )
      : { rows: [] };

    const ipMembers = new Map<string, SourceAccount[]>();
    const countryCounts = new Map<string, number>();
    const hourlyCounts = new Map<string, number>();
    let disposable = 0;
    for (const account of accounts.values()) {
      if (account.signup_ip) {
        const members = ipMembers.get(account.signup_ip) ?? [];
        members.push(account);
        ipMembers.set(account.signup_ip, members);
      }
      if (account.country_code) {
        const country = account.country_code.toUpperCase();
        countryCounts.set(country, (countryCounts.get(country) ?? 0) + 1);
      }
      const hour = account.created_at.toISOString().slice(0, 13);
      hourlyCounts.set(hour, (hourlyCounts.get(hour) ?? 0) + 1);
      if (disposableEmailDomain(account.email)) disposable += 1;
    }
    const sharedIpGroups = [...ipMembers.values()]
      .filter((members) => members.length >= 2)
      .sort((left, right) => right.length - left.length);
    const ipEvidenceGroups = sharedIpGroups
      .slice(0, 20)
      .map((members) => this.creatorEvidenceGroup(members));
    const walletEvidenceGroups = this.walletEvidenceGroups(
      depositSignals.rows[0]?.reused_wallet_groups,
      accounts,
    );
    const largestIp = Math.max(
      0,
      ...sharedIpGroups.map((members) => members.length),
    );
    const largestCountry = Math.max(0, ...countryCounts.values());
    const largestHour = Math.max(0, ...hourlyCounts.values());
    const cohortSize = accounts.size;
    const countryRatio = cohortSize ? (largestCountry / cohortSize) * 100 : 0;
    const disposableRatio = cohortSize ? (disposable / cohortSize) * 100 : 0;
    const proxyCount = await this.proxyAccountCount(cohortIds);
    const proxyRatio = cohortSize ? (proxyCount / cohortSize) * 100 : 0;
    const networkMetrics = await this.creatorNetworkMetrics(cohortIds);
    const networkRoots = [
      ...new Set([
        ...networkMetrics.networkRoots,
        ...ipEvidenceGroups.map((group) => group.rootUserId),
      ]),
    ].slice(0, 20);
    const detectedIpAccounts = new Set(
      ipEvidenceGroups.flatMap((group) =>
        group.members.map((member) => member.userId),
      ),
    ).size;

    const deposits = numeric(usage.rows[0]?.deposits);
    const wager = numeric(usage.rows[0]?.wager);
    const withdrawals = numeric(depositSignals.rows[0]?.withdrawals);
    const expectedGgr = wager * 0.1099;
    const actualValue = deposits - withdrawals;
    const ggrGap = expectedGgr - actualValue;
    const ggrShortfallPct =
      expectedGgr >= 25 ? Math.max(0, (ggrGap / expectedGgr) * 100) : 0;

    const rules = await this.analysisRules("creator");
    const signals: AnalysisSignal[] = [];
    this.addSignal(signals, rules, "creator_network_accounts", networkMetrics.connectedAccounts, `${networkMetrics.connectedAccounts} referred accounts appear in shared account networks.`, "network");
    this.addSignal(signals, rules, "creator_external_accounts", networkMetrics.externalAccounts, `${networkMetrics.externalAccounts} accounts outside the referred cohort are directly connected.`, "network");
    this.addSignal(signals, rules, "creator_signup_burst", largestHour, `Largest one-hour referred-account signup burst contains ${largestHour} accounts.`, "affiliate");
    this.addSignal(signals, rules, "creator_ip_chain", largestIp, `Largest exact signup-IP chain contains ${largestIp} referred accounts.`, "affiliate");
    this.addSignal(signals, rules, "creator_country_cluster", countryRatio, `${countryRatio.toFixed(1)}% of referred accounts are concentrated in one country.`, "affiliate");
    this.addSignal(signals, rules, "creator_proxy_ratio", proxyRatio, `${proxyRatio.toFixed(1)}% of assessed referred accounts have anonymous-network evidence.`, "affiliate");
    this.addSignal(signals, rules, "creator_disposable_ratio", disposableRatio, `${disposableRatio.toFixed(1)}% of referred accounts use disposable email domains.`, "affiliate");
    this.addSignal(signals, rules, "creator_wallet_reuse", depositSignals.rows[0]?.reused_wallet_accounts ?? 0, `${depositSignals.rows[0]?.reused_wallet_accounts ?? 0} referred accounts share a deposit source wallet.`, "behavior");
    this.addSignal(signals, rules, "creator_synchronized_deposits", depositSignals.rows[0]?.synchronized_accounts ?? 0, `${depositSignals.rows[0]?.synchronized_accounts ?? 0} referred accounts deposited in the same second.`, "behavior");
    this.addSignal(signals, rules, "creator_ggr_shortfall", ggrShortfallPct, `Referred-account value trails expected GGR by ${ggrShortfallPct.toFixed(1)}%.`, "behavior");
    const scored = scoreAnalysisSignals(signals);

    await this.db.antifraud.query(
      `
        INSERT INTO creator_fraud_assessments(
          creator_user_id, window_key, codes, raw_score, score, severity,
          breakdown, signals, metrics, partial, assessed_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
        ON CONFLICT (creator_user_id, window_key) DO UPDATE SET
          codes=EXCLUDED.codes,
          raw_score=EXCLUDED.raw_score,
          score=EXCLUDED.score,
          severity=EXCLUDED.severity,
          breakdown=EXCLUDED.breakdown,
          signals=EXCLUDED.signals,
          metrics=EXCLUDED.metrics,
          partial=EXCLUDED.partial,
          assessed_at=now()
      `,
      [
        creatorUserId,
        window,
        JSON.stringify(codes),
        scored.rawScore,
        scored.score,
        scored.severity,
        JSON.stringify(scored.breakdown),
        JSON.stringify(signals),
        JSON.stringify({
          cohortSize,
          connectedAccounts: networkMetrics.connectedAccounts,
          externalAccounts: networkMetrics.externalAccounts,
          networkCount: networkMetrics.networkCount,
          networkRoots,
          detectedIpAccounts,
          ipGroups: ipEvidenceGroups,
          walletGroups: walletEvidenceGroups,
          depositsUsd: deposits,
          wagerUsd: wager,
          withdrawalsUsd: withdrawals,
          expectedGgrUsd: expectedGgr,
          actualValueUsd: actualValue,
          ggrGapUsd: ggrGap,
          proxyCount,
          disposableCount: disposable,
          largestIpCluster: largestIp,
          largestCountryCluster: largestCountry,
          largestSignupBurst: largestHour,
          reusedWalletAccounts: depositSignals.rows[0]?.reused_wallet_accounts ?? 0,
          synchronizedDepositAccounts: depositSignals.rows[0]?.synchronized_accounts ?? 0,
        }),
        false,
      ],
    );

    const queued = await Promise.allSettled(
      ipEvidenceGroups.map((group) =>
        this.enqueueAccount(group.rootUserId, `creator:${creatorUserId}`),
      ),
    );
    const failedQueues = queued.filter(
      (result) => result.status === "rejected",
    ).length;
    if (failedQueues > 0) {
      this.log.warn(
        { creatorUserId, failedQueues },
        "Some creator evidence networks could not be queued",
      );
    }
  }

  private creatorEvidenceGroup(
    sourceMembers: SourceAccount[],
  ): CreatorEvidenceGroup {
    const members = sourceMembers
      .map((account) => ({
        userId: account.id,
        username: account.username,
      }))
      .sort((left, right) =>
        (left.username ?? left.userId).localeCompare(
          right.username ?? right.userId,
        ),
      );
    return {
      accountCount: members.length,
      rootUserId: members[0]?.userId ?? sourceMembers[0]!.id,
      members,
    };
  }

  private walletEvidenceGroups(
    rawGroups: unknown,
    accounts: Map<string, SourceAccount>,
  ): CreatorEvidenceGroup[] {
    if (!Array.isArray(rawGroups)) return [];
    const groups: CreatorEvidenceGroup[] = [];
    for (const rawGroup of rawGroups.slice(0, 20)) {
      if (!rawGroup || typeof rawGroup !== "object") continue;
      const memberIds = (rawGroup as { memberIds?: unknown }).memberIds;
      if (!Array.isArray(memberIds)) continue;
      const members = memberIds
        .filter((value): value is string => typeof value === "string")
        .map((userId) => ({
          userId,
          username: accounts.get(userId)?.username ?? null,
        }))
        .sort((left, right) =>
          (left.username ?? left.userId).localeCompare(
            right.username ?? right.userId,
          ),
        );
      if (members.length < 2) continue;
      groups.push({
        accountCount: members.length,
        rootUserId: members[0]!.userId,
        members,
      });
    }
    return groups;
  }

  private async creatorNetworkMetrics(userIds: string[]): Promise<{
    connectedAccounts: number;
    externalAccounts: number;
    networkCount: number;
    networkRoots: string[];
  }> {
    if (userIds.length === 0) {
      return {
        connectedAccounts: 0,
        externalAccounts: 0,
        networkCount: 0,
        networkRoots: [],
      };
    }
    const result = await this.db.antifraud.query<{
      connected_accounts: number;
      external_accounts: number;
      network_count: number;
      network_roots: string[];
    }>(
      `
        WITH latest AS (
          SELECT DISTINCT ON (network_key) id, network_key
          FROM network_snapshots
          ORDER BY network_key, scanned_at DESC
        ),
        matching AS (
          SELECT DISTINCT l.id, l.network_key
          FROM latest l
          JOIN network_nodes n ON n.snapshot_id=l.id
          WHERE n.user_id = ANY($1::text[])
        )
        SELECT
          COUNT(DISTINCT n.user_id) FILTER (
            WHERE n.user_id = ANY($1::text[])
          )::int AS connected_accounts,
          COUNT(DISTINCT n.user_id) FILTER (
            WHERE n.user_id IS NOT NULL AND NOT (n.user_id = ANY($1::text[]))
          )::int AS external_accounts,
          COUNT(DISTINCT m.network_key)::int AS network_count,
          COALESCE(array_agg(DISTINCT ns.root_user_id), '{}'::text[]) AS network_roots
        FROM matching m
        JOIN network_snapshots ns ON ns.id=m.id
        JOIN network_nodes n ON n.snapshot_id=m.id
      `,
      [userIds],
    );
    return {
      connectedAccounts: result.rows[0]?.connected_accounts ?? 0,
      externalAccounts: result.rows[0]?.external_accounts ?? 0,
      networkCount: result.rows[0]?.network_count ?? 0,
      networkRoots: result.rows[0]?.network_roots ?? [],
    };
  }
}
