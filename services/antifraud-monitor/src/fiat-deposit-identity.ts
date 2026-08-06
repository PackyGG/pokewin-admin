import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Config } from "./config.js";
import type { Databases } from "./db.js";
import type { EnrichmentService } from "./enrichment.js";
import { parseWhopEvidence } from "./fiat-risk.js";
import {
  emailDomain,
  evaluateFiatDepositIdentity,
  type FiatIdentityBaseline,
  type FiatIdentityBlocklistMatch,
  type FiatIdentityEmailReputation,
  type FiatIdentityOutcome,
} from "./fiat-deposit-identity-policy.js";
import { severity } from "./scoring.js";

/**
 * Post-authorization Fiat deposit identity checks.
 *
 * Every deposit Whop authorizes is compared against the identity the account
 * established on its FIRST authorized deposit. A containment verdict requires
 * KYC and locks the money rails; a watch verdict is recorded and alerted only.
 *
 * Shape follows `fiat-email-domains.ts`: a cursor over the source mirror, one
 * durable row per evaluated deposit, and containment expressed as a
 * `risk_events` row that the existing signed ingest-delivery path hands to the
 * dashboard. This service NEVER writes to the game database — the dashboard
 * owns that side, applies the lock under an advisory lock, and keeps its own
 * audit trail.
 *
 * The cursor is seeded at migration time (047), so history is never walked:
 * comparing decade-old deposits against a baseline set years apart would
 * mass-lock long-standing customers for changes nobody reviewed under this
 * policy.
 */

const CURSOR_STREAM = "fiat-deposit-identity";
const BATCH_SIZE = 25;
const UTC = "AT TIME ZONE 'UTC'";

export const FIAT_DEPOSIT_IDENTITY_CONTAINMENT_EVENT =
  "fiat_deposit_identity_containment";
const CONTAINMENT_SOURCE = "fiat_deposit_identity";
/** Floor the dashboard re-checks before it will apply a lock. */
const CONTAINMENT_SCORE = 100;

/** Problem code carrying these verdicts into the Discord alert pipeline. */
export const FIAT_IDENTITY_PROBLEM_CODE = "fiat_identity_drift";

/** Statuses that disqualify a prior deposit from counting as "clean". */
const REVERSED_STATUSES = ["disputed", "refunded", "partially_refunded"];

type AuthorizedIntentRow = {
  intent_id: string;
  user_id: string;
  username: string | null;
  user_email: string | null;
  image: string | null;
  signup_ip: string | null;
  country: string | null;
  country_code: string | null;
  continent_code: string | null;
  state: string | null;
  city: string | null;
  affiliate_code: string | null;
  referred_by: string | null;
  account_created_at: Date;
  provider_checkout_id: string | null;
  provider_payment_id: string | null;
  currency: string;
  requested_amount_cents: number;
  credited_amount_cents: number;
  status: string;
  intent_created_at: Date;
  paid_at: Date;
};

type WebhookRow = {
  provider_resource_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  received_at: string;
};

/** Card + payer email for one intent, straight off the Whop webhook payload. */
type CheckoutFacts = {
  cardBrand: string | null;
  cardLast4: string | null;
  checkoutEmail: string | null;
};

const EMPTY_FACTS: CheckoutFacts = {
  cardBrand: null,
  cardLast4: null,
  checkoutEmail: null,
};

export class FiatDepositIdentityChecks {
  constructor(
    private readonly config: Config,
    private readonly db: Databases,
    private readonly enrichment: EnrichmentService,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Safety floor for a database that predates migration 047 (or a fresh dev
   * database restored without it). Never rewinds an existing cursor.
   */
  async ensureCursor(): Promise<void> {
    await this.db.antifraud.query(
      `
        INSERT INTO source_cursors (stream, occurred_at, source_id)
        VALUES ($1, now(), '')
        ON CONFLICT (stream) DO NOTHING
      `,
      [CURSOR_STREAM],
    );
  }

  async process(): Promise<void> {
    for (;;) {
      const cursor = await this.readCursor();
      if (!cursor) return;
      const intents = await this.authorizedSince(cursor);
      if (intents.length === 0) return;

      const facts = await this.checkoutFacts(intents);
      for (const intent of intents) {
        try {
          await this.evaluate(intent, facts.get(intent.intent_id) ?? EMPTY_FACTS);
        } catch (error) {
          // One poisoned deposit must not wedge the cursor for every other
          // account. Log, skip, advance — the durable row is absent so a fixed
          // build can be replayed by rewinding this one stream.
          this.log.error(
            { err: error, intentId: intent.intent_id },
            "fiat deposit identity check failed",
          );
        }
        await this.advanceCursor(intent);
      }
      if (intents.length < BATCH_SIZE) return;
    }
  }

  private async readCursor(): Promise<{ occurredAt: Date; sourceId: string } | null> {
    const result = await this.db.antifraud.query<{
      occurred_at: Date;
      source_id: string;
    }>(
      "SELECT occurred_at, source_id FROM source_cursors WHERE stream = $1",
      [CURSOR_STREAM],
    );
    const row = result.rows[0];
    return row
      ? { occurredAt: row.occurred_at, sourceId: row.source_id }
      : null;
  }

  private async advanceCursor(intent: AuthorizedIntentRow): Promise<void> {
    await this.db.antifraud.query(
      `
        UPDATE source_cursors
        SET occurred_at = $2, source_id = $3, updated_at = now()
        WHERE stream = $1
      `,
      [CURSOR_STREAM, intent.paid_at, intent.intent_id],
    );
  }

  /**
   * Deposits authorized after the cursor.
   *
   * `paid_at` is `timestamp without time zone` in the source schema while the
   * cursor is `timestamptz`, so every comparison is pinned to UTC explicitly —
   * a naive compare would silently shift by the session timezone.
   *
   * Creators are excluded for the same reason every other customer-facing
   * check excludes them: their deposits are operational, not customer money.
   */
  private async authorizedSince(cursor: {
    occurredAt: Date;
    sourceId: string;
  }): Promise<AuthorizedIntentRow[]> {
    const result = await this.db.source.query<AuthorizedIntentRow>(
      `
        SELECT
          fdi.id::text AS intent_id,
          fdi.user_id,
          COALESCE(u.display_username, u.username) AS username,
          u.email AS user_email,
          u.image,
          u.signup_ip::text AS signup_ip,
          u.country,
          u.country_code,
          u.continent_code,
          u.state,
          u.city,
          u.affiliate_code,
          u.referred_by,
          u.created_at AS account_created_at,
          fdi.provider_checkout_id,
          fdi.provider_payment_id,
          fdi.currency,
          fdi.requested_amount_cents,
          fdi.credited_amount_cents,
          fdi.status,
          (fdi.created_at ${UTC}) AS intent_created_at,
          (fdi.paid_at ${UTC}) AS paid_at
        FROM fiat_deposit_intents fdi
        JOIN "user" u ON u.id = fdi.user_id
        WHERE fdi.paid_at IS NOT NULL
          AND ((fdi.paid_at ${UTC}), fdi.id::text) >
            (date_trunc('milliseconds', $1::timestamptz), $2::text)
          AND (fdi.paid_at ${UTC}) <= now()
          AND COALESCE(u.role::text, '') <> 'creator'
          AND 'creator' <> ALL(COALESCE(u.roles::text[], ARRAY[]::text[]))
        ORDER BY (fdi.paid_at ${UTC}), fdi.id::text
        LIMIT $3
      `,
      [cursor.occurredAt, cursor.sourceId, BATCH_SIZE],
    );
    return result.rows;
  }

  /**
   * Card brand/last4 and the payer email for a batch of intents.
   *
   * Reuses `parseWhopEvidence` so the JSON paths stay identical to the ones the
   * Fiat risk assessment already trusts — the payload shape must not be
   * re-guessed in a second place.
   */
  private async checkoutFacts(
    intents: readonly AuthorizedIntentRow[],
  ): Promise<Map<string, CheckoutFacts>> {
    const resourceToIntent = new Map<string, string>();
    for (const intent of intents) {
      if (intent.provider_checkout_id) {
        resourceToIntent.set(intent.provider_checkout_id, intent.intent_id);
      }
      if (intent.provider_payment_id) {
        resourceToIntent.set(intent.provider_payment_id, intent.intent_id);
      }
    }
    return this.factsForResources(resourceToIntent);
  }

  private async factsForResources(
    resourceToIntent: Map<string, string>,
  ): Promise<Map<string, CheckoutFacts>> {
    const resourceIds = [...resourceToIntent.keys()];
    if (resourceIds.length === 0) return new Map();
    const result = await this.db.source.query<WebhookRow>(
      `
        SELECT provider_resource_id, event_type, payload, received_at
        FROM payment_webhook_events
        WHERE provider = 'whop'
          AND provider_resource_id = ANY($1::text[])
        ORDER BY received_at DESC, id DESC
      `,
      [resourceIds],
    );
    const byIntent = new Map<string, WebhookRow[]>();
    for (const row of result.rows) {
      const intentId = resourceToIntent.get(row.provider_resource_id);
      if (!intentId) continue;
      const rows = byIntent.get(intentId) ?? [];
      rows.push(row);
      byIntent.set(intentId, rows);
    }

    const output = new Map<string, CheckoutFacts>();
    for (const [intentId, rows] of byIntent) {
      const parsed = rows.map((row) =>
        parseWhopEvidence(
          row.payload,
          row.event_type,
          new Date(row.received_at).toISOString(),
        ),
      );
      const primaryIndex = rows.findIndex(
        (row) => row.event_type === "payment.succeeded",
      );
      const primary = parsed[primaryIndex === -1 ? 0 : primaryIndex];
      if (!primary) continue;
      output.set(intentId, {
        cardBrand: primary.cardBrand
          ?? parsed.find((candidate) => candidate.cardBrand)?.cardBrand
          ?? null,
        cardLast4: primary.cardLast4
          ?? parsed.find((candidate) => candidate.cardLast4)?.cardLast4
          ?? null,
        checkoutEmail: primary.checkoutEmail
          ?? parsed.find((candidate) => candidate.checkoutEmail)?.checkoutEmail
          ?? null,
      });
    }
    return output;
  }

  /**
   * The account's first authorized deposit, with its checkout facts rebuilt.
   *
   * Deliberately sourced from the mirror rather than from this service's own
   * table: the baseline is whatever the player actually did first, which is
   * usually long before this check existed. Returns null when the deposit being
   * evaluated IS that first one.
   */
  private async baselineFor(
    intent: AuthorizedIntentRow,
  ): Promise<FiatIdentityBaseline | null> {
    const earliest = await this.db.source.query<{
      intent_id: string;
      provider_checkout_id: string | null;
      provider_payment_id: string | null;
      intent_created_at: Date;
    }>(
      `
        SELECT
          fdi.id::text AS intent_id,
          fdi.provider_checkout_id,
          fdi.provider_payment_id,
          (fdi.created_at ${UTC}) AS intent_created_at
        FROM fiat_deposit_intents fdi
        WHERE fdi.user_id = $1
          AND fdi.paid_at IS NOT NULL
        ORDER BY (fdi.paid_at ${UTC}), fdi.id::text
        LIMIT 1
      `,
      [intent.user_id],
    );
    const first = earliest.rows[0];
    if (!first || first.intent_id === intent.intent_id) return null;

    const resourceToIntent = new Map<string, string>();
    if (first.provider_checkout_id) {
      resourceToIntent.set(first.provider_checkout_id, first.intent_id);
    }
    if (first.provider_payment_id) {
      resourceToIntent.set(first.provider_payment_id, first.intent_id);
    }
    const facts =
      (await this.factsForResources(resourceToIntent)).get(first.intent_id)
      ?? EMPTY_FACTS;
    const network = await this.checkoutNetwork(
      intent.user_id,
      first.intent_created_at,
    );

    return {
      intentId: first.intent_id,
      cardBrand: facts.cardBrand,
      cardLast4: facts.cardLast4,
      checkoutEmail: facts.checkoutEmail,
      checkoutIp: network.ip,
      checkoutVisitorId: network.visitorId,
    };
  }

  /**
   * Checkout IP and device for one intent.
   *
   * `fiat_deposit_intents` carries neither, so the only record is the
   * pre-checkout eligibility assessment the backend requested moments before
   * the intent was created. There is no foreign key between them; the pairing
   * is the newest prod assessment for this account in a window around the
   * intent. A deposit that predates the eligibility endpoint simply has no
   * network evidence, and the policy's null guards leave those rules unrun.
   */
  private async checkoutNetwork(
    userId: string,
    intentCreatedAt: Date,
  ): Promise<{ ip: string | null; visitorId: string | null }> {
    const result = await this.db.antifraud.query<{
      ip: string | null;
      checkout_visitor_id: string | null;
    }>(
      `
        SELECT host(request_ip) AS ip, checkout_visitor_id
        FROM fiat_eligibility_assessments
        WHERE environment = 'prod'
          AND user_id = $1
          AND created_at <= $2::timestamptz + interval '2 minutes'
          AND created_at >= $2::timestamptz - interval '30 minutes'
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [userId, intentCreatedAt],
    );
    const row = result.rows[0];
    return {
      ip: row?.ip ?? null,
      visitorId: row?.checkout_visitor_id ?? null,
    };
  }

  /** Authorized deposits before this one that were never reversed. */
  private async priorCleanDeposits(
    intent: AuthorizedIntentRow,
  ): Promise<number> {
    const result = await this.db.source.query<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM fiat_deposit_intents fdi
        WHERE fdi.user_id = $1
          AND fdi.id::text <> $2
          AND fdi.paid_at IS NOT NULL
          AND (fdi.paid_at ${UTC}) < $3::timestamptz
          AND fdi.status <> ALL($4::text[])
      `,
      [intent.user_id, intent.intent_id, intent.paid_at, REVERSED_STATUSES],
    );
    return result.rows[0]?.count ?? 0;
  }

  private async blacklistedDomain(
    checkoutEmail: string | null,
  ): Promise<string | null> {
    const domain = emailDomain(checkoutEmail);
    if (!domain) return null;
    const result = await this.db.antifraud.query<{ active: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM fiat_email_domain_blacklist
          WHERE enabled
            AND (expires_at IS NULL OR expires_at > now())
            AND domain = $1
        ) AS active
      `,
      [domain],
    );
    return result.rows[0]?.active === true ? domain : null;
  }

  private async refundedAmountCluster(
    intent: AuthorizedIntentRow,
  ): Promise<string | null> {
    const result = await this.db.antifraud.query<{ reason: string }>(
      `
        SELECT reason
        FROM fiat_refunded_amount_clusters
        WHERE currency = upper($1)
          AND requested_amount_cents = $2
          AND active_until > now()
        LIMIT 1
      `,
      [intent.currency, intent.requested_amount_cents],
    );
    return result.rows[0]?.reason ?? null;
  }

  /**
   * Operator IP and fingerprint blocklist rules matching this checkout.
   *
   * Same lookup the pre-checkout gate performs — run again here because a rule
   * added between the checkout and the authorization must still catch the
   * payment, and because a deposit authorized before the eligibility endpoint
   * existed was never checked at all.
   */
  private async blocklistMatches(
    ip: string | null,
    visitorId: string | null,
  ): Promise<FiatIdentityBlocklistMatch[]> {
    if (!ip && !visitorId) return [];
    const result = await this.db.antifraud.query<FiatIdentityBlocklistMatch>(
      `
        SELECT
          id::text,
          kind,
          CASE
            WHEN kind = 'ip' AND match_mode = 'exact' THEN host(ip_network)
            WHEN kind = 'ip' THEN ip_network::text
            ELSE fingerprint_id
          END AS value,
          reason,
          effect
        FROM identifier_blocklists
        WHERE enabled
          AND (expires_at IS NULL OR expires_at > now())
          AND (
            (
              kind = 'ip'
              AND $1::text IS NOT NULL
              AND pg_input_is_valid($1::text, 'inet')
              AND $1::inet <<= ip_network
            )
            OR (
              kind = 'fingerprint'
              AND $2::text IS NOT NULL
              AND fingerprint_id = $2
            )
          )
        ORDER BY kind, created_at
        LIMIT 20
      `,
      [ip, visitorId],
    );
    return result.rows;
  }

  /**
   * Abstract's reputation for the payer email.
   *
   * Note this is the CHECKOUT address, not the signup one — the whole point of
   * a post-authorization check. A provider failure yields nulls, and nulls
   * never contain.
   */
  private async emailReputation(
    userId: string,
    checkoutEmail: string | null,
  ): Promise<FiatIdentityEmailReputation> {
    if (!checkoutEmail) return { catchall: null, deliverability: null };
    const result = await this.enrichment.abstractEmailCheck({
      id: userId,
      email: checkoutEmail,
    });
    if (result.status !== "success") {
      return { catchall: null, deliverability: null };
    }
    const response = (result.response ?? {}) as {
      email_quality?: { is_catchall?: unknown };
      email_deliverability?: { status?: unknown };
    };
    const catchall = response.email_quality?.is_catchall;
    const status = response.email_deliverability?.status;
    return {
      catchall: typeof catchall === "boolean" ? catchall : null,
      deliverability:
        typeof status === "string" ? status.trim().toLowerCase() : null,
    };
  }

  private async evaluate(
    intent: AuthorizedIntentRow,
    facts: CheckoutFacts,
  ): Promise<void> {
    const network = await this.checkoutNetwork(
      intent.user_id,
      intent.intent_created_at,
    );
    const [
      baseline,
      priorClean,
      blacklisted,
      refundedAmountCluster,
      blocklist,
      email,
    ] =
      await Promise.all([
        this.baselineFor(intent),
        this.priorCleanDeposits(intent),
        this.blacklistedDomain(facts.checkoutEmail),
        this.refundedAmountCluster(intent),
        this.blocklistMatches(network.ip, network.visitorId),
        this.emailReputation(intent.user_id, facts.checkoutEmail),
      ]);

    const outcome = evaluateFiatDepositIdentity({
      baseline,
      observation: {
        intentId: intent.intent_id,
        userId: intent.user_id,
        occurredAt: intent.paid_at,
        cardBrand: facts.cardBrand,
        cardLast4: facts.cardLast4,
        checkoutEmail: facts.checkoutEmail,
        checkoutIp: network.ip,
        checkoutVisitorId: network.visitorId,
        email,
        blacklistedEmailDomain: blacklisted,
        refundedAmountClusterReason: refundedAmountCluster,
        blocklistMatches: blocklist,
        priorCleanDeposits: priorClean,
      },
    });

    const contain =
      outcome.verdict === "contain"
      && this.config.FIAT_DEPOSIT_IDENTITY_CONTAINMENT_ENABLED;
    const enforcement =
      outcome.verdict !== "contain"
        ? "none"
        : contain
          ? "contained"
          : "suppressed";

    const evidence = {
      baselineIntentId: baseline?.intentId ?? null,
      priorCleanDeposits: priorClean,
      amountUsd: intent.credited_amount_cents / 100,
      currency: intent.currency,
      status: intent.status,
      cardBrand: facts.cardBrand,
      cardLast4: facts.cardLast4,
      checkoutEmail: facts.checkoutEmail,
      baselineCardLast4: baseline?.cardLast4 ?? null,
      baselineCheckoutEmail: baseline?.checkoutEmail ?? null,
      refundedAmountClusterReason: refundedAmountCluster,
      signals: outcome.signals,
    };

    const client = await this.db.antifraud.connect();
    try {
      await client.query("BEGIN");
      const stored = await this.storeCheck(client, {
        intent,
        facts,
        network,
        email,
        baseline,
        priorClean,
        outcome,
        enforcement,
        evidence,
      });
      // A repeat delivery of the same intent must not re-lock an account staff
      // already released, so containment is queued only the first time the row
      // is written.
      if (stored && contain) {
        await this.queueContainment(client, intent, outcome, evidence);
      }
      if (stored && outcome.verdict !== "clear") {
        await this.queueAlert(client, intent, outcome, evidence, enforcement);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Returns false when this intent was already evaluated. */
  private async storeCheck(
    client: pg.PoolClient,
    input: {
      intent: AuthorizedIntentRow;
      facts: CheckoutFacts;
      network: { ip: string | null; visitorId: string | null };
      email: FiatIdentityEmailReputation;
      baseline: FiatIdentityBaseline | null;
      priorClean: number;
      outcome: FiatIdentityOutcome;
      enforcement: string;
      evidence: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const inserted = await client.query<{ intent_id: string }>(
      `
        INSERT INTO fiat_deposit_identity_checks (
          intent_id, user_id, baseline_intent_id, prior_clean_deposits,
          card_brand, card_last4, checkout_email, checkout_email_domain,
          checkout_ip, checkout_visitor_id, email_catchall,
          email_deliverability, verdict, reason_codes, watch_codes,
          evidence, enforcement, occurred_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9::inet,$10,$11,$12,$13,
          $14::text[],$15::text[],$16::jsonb,$17,$18
        )
        ON CONFLICT (intent_id) DO NOTHING
        RETURNING intent_id
      `,
      [
        input.intent.intent_id,
        input.intent.user_id,
        input.baseline?.intentId ?? null,
        input.priorClean,
        input.facts.cardBrand,
        input.facts.cardLast4,
        input.facts.checkoutEmail,
        emailDomain(input.facts.checkoutEmail),
        input.network.ip,
        input.network.visitorId,
        input.email.catchall,
        input.email.deliverability,
        input.outcome.verdict,
        input.outcome.reasonCodes,
        input.outcome.watchCodes,
        JSON.stringify(input.evidence),
        input.enforcement,
        input.intent.paid_at,
      ],
    );
    return inserted.rows.length > 0;
  }

  /**
   * Queue KYC + lock for the dashboard. Runs inside the caller's transaction so
   * the durable check row and the containment command commit together.
   */
  private async queueContainment(
    client: pg.PoolClient,
    intent: AuthorizedIntentRow,
    outcome: FiatIdentityOutcome,
    evidence: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO subjects (
          user_id, username, email, avatar_url, signup_ip, country,
          country_code, continent_code, state, city, affiliate_code,
          referred_by, source_created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (user_id) DO UPDATE SET
          username = COALESCE(EXCLUDED.username, subjects.username),
          email = COALESCE(EXCLUDED.email, subjects.email),
          avatar_url = COALESCE(EXCLUDED.avatar_url, subjects.avatar_url),
          signup_ip = COALESCE(EXCLUDED.signup_ip, subjects.signup_ip),
          country = COALESCE(EXCLUDED.country, subjects.country),
          country_code =
            COALESCE(EXCLUDED.country_code, subjects.country_code),
          continent_code =
            COALESCE(EXCLUDED.continent_code, subjects.continent_code),
          state = COALESCE(EXCLUDED.state, subjects.state),
          city = COALESCE(EXCLUDED.city, subjects.city),
          affiliate_code =
            COALESCE(EXCLUDED.affiliate_code, subjects.affiliate_code),
          referred_by = COALESCE(EXCLUDED.referred_by, subjects.referred_by),
          updated_at = now()
      `,
      [
        intent.user_id,
        intent.username,
        intent.user_email,
        intent.image,
        intent.signup_ip,
        intent.country,
        intent.country_code,
        intent.continent_code,
        intent.state,
        intent.city,
        intent.affiliate_code,
        intent.referred_by,
        intent.account_created_at,
      ],
    );

    const caseResult = await client.query<{ id: string }>(
      `
        INSERT INTO cases (
          user_id, subject_type, status, severity, score, peak_score, summary
        ) VALUES (
          $1, 'account', 'open', $2, $3, $3,
          'Fiat deposit identity containment'
        )
        ON CONFLICT (user_id) WHERE subject_type = 'account'
          AND status IN ('open','monitoring','in_review','escalated')
        DO UPDATE SET
          score = GREATEST(cases.score, EXCLUDED.score),
          peak_score = GREATEST(cases.peak_score, EXCLUDED.peak_score),
          severity = CASE
            WHEN cases.peak_score >= EXCLUDED.peak_score THEN cases.severity
            ELSE EXCLUDED.severity
          END,
          updated_at = now()
        RETURNING id
      `,
      [intent.user_id, severity(CONTAINMENT_SCORE), CONTAINMENT_SCORE],
    );
    const caseId = caseResult.rows[0]?.id;
    if (!caseId) throw new Error("fiat_identity_case_not_created");

    const detail = (
      "An authorized Fiat deposit disagreed with the identity this account "
      + `established on its first one (${outcome.reasonCodes.join(", ")}). `
      + "KYC is required and the deposit and withdrawal rails are locked."
    ).slice(0, 1000);

    await client.query(
      `
        INSERT INTO risk_events (
          case_id, session_id, user_id, event_type, source, source_ref,
          score_delta, score_after, title, detail, payload, occurred_at
        ) VALUES (
          $1,NULL,$2,$3,$4,$5,0,$6,
          'Fiat deposit identity containment',$7,$8::jsonb,$9
        )
        ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
        DO NOTHING
      `,
      [
        caseId,
        intent.user_id,
        FIAT_DEPOSIT_IDENTITY_CONTAINMENT_EVENT,
        CONTAINMENT_SOURCE,
        `fiat-identity-containment:${intent.intent_id}`,
        CONTAINMENT_SCORE,
        detail,
        JSON.stringify({
          containmentRequired: true,
          requireKyc: true,
          environment: "prod",
          intentId: intent.intent_id,
          reasonCodes: outcome.reasonCodes,
          ...evidence,
        }),
        intent.paid_at,
      ],
    );
  }

  /** Discord alert for every non-clear verdict, containment or not. */
  private async queueAlert(
    client: pg.PoolClient,
    intent: AuthorizedIntentRow,
    outcome: FiatIdentityOutcome,
    evidence: Record<string, unknown>,
    enforcement: string,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO fiat_problem_alert_outbox (
          source_kind, source_id, problem_code, user_id, username,
          details, occurred_at
        ) VALUES ('deposit_intent',$1,$2,$3,$4,$5::jsonb,$6)
        ON CONFLICT (source_kind, source_id) DO NOTHING
      `,
      [
        `${intent.intent_id}:${FIAT_IDENTITY_PROBLEM_CODE}`,
        FIAT_IDENTITY_PROBLEM_CODE,
        intent.user_id,
        intent.username,
        JSON.stringify({
          intent_id: intent.intent_id,
          verdict: outcome.verdict,
          enforcement,
          reason_codes: outcome.reasonCodes,
          watch_codes: outcome.watchCodes,
          ...evidence,
        }),
        intent.paid_at,
      ],
    );
  }
}
