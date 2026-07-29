import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getUserPermissions,
  requirePageAccess,
  sessionIsAdmin,
  sessionIsOwner,
} from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { exportUsers, rowsToCsv } from "@/lib/queries/users-export";
import { buildCacheKey, rateLimit } from "@/lib/cache/redis";

// Heavy PII export (100k+ rows, full table scans). Cap per-admin volume so a
// runaway script / accidental loop can't hammer the prod DB. Dormant-safe: when
// Upstash is unconfigured the limiter fails open (no behavior change locally).
const EXPORT_RATE_LIMIT = 10;
const EXPORT_RATE_WINDOW_SECONDS = 60;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Users export can produce 100k+ rows. Give it headroom — far below
// the 300s platform cap but more than the default function budget.
export const maxDuration = 120;

const bodySchema = z.object({
  countryCodes: z.array(z.string().trim().length(2)).max(500).default([]),
  countryMode: z.enum(["any", "include", "exclude"]).default("any"),
  deposit: z.enum(["any", "has_deposited", "no_deposit"]).default("any"),
  excludeStaff: z.boolean().default(true),
  requireEmail: z.boolean().default(true),
});

export async function POST(request: Request): Promise<Response> {
  // requirePageAccess redirect()s on failure — meaningless for the fetch()
  // caller expecting CSV/JSON (it would receive a 307-to-login HTML page),
  // so short-circuit with 401 JSON instead (same pattern as
  // api/admin/avatar/[id]).
  let session: Awaited<ReturnType<typeof requirePageAccess>>;
  try {
    session = await requirePageAccess("/users");
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // CSRF-class guard — this is a cookie-authenticated heavy POST. Without
  // it a cross-site page could burn the per-admin rate budget, trigger
  // 120s prod scans and pollute the audit log (same checks as
  // api/antifraud/monitor).
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const originHeader = request.headers.get("origin");
  if (originHeader && originHeader !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Page access is necessary but not sufficient — exporting raw user
  // emails is a separate capability that must be granted explicitly.
  // Admins and owners always pass (multi-role aware — a raw
  // `session.role !== "admin"` check would wrongly deny a multi-role
  // admin); everyone else needs __can_export_users.
  if (!sessionIsAdmin(session) && !sessionIsOwner(session)) {
    const allowedPages = await getUserPermissions(session.userId);
    if (!hasCapability(allowedPages, "__can_export_users")) {
      return NextResponse.json(
        { error: "Not permitted" },
        { status: 403 },
      );
    }
  }

  const rl = await rateLimit(
    buildCacheKey("ratelimit:users-export", [session.userId]),
    EXPORT_RATE_LIMIT,
    EXPORT_RATE_WINDOW_SECONDS,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many export requests. Please wait a moment and retry." },
      {
        status: 429,
        headers: {
          "Retry-After": String(rl.resetSeconds ?? EXPORT_RATE_WINDOW_SECONDS),
        },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          parsed.error.issues[0]?.message ?? "Invalid export filters",
      },
      { status: 400 },
    );
  }

  const rows = await exportUsers({
    countryCodes: parsed.data.countryCodes,
    countryMode: parsed.data.countryMode,
    deposit: parsed.data.deposit,
    excludeStaff: parsed.data.excludeStaff,
    requireEmail: parsed.data.requireEmail,
  });

  // Audit — admins exporting PII should leave a trail. Only the
  // *counts* and *filter shape* go into the audit metadata, never the
  // emails themselves (that would duplicate the thing we're trying
  // to track controlled access to).
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "users_email_export",
    metadata: {
      rows: rows.length,
      filters: {
        countryMode: parsed.data.countryMode,
        countryCount: parsed.data.countryCodes.length,
        deposit: parsed.data.deposit,
        excludeStaff: parsed.data.excludeStaff,
        requireEmail: parsed.data.requireEmail,
      },
    },
  });

  const csv = rowsToCsv(rows);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `users-${ts}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Help tools that care about byte count up-front.
      "Content-Length": String(Buffer.byteLength(csv, "utf8")),
      "Cache-Control": "no-store",
    },
  });
}
