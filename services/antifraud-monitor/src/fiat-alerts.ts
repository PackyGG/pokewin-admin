import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Config } from "./config.js";
import type { Databases } from "./db.js";

const CURSOR_STREAM = "fiat-problems";
const HIGH_RISK_CURSOR_STREAM = "fiat-high-risk";
const BATCH_SIZE = 100;
const SEND_TIMEOUT_MS = 5_000;
const UTC = "AT TIME ZONE 'UTC'";

export const FIAT_PROBLEM_CODES = [
  "high_risk",
  "fiat_locked_account",
  "failed",
  "review",
  "disputed",
  "partially_refunded",
  "refunded",
  "checkout_creating_stale",
  "pending_stale",
  "webhook_failed",
  "blacklisted_email_domain",
] as const;

export type FiatProblemCode = (typeof FIAT_PROBLEM_CODES)[number];

export const FIAT_RISK_PROBLEM_CODES = [
  "high_risk",
  "fiat_locked_account",
  "blacklisted_email_domain",
] as const satisfies readonly FiatProblemCode[];

export function isFiatRiskProblem(code: FiatProblemCode): boolean {
  return (FIAT_RISK_PROBLEM_CODES as readonly FiatProblemCode[]).includes(code);
}

export type FiatProblem = {
  source_kind: "deposit_intent" | "payment_webhook" | "signup";
  source_id: string;
  problem_code: FiatProblemCode;
  user_id: string | null;
  username: string | null;
  details: Record<string, unknown>;
  occurred_at: Date;
};

type PendingFiatAlert = FiatProblem & {
  attempt_count: number;
};

type DiscordPayload = {
  username: string;
  content: string;
  allowed_mentions: { parse: [] };
  embeds: Array<{
    title: string;
    description: string;
    url: string;
    color: number;
    fields: Array<{ name: string; value: string; inline: boolean }>;
    footer: { text: string };
    timestamp: string;
  }>;
  components: Array<{
    type: 1;
    components: Array<{
      type: 2;
      style: 5;
      label: string;
      url: string;
    }>;
  }>;
};

export function discordRetryAfterSeconds(headers: Headers): number | null {
  const raw =
    headers.get("retry-after") ?? headers.get("x-ratelimit-reset-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(300, Math.max(1, Math.ceil(seconds)));
}

function clean(value: unknown, maxLength = 1_024): string {
  const text = String(value ?? "")
    .replace(/@everyone/gi, "everyone")
    .replace(/@here/gi, "here")
    .replace(/<@!?(\d+)>/g, "user $1")
    .replace(/<@&(\d+)>/g, "role $1")
    .trim();
  if (text.length === 0) return "Not provided";
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength - 1)}…`;
}

function detail(
  details: Record<string, unknown>,
  key: string,
): string | null {
  const value = details[key];
  return value === null || value === undefined || value === ""
    ? null
    : String(value);
}

function formatUsdCents(value: unknown): string | null {
  const cents = Number(value);
  if (!Number.isInteger(cents) || cents < 0) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function fiatProblemTitle(code: FiatProblemCode): string {
  switch (code) {
    case "high_risk":
      return "High-risk fiat deposit";
    case "fiat_locked_account":
      return "High-risk fiat deposit from locked account";
    case "failed":
      return "Fiat deposit failed";
    case "review":
      return "Fiat deposit needs review";
    case "disputed":
      return "Fiat deposit disputed";
    case "partially_refunded":
      return "Fiat deposit partially refunded";
    case "refunded":
      return "Fiat deposit refunded";
    case "checkout_creating_stale":
      return "Fiat checkout creation stalled";
    case "pending_stale":
      return "Fiat deposit pending too long";
    case "webhook_failed":
      return "Fiat webhook processing failed";
    case "blacklisted_email_domain":
      return "Blacklisted email domain blocked";
  }
}

export function buildFiatDiscordPayload(
  dashboardUrl: string,
  problem: FiatProblem,
): DiscordPayload {
  const details = problem.details;
  const amount = formatUsdCents(details.credited_amount_cents);
  const fields: DiscordPayload["embeds"][number]["fields"] = [];

  if (problem.username || problem.user_id) {
    fields.push({
      name: "Account",
      value: clean(
        [problem.username, problem.user_id].filter(Boolean).join(" · "),
      ),
      inline: true,
    });
  }
  if (amount) {
    fields.push({ name: "Credit amount", value: amount, inline: true });
  }
  const status = detail(details, "status");
  if (status) {
    fields.push({ name: "Status", value: clean(status), inline: true });
  }
  const providerStatus = detail(details, "provider_payment_status");
  if (providerStatus) {
    fields.push({
      name: "Provider status",
      value: clean(providerStatus),
      inline: true,
    });
  }
  const eventType = detail(details, "event_type");
  if (eventType) {
    fields.push({
      name: "Webhook event",
      value: clean(eventType),
      inline: true,
    });
  }
  const attempts = detail(details, "attempt_count");
  if (attempts) {
    fields.push({ name: "Attempts", value: clean(attempts), inline: true });
  }
  const riskScore = detail(details, "risk_score");
  if (riskScore) {
    fields.push({
      name: "Risk score",
      value: `${clean(riskScore)}/100`,
      inline: true,
    });
  }
  const lockedMethods = detail(details, "locked_deposits_fiat");
  if (lockedMethods) {
    fields.push({
      name: "Fiat deposit lock",
      value: clean(lockedMethods),
      inline: true,
    });
  }
  const checkoutEmail = detail(details, "checkout_email");
  if (checkoutEmail) {
    fields.push({
      name: "Whop checkout email",
      value: clean(checkoutEmail),
      inline: false,
    });
  }
  const signupEmail =
    problem.source_kind === "signup" ? detail(details, "email") : null;
  if (signupEmail) {
    fields.push({
      name: "Signup email",
      value: clean(signupEmail),
      inline: false,
    });
  }
  const emailDomain = detail(details, "email_domain");
  const patternMatch =
    detail(details, "email_risk_type") === "gmail_dot_fragmentation";
  if (emailDomain) {
    fields.push({
      name: patternMatch ? "Email provider" : "Blacklisted domain",
      value: clean(emailDomain),
      inline: true,
    });
  }
  const emailRiskReason = detail(details, "email_risk_reason");
  if (emailRiskReason) {
    fields.push({
      name: "Email risk",
      value: clean(emailRiskReason),
      inline: false,
    });
  }
  const reason =
    detail(details, "failure_reason") ??
    detail(details, "last_error") ??
    detail(details, "summary") ??
    detail(details, "locked_deposits_reason");
  if (reason) {
    fields.push({
      name: "Failure detail",
      value: clean(reason),
      inline: false,
    });
  }

  const url = new URL(dashboardUrl).toString();
  const description =
    problem.problem_code === "blacklisted_email_domain"
      ? patternMatch
        ? "The email matched the Gmail dot-fragmentation fraud pattern. Crypto and item withdrawals are locked."
        : problem.source_kind === "signup"
        ? "A new signup matched the email-domain blacklist. Crypto and item withdrawals are locked."
        : "A Whop checkout matched the email-domain blacklist. Crypto and item withdrawals are locked."
      : problem.problem_code === "high_risk"
      ? `Whop fiat intent ${clean(details.intent_id ?? problem.source_id, 256)} received the canonical high-risk verdict.`
      : problem.problem_code === "fiat_locked_account"
      ? `Whop fiat intent ${clean(details.intent_id ?? problem.source_id, 256)} was created for an account with fiat deposits locked.`
      : problem.source_kind === "deposit_intent"
      ? `Whop fiat intent ${clean(details.intent_id ?? problem.source_id, 256)} requires attention.`
      : `Whop payment webhook ${clean(details.provider_event_id ?? problem.source_id, 256)} could not be processed.`;

  return {
    username: "PackyGG Fiat",
    content: "",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: patternMatch
          ? "Suspicious checkout email blocked"
          : fiatProblemTitle(problem.problem_code),
        description,
        url,
        color:
          problem.problem_code === "review" ||
          problem.problem_code === "pending_stale"
            ? 0xf59e0b
            : 0xef4444,
        fields,
        footer: { text: "PackyGG Fiat Operations" },
        timestamp: problem.occurred_at.toISOString(),
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "Open Fiat Operations",
            url,
          },
        ],
      },
    ],
  };
}

export async function fetchFiatProblems(
  source: pg.Pool,
  cursor: { occurredAt: Date; sourceId: string },
  limit = BATCH_SIZE,
): Promise<FiatProblem[]> {
  const result = await source.query<FiatProblem>(
    `
      WITH candidates AS (
        SELECT
          'deposit_intent'::text AS source_kind,
          fdi.id::text || ':fiat_locked_account' AS source_id,
          'fiat_locked_account'::text AS problem_code,
          fdi.user_id,
          COALESCE(u.display_username, u.username) AS username,
          jsonb_build_object(
            'intent_id', fdi.id::text,
            'provider', fdi.provider,
            'status', fdi.status,
            'currency', fdi.currency,
            'requested_amount_cents', fdi.requested_amount_cents,
            'credited_amount_cents', fdi.credited_amount_cents,
            'actual_customer_total_cents', fdi.actual_customer_total_cents,
            'provider_payment_status', fdi.provider_payment_status,
            'provider_checkout_id', fdi.provider_checkout_id,
            'provider_payment_id', fdi.provider_payment_id,
            'locked_deposits_fiat',
              array_to_string(ufl.locked_deposits_fiat, ', '),
            'locked_deposits_at', ufl.locked_deposits_at,
            'locked_deposits_reason', ufl.locked_deposits_reason
          ) AS details,
          fdi.created_at ${UTC} AS occurred_at
        FROM fiat_deposit_intents fdi
        JOIN user_feature_locks ufl ON ufl.user_id = fdi.user_id
        LEFT JOIN "user" u ON u.id = fdi.user_id
        WHERE cardinality(ufl.locked_deposits_fiat) > 0
          AND (
            ufl.locked_deposits_at IS NULL
            OR ufl.locked_deposits_at <= fdi.created_at
          )

        UNION ALL

        SELECT
          'deposit_intent'::text AS source_kind,
          fdi.id::text || ':' ||
            CASE
              WHEN fdi.status = 'checkout_creating'
                THEN 'checkout_creating_stale'
              WHEN fdi.status = 'pending' THEN 'pending_stale'
              ELSE fdi.status
            END AS source_id,
          CASE
            WHEN fdi.status = 'checkout_creating'
              THEN 'checkout_creating_stale'
            WHEN fdi.status = 'pending' THEN 'pending_stale'
            ELSE fdi.status
          END AS problem_code,
          fdi.user_id,
          COALESCE(u.display_username, u.username) AS username,
          jsonb_build_object(
            'intent_id', fdi.id::text,
            'provider', fdi.provider,
            'status', fdi.status,
            'currency', fdi.currency,
            'requested_amount_cents', fdi.requested_amount_cents,
            'credited_amount_cents', fdi.credited_amount_cents,
            'actual_customer_total_cents', fdi.actual_customer_total_cents,
            'provider_payment_status', fdi.provider_payment_status,
            'provider_checkout_id', fdi.provider_checkout_id,
            'provider_payment_id', fdi.provider_payment_id,
            'failure_reason', fdi.failure_reason
          ) AS details,
          CASE
            WHEN fdi.status = 'checkout_creating'
              THEN fdi.updated_at + interval '15 minutes'
            WHEN fdi.status = 'pending'
              THEN fdi.updated_at + interval '60 minutes'
            ELSE fdi.updated_at
          END ${UTC} AS occurred_at
        FROM fiat_deposit_intents fdi
        LEFT JOIN "user" u ON u.id = fdi.user_id
        WHERE fdi.status IN (
          'failed',
          'review',
          'disputed',
          'partially_refunded',
          'refunded',
          'checkout_creating',
          'pending'
        )

      )
      SELECT
        source_kind,
        source_id,
        problem_code,
        user_id,
        username,
        details,
        occurred_at
      FROM candidates
      WHERE (occurred_at, source_id) >
        (date_trunc('milliseconds', $1::timestamptz ${UTC}), $2::text)
        AND occurred_at <= now() ${UTC}
      ORDER BY occurred_at, source_id
      LIMIT $3
    `,
    [cursor.occurredAt, cursor.sourceId, limit],
  );
  return result.rows;
}

export async function fetchFailedPaymentWebhooks(
  source: pg.Pool,
  limit = 1_000,
): Promise<FiatProblem[]> {
  const result = await source.query<FiatProblem>(
    `
      SELECT
        'payment_webhook'::text AS source_kind,
        pwe.id::text || ':webhook_failed' AS source_id,
        'webhook_failed'::text AS problem_code,
        fdi.user_id,
        COALESCE(u.display_username, u.username) AS username,
        jsonb_build_object(
          'webhook_event_id', pwe.id::text,
          'provider_event_id', pwe.provider_event_id,
          'provider_resource_id', pwe.provider_resource_id,
          'event_type', pwe.event_type,
          'status', pwe.processing_status,
          'attempt_count', pwe.attempt_count,
          'last_error', pwe.last_error,
          'intent_id', fdi.id::text,
          'credited_amount_cents', fdi.credited_amount_cents
        ) AS details,
        pwe.received_at ${UTC} AS occurred_at
      FROM payment_webhook_events pwe
      LEFT JOIN LATERAL (
        SELECT
          candidate.id,
          candidate.user_id,
          candidate.credited_amount_cents
        FROM fiat_deposit_intents candidate
        WHERE candidate.provider_payment_id = pwe.provider_resource_id
           OR candidate.provider_checkout_id = pwe.provider_resource_id
        ORDER BY
          CASE
            WHEN candidate.provider_payment_id = pwe.provider_resource_id
              THEN 0
            ELSE 1
          END
        LIMIT 1
      ) fdi ON true
      LEFT JOIN "user" u ON u.id = fdi.user_id
      WHERE pwe.processing_status = 'failed'
        AND pwe.received_at >= (now() ${UTC}) - interval '30 days'
      ORDER BY pwe.received_at DESC, pwe.id
      LIMIT $1
    `,
    [limit],
  );
  return result.rows;
}

export async function fetchHighRiskFiatProblems(
  antifraud: pg.Pool,
  cursor: { occurredAt: Date; sourceId: string },
  limit = BATCH_SIZE,
): Promise<FiatProblem[]> {
  const result = await antifraud.query<FiatProblem>(
    `
      SELECT
        'deposit_intent'::text AS source_kind,
        fda.deposit_intent_id::text || ':high_risk' AS source_id,
        'high_risk'::text AS problem_code,
        fda.user_id,
        fda.username,
        jsonb_build_object(
          'intent_id', fda.deposit_intent_id::text,
          'provider', fda.provider,
          'status', fda.status,
          'currency', fda.currency,
          'credited_amount_cents',
            round(fda.credited_amount_usd * 100)::bigint,
          'provider_payment_status', fda.provider_payment_status,
          'provider_risk_score', fda.provider_risk_score,
          'risk_score', fda.risk_score,
          'verdict', fda.verdict,
          'recommendation', fda.recommendation,
          'summary', fda.summary
        ) AS details,
        fda.assessed_at AS occurred_at
      FROM fiat_deposit_assessments fda
      WHERE fda.verdict = 'bad'
        AND (
          fda.assessed_at,
          fda.deposit_intent_id::text || ':high_risk'
        ) >
          ($1::timestamptz, $2::text)
      ORDER BY fda.assessed_at, fda.deposit_intent_id
      LIMIT $3
    `,
    [cursor.occurredAt, cursor.sourceId, limit],
  );
  return result.rows;
}

export class FiatProblemAlerts {
  constructor(
    private readonly config: Config,
    private readonly db: Databases,
    private readonly log: FastifyBaseLogger,
  ) {}

  async ensureCursor(): Promise<void> {
    await this.db.antifraud.query(
      `
        INSERT INTO source_cursors(stream, occurred_at, source_id)
        VALUES
          ($1, now() - interval '2 minutes', ''),
          ($2, now() - interval '2 minutes', '')
        ON CONFLICT (stream) DO NOTHING
      `,
      [CURSOR_STREAM, HIGH_RISK_CURSOR_STREAM],
    );
  }

  async process(): Promise<void> {
    await this.captureHighRiskAssessments();
    await this.capture();
    await this.deliver();
  }

  private async captureHighRiskAssessments(): Promise<void> {
    for (;;) {
      const cursor = await this.db.antifraud.query<{
        occurred_at: Date;
        source_id: string;
      }>(
        `
          SELECT occurred_at, source_id
          FROM source_cursors
          WHERE stream = $1
        `,
        [HIGH_RISK_CURSOR_STREAM],
      );
      const row = cursor.rows[0];
      if (!row) throw new Error("High-risk fiat cursor is missing");

      const problems = await fetchHighRiskFiatProblems(
        this.db.antifraud,
        { occurredAt: row.occurred_at, sourceId: row.source_id },
      );
      if (problems.length === 0) return;

      await this.storeProblems(problems);
      const last = problems.at(-1);
      if (!last) throw new Error("High-risk fiat batch was empty");
      await this.db.antifraud.query(
        `
          UPDATE source_cursors
          SET occurred_at = $2, source_id = $3, updated_at = now()
          WHERE stream = $1
        `,
        [HIGH_RISK_CURSOR_STREAM, last.occurred_at, last.source_id],
      );

      if (problems.length < BATCH_SIZE) return;
    }
  }

  private async capture(): Promise<void> {
    const failedWebhooks = await fetchFailedPaymentWebhooks(this.db.source);
    if (failedWebhooks.length > 0) {
      await this.storeProblems(failedWebhooks);
    }

    for (;;) {
      const cursor = await this.db.antifraud.query<{
        occurred_at: Date;
        source_id: string;
      }>(
        `
          SELECT occurred_at, source_id
          FROM source_cursors
          WHERE stream = $1
        `,
        [CURSOR_STREAM],
      );
      const row = cursor.rows[0];
      if (!row) throw new Error("Fiat problem cursor is missing");

      const problems = await fetchFiatProblems(
        this.db.source,
        { occurredAt: row.occurred_at, sourceId: row.source_id },
      );
      if (problems.length === 0) return;

      await this.storeProblems(problems);
      const last = problems.at(-1);
      if (!last) throw new Error("Fiat problem batch was empty");
      await this.db.antifraud.query(
        `
          UPDATE source_cursors
          SET occurred_at = $2, source_id = $3, updated_at = now()
          WHERE stream = $1
        `,
        [CURSOR_STREAM, last.occurred_at, last.source_id],
      );

      if (problems.length < BATCH_SIZE) return;
    }
  }

  private async storeProblems(problems: readonly FiatProblem[]): Promise<void> {
    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      for (const problem of problems) {
        await client.query(
          `
            INSERT INTO fiat_problem_alert_outbox (
              source_kind, source_id, problem_code, user_id, username,
              details, occurred_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (source_kind, source_id) DO NOTHING
          `,
          [
            problem.source_kind,
            problem.source_id,
            problem.problem_code,
            problem.user_id,
            problem.username,
            problem.details,
            problem.occurred_at,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async deliver(): Promise<void> {
    const operationsWebhookUrl = this.config.FIAT_ALERT_DISCORD_WEBHOOK_URL;
    const riskWebhookUrl =
      this.config.ANTIFRAUD_WITHDRAWAL_HOLD_DISCORD_WEBHOOK_URL;
    if (!operationsWebhookUrl && !riskWebhookUrl) return;

    const pending = await this.db.antifraud.query<PendingFiatAlert>(
      `
        SELECT
          source_kind, source_id, problem_code, user_id, username, details,
          occurred_at, attempt_count
        FROM fiat_problem_alert_outbox
        WHERE discord_delivered_at IS NULL
          AND next_attempt_at <= now()
          AND (
            (problem_code = ANY($1::text[]) AND $2::boolean)
            OR
            (problem_code <> ALL($1::text[]) AND $3::boolean)
          )
        ORDER BY occurred_at
        LIMIT 1
      `,
      [
        FIAT_RISK_PROBLEM_CODES,
        Boolean(riskWebhookUrl),
        Boolean(operationsWebhookUrl),
      ],
    );

    for (const problem of pending.rows) {
      const webhookUrl = isFiatRiskProblem(problem.problem_code)
        ? riskWebhookUrl
        : operationsWebhookUrl;
      if (!webhookUrl) continue;
      const delivery = await this.send(webhookUrl, problem);
      const attempt = problem.attempt_count + 1;
      const retrySeconds =
        delivery.retryAfterSeconds ??
        Math.min(300, 2 ** Math.min(attempt, 8));
      await this.db.antifraud.query(
        `
          UPDATE fiat_problem_alert_outbox
          SET
            discord_delivered_at = CASE
              WHEN $3::boolean THEN COALESCE(discord_delivered_at, now())
              ELSE discord_delivered_at
            END,
            attempt_count = $4,
            next_attempt_at = CASE
              WHEN $3::boolean THEN now()
              ELSE now() + ($5::text || ' seconds')::interval
            END,
            last_error = CASE
              WHEN $3::boolean THEN NULL
              ELSE 'Discord delivery failed'
            END,
            updated_at = now()
          WHERE source_kind = $1 AND source_id = $2
        `,
        [
          problem.source_kind,
          problem.source_id,
          delivery.delivered,
          attempt,
          retrySeconds,
        ],
      );
    }
  }

  private async send(
    webhookUrl: string,
    problem: FiatProblem,
  ): Promise<{ delivered: boolean; retryAfterSeconds: number | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const deliveryUrl = new URL(webhookUrl);
      deliveryUrl.searchParams.set("with_components", "true");
      const response = await fetch(deliveryUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildFiatDiscordPayload(
            this.config.FIAT_ALERT_DASHBOARD_URL,
            problem,
          ),
        ),
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryAfterSeconds = discordRetryAfterSeconds(response.headers);
        this.log.error(
          {
            status: response.status,
            retryAfterSeconds,
            sourceKind: problem.source_kind,
            sourceId: problem.source_id,
          },
          `Fiat Discord alert delivery failed with HTTP ${response.status}`,
        );
        return { delivered: false, retryAfterSeconds };
      }
      return { delivered: true, retryAfterSeconds: null };
    } catch {
      this.log.error(
        {
          sourceKind: problem.source_kind,
          sourceId: problem.source_id,
        },
        "Fiat Discord alert delivery failed",
      );
      return { delivered: false, retryAfterSeconds: null };
    } finally {
      clearTimeout(timer);
    }
  }
}
