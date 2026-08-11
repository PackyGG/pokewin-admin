import assert from "node:assert/strict";
import test from "node:test";

import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

import type { Config } from "../src/config.js";
import type { Databases } from "../src/db.js";
import type { WhopHistoryAutoBans } from "../src/whop-history-auto-bans.js";
import {
  sanitizeReconciledWhopPayment,
  WhopPaymentReconciler,
} from "../src/whop-payment-reconciliation.js";

const payment = {
  id: "pay_reconciled123",
  status: "open",
  substatus: "refunded",
  created_at: "2026-08-11T10:00:00.000Z",
  updated_at: "2026-08-12T10:00:00.000Z",
  refunded_at: "2026-08-12T09:59:00.000Z",
  risk_score: 72,
  metadata: {
    internal_user_id: "H2jcpXT4v4PuxDfSfe6qVQUZ4DEXFMYP",
    deposit_intent_id: "63f11d7b-5337-4de7-98b4-497eec6359a8",
  },
  user: { email: "must-not-be-stored@example.com" },
  payment_method: { id: "payt_secret", card: { last4: "4242" } },
  risk_signals: {
    signals: [
      { key: "prior_refund_count", value: 2, label: "Refunds" },
      { key: "private_internal_signal", value: "secret" },
    ],
  },
};

test("Whop reconciliation stores only allowlisted fraud evidence", () => {
  const sanitized = sanitizeReconciledWhopPayment(payment);
  assert.ok(sanitized);
  assert.equal(sanitized.userId, payment.metadata.internal_user_id);
  assert.equal(sanitized.riskSignals.length, 1);
  const serialized = JSON.stringify(sanitized.payload);
  assert.equal(serialized.includes("must-not-be-stored"), false);
  assert.equal(serialized.includes("payt_secret"), false);
  assert.equal(serialized.includes("4242"), false);
  assert.equal(serialized.includes("private_internal_signal"), false);
});

test("Whop reconciliation pages by updated time and feeds the idempotent ban path", async () => {
  const antifraudQueries: Array<{ sql: string; values?: unknown[] }> = [];
  const transactionQueries: Array<{ sql: string; values?: unknown[] }> = [];
  const antifraud = {
    async query(sql: string, values?: unknown[]) {
      antifraudQueries.push({ sql, values });
      if (sql.includes("SELECT occurred_at")) {
        return {
          rows: [{
            occurred_at: new Date("2026-08-10T00:00:00.000Z"),
            source_id: "",
          }],
        };
      }
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql: string, values?: unknown[]) {
          transactionQueries.push({ sql, values });
          return { rows: [] };
        },
        release() {},
      };
    },
  } as unknown as pg.Pool;
  const reconciled: unknown[][] = [];
  const autoBans = {
    async storeReconciledPayments(rows: unknown[]) {
      reconciled.push(rows);
      return 1;
    },
  } as unknown as WhopHistoryAutoBans;
  const requested: URL[] = [];
  const send = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(url);
    if (url.pathname.endsWith("/payments")) {
      return new Response(JSON.stringify({
        data: [{ id: payment.id, metadata: payment.metadata }],
        page_info: { has_next_page: false, end_cursor: "end" },
      }), { status: 200 });
    }
    return new Response(JSON.stringify(payment), { status: 200 });
  };
  const reconciler = new WhopPaymentReconciler(
    {
      WHOP_ADMIN_KEY: "whop-secret",
      WHOP_COMPANY_ID: "biz_QyTuXanxcrSIyN",
    } as Config,
    { antifraud } as Databases,
    autoBans,
    { info() {} } as unknown as FastifyBaseLogger,
    send as typeof fetch,
  );

  assert.equal(
    await reconciler.process(new Date("2026-08-12T12:00:00.000Z")),
    1,
  );
  assert.equal(requested.length, 2);
  assert.equal(requested[0]?.searchParams.get("company_id"), "biz_QyTuXanxcrSIyN");
  assert.equal(
    requested[0]?.searchParams.get("updated_after"),
    "2026-08-10T00:00:00.000Z",
  );
  assert.equal(reconciled[0]?.length, 1);
  assert.ok(transactionQueries.some((query) =>
    query.sql.includes("INSERT INTO whop_payment_snapshots")
  ));
  const cursorUpdate = antifraudQueries.find((query) =>
    query.sql.includes("UPDATE source_cursors")
  );
  assert.equal(
    (cursorUpdate?.values?.[1] as Date).toISOString(),
    "2026-08-12T11:55:00.000Z",
  );
});
