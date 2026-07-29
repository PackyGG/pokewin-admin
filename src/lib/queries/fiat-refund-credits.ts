import "server-only";

/**
 * Authoritative Packy-credit reversal for a fiat intent.
 *
 * All reporting surfaces use this exact expression so a refund cannot be
 * interpreted differently by dashboard, analytics, creator, and user P&L.
 * The expression is cents because fiat_deposit_intents stores integer cents;
 * callers divide by 100 only at the final USD boundary.
 */
export function fiatRefundCreditCentsSql(alias = "i"): string {
  return `
    CASE
      WHEN ${alias}.status = 'refunded' THEN ${alias}.credited_amount_cents::numeric
      WHEN ${alias}.status = 'partially_refunded' THEN
        LEAST(
          ${alias}.credited_amount_cents::numeric,
          GREATEST(
            0::numeric,
            COALESCE(
              CASE
                WHEN ${alias}.provider_metadata->>'refunded_credit_cents' ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (${alias}.provider_metadata->>'refunded_credit_cents')::numeric
              END,
              CASE
                WHEN ${alias}.provider_metadata->>'refunded_credited_amount_cents' ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (${alias}.provider_metadata->>'refunded_credited_amount_cents')::numeric
              END,
              CASE
                WHEN ${alias}.actual_customer_total_cents > 0
                  AND ${alias}.provider_metadata->>'refunded_amount_cents' ~ '^[0-9]+([.][0-9]+)?$'
                  THEN ${alias}.credited_amount_cents::numeric
                    * (${alias}.provider_metadata->>'refunded_amount_cents')::numeric
                    / ${alias}.actual_customer_total_cents::numeric
              END,
              CASE
                WHEN ${alias}.actual_customer_total_cents > 0
                  AND ${alias}.provider_metadata->>'refund_amount_cents' ~ '^[0-9]+([.][0-9]+)?$'
                  THEN ${alias}.credited_amount_cents::numeric
                    * (${alias}.provider_metadata->>'refund_amount_cents')::numeric
                    / ${alias}.actual_customer_total_cents::numeric
              END,
              CASE
                WHEN ${alias}.actual_customer_total_cents > 0
                  AND ${alias}.provider_metadata->>'refunded_amount' ~ '^[0-9]+([.][0-9]+)?$'
                  THEN ${alias}.credited_amount_cents::numeric
                    * ((${alias}.provider_metadata->>'refunded_amount')::numeric * 100)
                    / ${alias}.actual_customer_total_cents::numeric
              END,
              CASE
                WHEN ${alias}.actual_customer_total_cents > 0
                  AND ${alias}.provider_metadata->'payment'->>'refunded_amount' ~ '^[0-9]+([.][0-9]+)?$'
                  THEN ${alias}.credited_amount_cents::numeric
                    * ((${alias}.provider_metadata->'payment'->>'refunded_amount')::numeric * 100)
                    / ${alias}.actual_customer_total_cents::numeric
              END,
              0::numeric
            )
          )
        )
      ELSE 0::numeric
    END
  `;
}

export function fiatRefundCreditUsdSql(alias = "i"): string {
  return `((${fiatRefundCreditCentsSql(alias)}) / 100.0)`;
}

/**
 * P&L/deposit reporting recognizes a refund on the original deposit date.
 * `updated_at` remains the correct timestamp for operational refund counters.
 */
export function fiatRefundAttributionTimestampSql(alias = "i"): string {
  return `COALESCE(${alias}.completed_at, ${alias}.paid_at, ${alias}.created_at)`;
}

export function fiatPartialRefundAmountPresentSql(alias = "i"): string {
  return `
    (
      ${alias}.provider_metadata->>'refunded_credit_cents' ~ '^[0-9]+([.][0-9]+)?$'
      OR ${alias}.provider_metadata->>'refunded_credited_amount_cents' ~ '^[0-9]+([.][0-9]+)?$'
      OR (
        ${alias}.actual_customer_total_cents > 0
        AND (
          ${alias}.provider_metadata->>'refunded_amount_cents' ~ '^[0-9]+([.][0-9]+)?$'
          OR ${alias}.provider_metadata->>'refund_amount_cents' ~ '^[0-9]+([.][0-9]+)?$'
          OR ${alias}.provider_metadata->>'refunded_amount' ~ '^[0-9]+([.][0-9]+)?$'
          OR ${alias}.provider_metadata->'payment'->>'refunded_amount' ~ '^[0-9]+([.][0-9]+)?$'
        )
      )
    )
  `;
}
