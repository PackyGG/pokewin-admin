import { cache, Suspense } from "react";
import { Inbox, ShieldCheck } from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { FadeIn } from "@/components/fade-in";
import { SectionHeading } from "@/components/modern-panels";
import { creatorsApi, type CreatorSocialStatus } from "@/lib/backend-api";

import { HubNotice, HubEmptyState } from "../_components/hub-notice";
import { HubPagination } from "../_components/hub-pagination";
import { SocialsQueueTabs } from "./tabs";
import { SocialsQueueList } from "./queue-list";
import { SocialsQueueBodySkeleton } from "./skeletons";

export const metadata = { title: "Socials Review · Creator Hub" };

const HUB_SOCIALS_REVIEW_PATH = "/creator-hub/socials-review";

const LIMIT = 50;

type SocialsPage = {
  items: Awaited<ReturnType<typeof creatorsApi.listSocials>>["items"];
  total: number;
  loadError: { title: string; detail: string } | null;
};

/**
 * One guarded fetch per (status, page), memoized for the request so the tab
 * counts and the list body can each stream in their own boundary without
 * double-fetching. A backend failure resolves to a describable error instead
 * of throwing — a missing `creator_socials` table is an un-migrated
 * environment, not an outage.
 */
const loadSocials = cache(
  async (status: CreatorSocialStatus, page: number): Promise<SocialsPage> => {
    try {
      const result = await creatorsApi.listSocials({
        status,
        limit: LIMIT,
        offset: (page - 1) * LIMIT,
      });
      return { items: result.items, total: result.total, loadError: null };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const isMissingTable =
        /relation .* does not exist|creator_socials/i.test(detail);
      console.error("[creator-hub/socials-review] listSocials failed:", err);
      return {
        items: [],
        total: 0,
        loadError: {
          title: isMissingTable
            ? "Creator Socials feature not yet enabled"
            : "Could not load social submissions",
          detail: isMissingTable
            ? "The creator_socials migration has not been applied on this environment yet. Run the migration to enable this page."
            : detail,
        },
      };
    }
  },
);

/**
 * Creator Hub → Socials Review — the approval queue for creator-uploaded
 * social accounts. Reads via `creatorsApi.listSocials`; approve/reject
 * mutations write through the backend API and stamp ADMIN-DB audit rows
 * (see `actions.ts`).
 *
 * ACCESS: `canAccessCreatorHub` (founder `motha`, or a role whose ADMIN-DB
 * toggle is on) — NOT bare `requireRole`. The Hub layout already guards the
 * segment; this page adds the explicit gate per house convention.
 *
 * SHELL-FIRST / LAZY: the heading, card chrome and status tabs render
 * immediately; only the data-bearing leaves (tab count, list body) stream
 * behind `<Suspense key={status-page}>` boundaries, sharing one memoized
 * `loadSocials` fetch. A status switch or page turn fetches just that one
 * view and never removes the control the reviewer just clicked.
 *
 * URL contract: `?status=` (pending is the bare default) + `?page=` (1-based,
 * pagination via the shared `HubPagination`; the old `?offset=` param is
 * retired). A stale deep `?page=` past the end renders the empty page with a
 * working "Previous" — never a crash.
 */
export default async function SocialsReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const params = await searchParams;
  const status: CreatorSocialStatus =
    params.status === "approved" || params.status === "rejected"
      ? params.status
      : "pending";
  const page = Math.max(1, Math.floor(Number(params.page ?? "1")) || 1);

  return (
    <div className="space-y-6">
      <SectionHeading
        icon={ShieldCheck}
        title="Socials Review"
        action={
          <Suspense
            key={`tabs-${status}-${page}`}
            fallback={<SocialsQueueTabs current={status} />}
          >
            <TabsWithCount status={status} page={page} />
          </Suspense>
        }
      />

      {/* Card chrome lives in the SHELL: switching status/page only swaps the
          body below to a skeleton. */}
      <div className="rounded-2xl border bg-card p-4">
        <Suspense
          key={`${status}-${page}`}
          fallback={<SocialsQueueBodySkeleton />}
        >
          <QueueSection status={status} page={page} />
        </Suspense>
      </div>
    </div>
  );
}

// ─── Streamed leaves (all share the memoized `loadSocials` fetch) ─────

/**
 * Tabs with the live count of the ACTIVE status suffixed onto its chip
 * ("Pending · 12") — the persistent home of the pending count now that the
 * layout-jumping KPI tile is gone. Falls back to plain tabs while loading.
 */
async function TabsWithCount({
  status,
  page,
}: {
  status: CreatorSocialStatus;
  page: number;
}) {
  const { total, loadError } = await loadSocials(status, page);
  return (
    <SocialsQueueTabs
      current={status}
      activeCount={loadError ? undefined : total}
    />
  );
}

async function QueueSection({
  status,
  page,
}: {
  status: CreatorSocialStatus;
  page: number;
}) {
  const { items, total, loadError } = await loadSocials(status, page);

  if (loadError) {
    return (
      <HubNotice tone="amber" title={loadError.title} className="mt-1">
        {/* Never print the raw backend error inline — the specifics stay
            behind a disclosure (server logs carry the full stack). */}
        <details>
          <summary className="cursor-pointer select-none font-medium">
            Details
          </summary>
          <p className="mt-1 break-words">{loadError.detail}</p>
        </details>
      </HubNotice>
    );
  }

  const pageCount = Math.max(1, Math.ceil(total / LIMIT));
  const start = total === 0 ? 0 : (page - 1) * LIMIT + 1;
  const end = (page - 1) * LIMIT + items.length;

  return (
    <FadeIn>
      {items.length === 0 ? (
        <HubEmptyState
          icon={Inbox}
          title="No submissions in this status."
          sub={
            page > 1
              ? "This page is past the end of the list — go back a page."
              : status === "pending"
                ? "New creator social submissions land here for review."
                : undefined
          }
          className="mt-4"
        />
      ) : (
        <SocialsQueueList rows={items} />
      )}

      {total > 0 && (
        <HubPagination
          basePath={HUB_SOCIALS_REVIEW_PATH}
          page={page}
          pageCount={pageCount}
          extraParams={{
            status: status === "pending" ? undefined : status,
          }}
          summary={
            items.length > 0 ? `${start}–${end} of ${total}` : `${total} total`
          }
          className="mt-4 border-t pt-3"
        />
      )}
    </FadeIn>
  );
}
