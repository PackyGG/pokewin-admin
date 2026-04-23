import "server-only";

import { creatorsApi, type CreatorListItem } from "@/lib/backend-api";
import type { CreatorsSearchParams } from "../_lib/search-params";

export type CreatorsListPage = {
  data: CreatorListItem[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
};

/**
 * Server-side wrapper around `creatorsApi.list`. Converts the admin page's
 * 1-based `page` / `perPage` URL scheme to the backend's offset/limit and
 * computes `totalPages` for the pagination component. The backend is the
 * single source of truth — this module does no filtering or enrichment.
 */
export async function listCreatorsForPage(
  params: CreatorsSearchParams,
): Promise<CreatorsListPage> {
  const { page, perPage, search } = params;
  const offset = (page - 1) * perPage;

  const { data, total } = await creatorsApi.list({
    search,
    offset,
    limit: perPage,
  });

  return {
    data,
    total,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}
