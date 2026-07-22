import { Suspense } from "react";
import { KeyRound, Plug } from "lucide-react";

import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { SectionHeadingSkeleton, TableSkeleton } from "@/components/loading-skeletons";
import { ApiKeysContent, type ApiKeyRow } from "./admin-api-content";
import { ApiEndpointsSection } from "./api-endpoints-section";

export const metadata = { title: "Admin API" };

/**
 * /system/admin-api — manage machine-to-machine credentials for the
 * `/api/v1/*` surface (Discord bot + in-house consumers).
 *
 * Admin-gated at the page AND independently in every server action, so a
 * direct action call can't bypass this. Shell-first Suspense streaming
 * (same pattern as /system/geo-blocking) keeps First Paint off the DB read.
 *
 * NOTE: no secret material is ever loaded here — `key_hash` is deliberately
 * NOT selected. The table shows only the public prefix + metadata.
 */
export default async function ApiKeysPage() {
  await requireAdmin();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={KeyRound}
          title="Admin API"
          subtitle="Machine-to-machine keys and the endpoint catalogue for the /api/v1 surface — scoped, rate-limited and revocable."
        />
      </PageHero>

      <Suspense
        fallback={
          <div className="space-y-4">
            <SectionHeadingSkeleton titleWidth={140} />
            <TableSkeleton rows={5} columns={5} />
          </div>
        }
      >
        <ApiKeysBody />
      </Suspense>

      {/* Static catalogue — no DB read, so it paints immediately instead of
          waiting behind the key table's Suspense boundary. */}
      <div className="space-y-3">
        <SectionHeading icon={Plug} title="Endpoints" />
        <p className="text-sm text-muted-foreground">
          Base URL is this dashboard&apos;s origin. Authenticate every request with{" "}
          <code className="font-mono text-xs">Authorization: Bearer &lt;token&gt;</code> —
          never a query string or cookie.
        </p>
        <ApiEndpointsSection />
      </div>
    </div>
  );
}

async function ApiKeysBody() {
  const rows = await adminDb.api_keys.findMany({
    // Revoked keys are HIDDEN, not deleted: the row stays for the audit trail
    // (who revoked it, when, how many requests it made) but a dead credential
    // is noise in the operator's list. Mirrors `statusOf` in the client, which
    // treats either flag as revoked. Expired keys still show — they're
    // recoverable context, not dead weight.
    where: { revoked_at: null, is_active: true },
    orderBy: { created_at: "desc" },
    // key_hash intentionally omitted — never leaves the DB.
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      is_active: true,
      expires_at: true,
      last_used_at: true,
      last_used_ip: true,
      request_count: true,
      created_at: true,
      revoked_at: true,
    },
  });

  const keys: ApiKeyRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    isActive: r.is_active,
    expiresAt: r.expires_at?.toISOString() ?? null,
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    lastUsedIp: r.last_used_ip,
    requestCount: r.request_count,
    createdAt: r.created_at.toISOString(),
    revokedAt: r.revoked_at?.toISOString() ?? null,
  }));

  return (
    <FadeIn>
      <ApiKeysContent keys={keys} />
    </FadeIn>
  );
}
