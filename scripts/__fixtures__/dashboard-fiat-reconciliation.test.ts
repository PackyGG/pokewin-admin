import assert from "node:assert/strict";
import test from "node:test";

type PaidRow = {
  eventId: string;
  paymentId: string;
  receivedAt: string;
  paidAt: string;
  grossUsd: number;
  chargedTotal: number;
  amountAfterFees: number;
  role?: string;
  status?: string;
  blacklisted?: boolean;
  intentId?: string;
  completedBy?: "completed-ledger";
};

function reconcile(rows: PaidRow[], cutoff: Date, now: Date) {
  const deduped = new Map<string, PaidRow>();
  for (const row of rows) {
    const previous = deduped.get(row.paymentId);
    if (!previous || row.receivedAt > previous.receivedAt) {
      deduped.set(row.paymentId, row);
    }
  }

  const paid = [...deduped.values()].filter((row) => {
    const paidAt = new Date(row.paidAt);
    return paidAt >= cutoff && paidAt <= now;
  });
  const providerGrossUsd = paid.reduce((sum, row) => sum + row.grossUsd, 0);
  const providerNetUsd = paid.reduce(
    (sum, row) =>
      sum + row.grossUsd * (row.amountAfterFees / row.chargedTotal),
    0,
  );
  const graceCutoff = new Date(now.getTime() - 15 * 60_000);
  const exceptions = paid.filter(
    (row) =>
      row.intentId &&
      row.role !== "admin" &&
      row.role !== "support" &&
      !["canceled", "partially_refunded", "refunded", "disputed"].includes(
        row.status ?? "",
      ) &&
      new Date(row.paidAt) < graceCutoff &&
      !row.completedBy,
  );
  return { paid, providerGrossUsd, providerNetUsd, exceptions };
}

test("UTC today is inclusive at midnight and excludes earlier or future paid_at", () => {
  const result = reconcile(
    [
      {
        eventId: "before",
        paymentId: "before",
        receivedAt: "2026-07-29T00:01:00Z",
        paidAt: "2026-07-28T23:59:59.999Z",
        grossUsd: 100,
        chargedTotal: 100,
        amountAfterFees: 95,
      },
      {
        eventId: "edge",
        paymentId: "edge",
        receivedAt: "2026-07-29T00:00:01Z",
        paidAt: "2026-07-29T00:00:00.000Z",
        grossUsd: 20,
        chargedTotal: 20,
        amountAfterFees: 19,
      },
      {
        eventId: "future",
        paymentId: "future",
        receivedAt: "2026-07-29T12:00:00Z",
        paidAt: "2026-07-29T12:00:01Z",
        grossUsd: 500,
        chargedTotal: 500,
        amountAfterFees: 475,
      },
    ],
    new Date("2026-07-29T00:00:00Z"),
    new Date("2026-07-29T12:00:00Z"),
  );

  assert.deepEqual(result.paid.map((row) => row.paymentId), ["edge"]);
});

test("provider payment dedupe and non-USD fee conversion use the latest event", () => {
  const result = reconcile(
    [
      {
        eventId: "old",
        paymentId: "same",
        receivedAt: "2026-07-29T09:00:00Z",
        paidAt: "2026-07-29T08:59:00Z",
        grossUsd: 110,
        chargedTotal: 100,
        amountAfterFees: 96,
      },
      {
        eventId: "new",
        paymentId: "same",
        receivedAt: "2026-07-29T09:01:00Z",
        paidAt: "2026-07-29T08:59:00Z",
        grossUsd: 110,
        chargedTotal: 100,
        amountAfterFees: 95,
      },
    ],
    new Date("2026-07-29T00:00:00Z"),
    new Date("2026-07-29T12:00:00Z"),
  );

  assert.equal(result.paid.length, 1);
  assert.equal(result.providerGrossUsd, 110);
  assert.equal(result.providerNetUsd, 104.5);
});

test("exceptions exclude grace, lifecycle, staff, and all authoritative credit keys", () => {
  const base = {
    receivedAt: "2026-07-29T10:01:00Z",
    paidAt: "2026-07-29T10:00:00Z",
    grossUsd: 10,
    chargedTotal: 10,
    amountAfterFees: 9.5,
    intentId: "intent",
  };
  const rows: PaidRow[] = [
    { ...base, eventId: "real", paymentId: "real", blacklisted: true },
    {
      ...base,
      eventId: "staff",
      paymentId: "staff",
      role: "admin",
    },
    {
      ...base,
      eventId: "refund",
      paymentId: "refund",
      status: "refunded",
    },
    {
      ...base,
      eventId: "completed-ledger",
      paymentId: "completed-ledger",
      completedBy: "completed-ledger",
    },
    {
      ...base,
      eventId: "fresh",
      paymentId: "fresh",
      paidAt: "2026-07-29T11:50:00Z",
    },
  ];
  const result = reconcile(
    rows,
    new Date("2026-07-29T00:00:00Z"),
    new Date("2026-07-29T12:00:00Z"),
  );

  assert.deepEqual(result.exceptions.map((row) => row.paymentId), ["real"]);
  assert.equal(result.exceptions[0]?.blacklisted, true);
});
