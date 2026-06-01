import { NextResponse } from "next/server";

import { requirePageAccess } from "@/lib/dal";
import { logError } from "@/lib/errors/logger";
import { sectionsToCsv, type ExportSection } from "@/lib/utils/export-csv";

// Period / filter parsers — reused verbatim from the pages so the export
// resolves the exact same window / lens / filter set the admin sees.
import { parseInsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import { parseGamesPeriod } from "@/lib/queries/insights-games/_shared";
import { parseTopUsersFilters } from "@/lib/queries/insights-games/top-users";
import { parseInsightsPeriod } from "../analytics/types";
import { parsePeriod as parseStreamerPeriod } from "../streamers/types";
import { parseRakebackRoiLookback } from "../rewards/rakeback/_constants";
import { parseRakebackTopClaimerScope } from "@/lib/queries/insights-rewards/rakeback/top-claimers";

// Export gatherers — plain server-only functions (no longer server
// actions). Each returns the full `ExportSection[]` for its page; this
// route is the single place that knows page → gatherer + page →
// permission-key.
import { gatherDepositBonusExportSections } from "../rewards/deposit-bonus/_export";
import { gatherGamesExportSections } from "../games/_export";
import { gatherRewardsOverviewExportSections } from "../rewards/_export";
import { gatherAnalyticsExportSections } from "../analytics/_export";
import { gatherStreamersExportSections } from "../streamers/_export";
import { gatherRaceExportSections } from "../rewards/race/_export";
import { gatherAffiliateExportSections } from "../rewards/affiliate/_export";
import { gatherRakebackExportSections } from "../rewards/rakeback/_export";
import { gatherSignupExportSections } from "../rewards/signup/_export";
import { gatherBalanceAdjustmentsExportSections } from "../balance-adjustments/_export";
import { gatherEdgeCalcExportSections } from "../edge-calc/_export";
import {
  gatherGgrExportSections,
  parseGgrExportWindow,
} from "../../ggr/_export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Heavy lifetime windows can run several aggregate queries back to back.
// Stay well under the 300s platform cap but give more than the default
// function budget so a big export doesn't get cut off mid-stream.
export const maxDuration = 120;

/**
 * One export descriptor per page that renders an <ExportButton>.
 *
 *   - `permissionKey` — the page-access key gating the underlying data.
 *     Must match the key the page itself passes to `requirePageAccess`,
 *     so the export never hands a role data it can't see on-screen.
 *   - `gather` — parses the page's own params off the request URL (same
 *     parsers the page uses) and returns the full `ExportSection[]`.
 *
 * The `page` query param selects the descriptor.
 */
type ExportDescriptor = {
  permissionKey: string;
  gather: (params: URLSearchParams) => Promise<ExportSection[]>;
};

const EXPORTS: Record<string, ExportDescriptor> = {
  "deposit-bonus": {
    permissionKey: "/insights/rewards/deposit-bonus",
    gather: (p) =>
      gatherDepositBonusExportSections(
        parseInsightsRewardsPeriod(p.get("period") ?? undefined),
      ),
  },
  games: {
    permissionKey: "/insights/games",
    gather: (p) =>
      gatherGamesExportSections(
        parseGamesPeriod(p.get("period") ?? undefined),
        parseTopUsersFilters({
          game: p.get("game") ?? undefined,
          minWager: p.get("minWager") ?? undefined,
          country: p.get("country") ?? undefined,
        }),
      ),
  },
  rewards: {
    permissionKey: "/insights/rewards",
    gather: (p) =>
      gatherRewardsOverviewExportSections(
        parseInsightsRewardsPeriod(p.get("period") ?? undefined),
      ),
  },
  analytics: {
    permissionKey: "/insights/analytics",
    gather: (p) =>
      gatherAnalyticsExportSections(
        parseInsightsPeriod(p.get("period") ?? undefined),
        {
          cohortsBy: p.get("cohortsBy") ?? undefined,
          retentionBy: p.get("retentionBy") ?? undefined,
          ltvBy: p.get("ltvBy") ?? undefined,
          funnelBy: p.get("funnelBy") ?? undefined,
          whalesBy: p.get("whalesBy") ?? undefined,
          geoBy: p.get("geoBy") ?? undefined,
        },
      ),
  },
  streamers: {
    permissionKey: "/insights/streamers",
    gather: (p) =>
      gatherStreamersExportSections(
        parseStreamerPeriod(p.get("period") ?? undefined),
      ),
  },
  race: {
    permissionKey: "/insights/rewards/race",
    gather: (p) =>
      gatherRaceExportSections(
        parseInsightsRewardsPeriod(p.get("period") ?? undefined),
      ),
  },
  affiliate: {
    permissionKey: "/insights/rewards/affiliate",
    gather: (p) =>
      gatherAffiliateExportSections(
        parseInsightsRewardsPeriod(p.get("period") ?? undefined),
      ),
  },
  rakeback: {
    permissionKey: "/insights/rewards/rakeback",
    gather: (p) =>
      gatherRakebackExportSections(
        parseInsightsRewardsPeriod(p.get("period") ?? undefined),
        parseRakebackRoiLookback(p.get("lookback") ?? undefined),
        parseRakebackTopClaimerScope(p.get("scope") ?? undefined),
      ),
  },
  signup: {
    permissionKey: "/insights/rewards/signup",
    gather: (p) =>
      gatherSignupExportSections(
        parseInsightsRewardsPeriod(p.get("period") ?? undefined),
      ),
  },
  "balance-adjustments": {
    permissionKey: "/insights/balance-adjustments",
    gather: (p) =>
      gatherBalanceAdjustmentsExportSections(
        parseInsightsRewardsPeriod(p.get("period") ?? undefined),
      ),
  },
  "edge-calc": {
    permissionKey: "/insights/edge-calc",
    gather: () => gatherEdgeCalcExportSections(),
  },
  ggr: {
    permissionKey: "/ggr",
    gather: (p) =>
      gatherGgrExportSections(
        parseGgrExportWindow(p.get("window") ?? undefined),
      ),
  },
};

/** Build the download filename from the page key + the active window. */
function buildFilename(page: string, params: URLSearchParams): string {
  // /ggr keys its window on `?window=`; every other page on `?period=`.
  const window = params.get("window") ?? params.get("period") ?? "all";
  const safeWindow = window.replace(/[^a-z0-9]/gi, "-");
  return `insights-${page}-${safeWindow}.csv`;
}

/**
 * GET /insights/export?page=<key>&period=<p>&... — streams a page's full
 * multi-section export as a native CSV file download.
 *
 * Replaces the previous server-action path (which returned the whole
 * `ExportSection[]` array to the client to serialize there): that hit
 * the Next.js server-action response body-size limit on large
 * datasets. Building + serializing the CSV server-side and returning it
 * as an HTTP `attachment` response has no such cap.
 *
 * Auth: `requirePageAccess(<key>)` runs first, with the same key the
 * page uses — a role without access is redirected (the DAL's denial
 * path) before any data is gathered, so the export never exposes data a
 * role can't see on the page. Read-only against both DBs.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;
  const page = params.get("page");

  if (!page || !(page in EXPORTS)) {
    return NextResponse.json(
      { error: "Unknown or missing export page" },
      { status: 400 },
    );
  }

  const descriptor = EXPORTS[page];

  // Page-access gate FIRST, outside the try/catch below: on denial the
  // DAL throws a redirect (NEXT_REDIRECT) which Next turns into a
  // redirect response — catching it here would swallow that signal. Same
  // key the page itself checks, so no data a role can't see leaks out.
  await requirePageAccess(descriptor.permissionKey);

  let csv: string;
  try {
    const sections = await descriptor.gather(params);
    csv = sectionsToCsv(sections);
  } catch (err) {
    logError(
      "insights.export",
      `export gather failed for page=${page}`,
      err,
    );
    return NextResponse.json(
      { error: "Export failed. Please try again." },
      { status: 500 },
    );
  }

  const filename = buildFilename(page, params);
  // Prepend a UTF-8 BOM so Excel opens non-ASCII (usernames, country
  // names) without mangling the encoding — matches the old client-side
  // downloadCsv() behaviour.
  const body = "﻿" + csv;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(Buffer.byteLength(body, "utf8")),
      "Cache-Control": "no-store",
    },
  });
}
