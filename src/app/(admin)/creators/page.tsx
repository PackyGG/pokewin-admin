import { Sparkles } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { FadeIn } from "@/components/fade-in";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { formatNumber } from "@/lib/utils/format";

import { parseCreatorsSearchParams } from "./_lib/search-params";
import { listCreatorsForPage } from "./_queries/list-creators";
import { CreatorsTable } from "./_components/creators-table";
import { AddCreatorDialog } from "./_components/add-creator-dialog";

export const metadata = { title: "Creators" };

export default async function CreatorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/creators");

  const params = parseCreatorsSearchParams(await searchParams);
  const result = await listCreatorsForPage(params);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Sparkles className="size-5 text-primary" />
          </div>
          <div className="space-y-0.5">
            <h1 className="text-xl font-semibold leading-tight tracking-tight">
              Creators
            </h1>
            <p className="text-sm text-muted-foreground">
              {formatNumber(result.total)} total · weekly fill deals, stream sessions, payouts
            </p>
          </div>
        </div>
        <AddCreatorDialog />
      </header>

      <FadeIn className="space-y-4">
        <DataTableToolbar searchPlaceholder="Search by username or email..." />
        <CreatorsTable data={result.data} />
        <DataTablePagination
          page={result.page}
          totalPages={result.totalPages}
          total={result.total}
          perPage={result.perPage}
        />
      </FadeIn>
    </div>
  );
}
