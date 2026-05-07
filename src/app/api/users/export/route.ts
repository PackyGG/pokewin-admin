import { NextResponse } from "next/server";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { exportUsers, rowsToCsv } from "@/lib/queries/users-export";

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
  const session = await requirePageAccess("/users");

  // Page access is necessary but not sufficient — exporting raw user
  // emails is a separate capability that must be granted explicitly.
  // Admins always pass; non-admins need __can_export_users.
  if (session.role !== "admin") {
    const perms = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { allowed_pages: true },
    });
    if (!perms || !hasCapability(perms.allowed_pages, "__can_export_users")) {
      return NextResponse.json(
        { error: "Not permitted" },
        { status: 403 },
      );
    }
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
