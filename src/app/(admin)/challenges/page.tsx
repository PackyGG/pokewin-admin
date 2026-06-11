import { Suspense } from "react";
import Link from "next/link";
import { Target } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { challengesApi, type ChallengeStatus } from "@/lib/backend-api";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { CreateChallengeButton } from "./create-challenge-button";
import { ChallengesTable } from "./challenges-table";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Challenges" };

const STATUS_TABS = ["all", "active", "inactive", "archived"] as const;

function normalizeStatus(raw?: string): ChallengeStatus | undefined {
  if (raw === "active" || raw === "inactive" || raw === "archived") return raw;
  return undefined;
}

async function ChallengesContent({
  page,
  perPage,
  status,
}: {
  page: number;
  perPage: number;
  status?: ChallengeStatus;
}) {
  const offset = (page - 1) * perPage;
  const result = await challengesApi.list({
    status,
    offset,
    limit: perPage,
  });

  const totalPages = Math.max(1, Math.ceil(result.total / perPage));

  return (
    <>
      <FadeIn>
        <ChallengesTable data={result.data} />
      </FadeIn>

      <DataTablePagination
        page={page}
        totalPages={totalPages}
        total={result.total}
        perPage={perPage}
      />
    </>
  );
}

export default async function ChallengesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/challenges");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const status = normalizeStatus(params.status);

  const suspenseKey = `${page}|${perPage}|${params.status ?? ""}`;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Target}
          title="Challenges"
          subtitle="Game challenges — reward players for hitting a target card or upgrader outcome."
          action={<CreateChallengeButton />}
        />
      </PageHero>

      <div className="space-y-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {STATUS_TABS.map((s) => (
            <Link
              key={s}
              href={`/challenges?status=${s}`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
                (params.status || "all") === s
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s}
            </Link>
          ))}
        </div>

        <Suspense
          key={suspenseKey}
          fallback={
            <>
              <TableSkeleton rows={12} columns={7} />
              <PaginationSkeleton />
            </>
          }
        >
          <ChallengesContent page={page} perPage={perPage} status={status} />
        </Suspense>
      </div>
    </div>
  );
}
