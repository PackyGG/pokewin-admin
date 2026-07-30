import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Activity, Network, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { FormCardSkeleton, KpiStripSkeleton } from "@/components/loading-skeletons";
import { KpiTile, PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { getAntifraudProfile } from "@/lib/antifraud/profiles-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { formatRelative } from "@/lib/utils/format";
import { AccountBanAction } from "../../banned-users/account-ban-action";

type Params = Promise<{ userId: string }>;

function EvidenceList({
  title,
  rows,
}: {
  title: string;
  rows: Array<Record<string, unknown>>;
}) {
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-4 py-3 text-sm font-semibold">{title}</div>
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          No recorded evidence.
        </p>
      ) : (
        <div className="divide-y">
          {rows.slice(0, 100).map((row, index) => (
            <div key={String(row.id ?? index)} className="px-4 py-3">
              <div className="flex flex-wrap gap-2">
                {Object.entries(row)
                  .filter(([, value]) =>
                    typeof value === "string"
                    || typeof value === "number"
                    || typeof value === "boolean",
                  )
                  .slice(0, 7)
                  .map(([key, value]) => (
                    <Badge key={key} variant="outline">
                      {key.replaceAll("_", " ")}: {String(value)}
                    </Badge>
                  ))}
              </div>
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                  Full recorded evidence
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs">
                  {JSON.stringify(row, null, 2)}
                </pre>
              </details>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

async function Content({ params }: { params: Params }) {
  const { userId } = await params;
  const result = await getAntifraudProfile(userId);
  if (result.notFound) notFound();
  if (!result.configured || result.error || !result.data) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
        {!result.configured
          ? "The Antifraud monitor API is not configured."
          : "This profile could not be loaded. No missing evidence is being treated as clean."}
      </div>
    );
  }
  const { profile } = result.data;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-4 py-3">
        <span className="font-semibold">{profile.username ?? profile.userId}</span>
        <span className="text-sm text-muted-foreground">{profile.email ?? "Email unknown"}</span>
        {profile.isBanned && <Badge variant="destructive">Banned</Badge>}
        {profile.isLocked && <Badge variant="outline">Locked</Badge>}
        <Badge variant="outline">{profile.outcome.replaceAll("_", " ")}</Badge>
        {profile.isBanned === false && (
          <span className="ml-auto">
            <AccountBanAction
              userId={profile.userId}
              account={profile.username ?? profile.userId}
              action="ban"
            />
          </span>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <KpiTile label="Risk" value={String(profile.score)} icon={ShieldAlert} accent="rose" />
        <KpiTile label="Confidence" value={`${profile.confidence}%`} icon={Activity} accent="cyan" />
        <KpiTile label="Assessments" value={String(result.data.assessments.length)} icon={Activity} accent="blue" />
        <KpiTile label="Relationships" value={String(result.data.relationships.length)} icon={Network} accent="orange" />
      </div>
      <section className="grid gap-3 rounded-xl border bg-card p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><p className="text-xs text-muted-foreground">Signup IP</p><p className="break-all font-mono">{profile.signupIp ?? "Unknown"}</p></div>
        <div><p className="text-xs text-muted-foreground">Location</p><p>{[profile.city, profile.state, profile.countryCode].filter(Boolean).join(", ") || "Unknown"}</p></div>
        <div><p className="text-xs text-muted-foreground">Assessment</p><p>{profile.assessmentVersion} · {profile.completeness}</p></div>
        <div><p className="text-xs text-muted-foreground">Last assessed</p><p>{formatRelative(profile.assessedAt)}</p></div>
        {(profile.bannedReason || profile.lockedReason) && (
          <div className="sm:col-span-2 lg:col-span-4">
            <p className="text-xs text-muted-foreground">Restriction evidence</p>
            <p>{profile.bannedReason ?? profile.lockedReason}</p>
          </div>
        )}
      </section>
      <div className="grid gap-5 xl:grid-cols-2">
        <EvidenceList title="Assessment history" rows={result.data.assessments} />
        <EvidenceList title="Provider evidence" rows={result.data.providers} />
        <EvidenceList title="Relationships" rows={result.data.relationships} />
        <EvidenceList title="Blocklist matches" rows={result.data.blocklistMatches} />
      </div>
    </>
  );
}

function Fallback() {
  return (
    <>
      <KpiStripSkeleton count={4} />
      <FormCardSkeleton rows={8} />
    </>
  );
}

export default async function ProfilePage({ params }: { params: Params }) {
  await requireAntifraudPageAccess();
  return (
    <div className="space-y-5">
      <PageHero><PageHeroIdentity /></PageHero>
      <Suspense fallback={<Fallback />}><Content params={params} /></Suspense>
    </div>
  );
}
