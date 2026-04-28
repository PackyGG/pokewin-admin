import { AlertTriangle, Sparkles } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { FadeIn } from "@/components/fade-in";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { formatNumber } from "@/lib/utils/format";
import { BackendApiError } from "@/lib/backend-api";

import { parseCreatorsSearchParams } from "./_lib/search-params";
import {
  listCreatorsForPage,
  type CreatorsListPage,
} from "./_queries/list-creators";
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

  // The creators page is now backend-API-backed. If the backend env
  // vars aren't configured on the deploy, or the backend itself is
  // unreachable, the throw used to bubble up to Next.js's generic
  // "Application error" page which gave admins zero information.
  // Catch + render a friendly state instead so the page still loads
  // (header + empty table) and the operator can see WHY data is missing.
  let result: CreatorsListPage | null = null;
  let loadError: { title: string; detail: string } | null = null;
  try {
    result = await listCreatorsForPage(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof BackendApiError) {
      loadError = {
        title: `Backend rejected the request (HTTP ${err.status})`,
        detail: message,
      };
    } else if (
      err instanceof Error &&
      (err.name === "MissingBackendApiConfigError" ||
        /Missing (backend API URL|admin API key)/i.test(message))
    ) {
      loadError = {
        title: "Backend API is not configured",
        detail:
          "Set BACKEND_API_URL_PROD + BACKEND_ADMIN_KEY_PROD on Vercel (or the matching DEV vars) and redeploy. The creators page reads its data from the packy.gg backend.",
      };
    } else {
      loadError = {
        title: "Could not load creators",
        detail: message,
      };
    }
    // Server log so the actual stack is grepable in Vercel logs.
    console.error("[creators] listCreatorsForPage failed:", err);
  }

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
              {result
                ? `${formatNumber(result.total)} total · weekly fill deals, stream sessions, payouts`
                : "Weekly fill deals, stream sessions, payouts"}
            </p>
          </div>
        </div>
        <AddCreatorDialog />
      </header>

      {loadError && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-500" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-rose-500 dark:text-rose-400">
                {loadError.title}
              </p>
              <p className="text-xs text-muted-foreground">
                {loadError.detail}
              </p>
            </div>
          </div>
        </div>
      )}

      <FadeIn className="space-y-4">
        <DataTableToolbar searchPlaceholder="Search by username or email..." />
        <CreatorsTable data={result?.data ?? []} />
        {result && (
          <DataTablePagination
            page={result.page}
            totalPages={result.totalPages}
            total={result.total}
            perPage={result.perPage}
          />
        )}
      </FadeIn>
    </div>
  );
}
