import { NextResponse } from "next/server";

import { requirePageAccess } from "@/lib/dal";
import { logError } from "@/lib/errors/logger";
import { sectionsToCsv, type ExportSection } from "@/lib/utils/export-csv";

/**
 * Chunk size (bytes) the encoded CSV is sliced into before being enqueued
 * onto the response stream. Streaming a multi-MB buffer as one enormous
 * `enqueue` would re-buffer the whole payload in a single chunk; slicing
 * keeps each chunk small so bytes keep flowing to the gateway and the
 * browser assembles the download incrementally. We slice the encoded
 * BYTES (not the source string by code unit) so a surrogate pair — e.g.
 * an emoji in a username — is never split across a chunk boundary and
 * mangled into U+FFFD. 64 KiB is a comfortable network-friendly size.
 */
const CSV_CHUNK_BYTES = 64 * 1024;

/** UTF-8 BOM so Excel opens non-ASCII (usernames, country names) cleanly. */
const UTF8_BOM = "﻿";

// Period / filter parsers — reused verbatim from the pages so the export
// resolves the exact same window / lens / filter set the admin sees.
import { parseInsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import { parseInsightsPeriod } from "@/lib/queries/insights-analytics/period";
import { parseRakebackRoiLookback } from "../rewards/rakeback/_constants";
import { parseRakebackTopClaimerScope } from "@/lib/queries/insights-rewards/rakeback/top-claimers";

// Export gatherers — plain server-only functions (no longer server
// actions). Each returns the full `ExportSection[]` for its page; this
// route is the single place that knows page → gatherer + page →
// permission-key.
import { gatherDepositBonusExportSections } from "../rewards/deposit-bonus/_export";
import { gatherRewardsOverviewExportSections } from "../rewards/_export";
import { gatherRaceExportSections } from "../rewards/race/_export";
import { gatherAffiliateExportSections } from "../rewards/affiliate/_export";
import { gatherRakebackExportSections } from "../rewards/rakeback/_export";
import { gatherCostBreakdownExportSections } from "../cost-breakdown/_export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Heavy lifetime windows fan each page's gatherer out to 10-13 aggregate
// queries (run concurrently via Promise.all inside each gatherer). On the
// widest windows the slowest single query can still take a while, so we
// claim the full platform cap (300s on this plan) rather than the old
// 120s — combined with streaming the first bytes immediately (below), a
// big export no longer trips the gateway/function timeout.
export const maxDuration = 300;

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
  rewards: {
    permissionKey: "/insights/rewards",
    gather: (p) =>
      gatherRewardsOverviewExportSections(
        parseInsightsRewardsPeriod(p.get("period") ?? undefined),
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
  "cost-breakdown": {
    permissionKey: "/insights/cost-breakdown",
    gather: (p) =>
      gatherCostBreakdownExportSections(
        parseInsightsPeriod(p.get("period") ?? undefined),
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
 * Streaming shape: the BOM is flushed onto the stream IMMEDIATELY (before
 * any query runs) so the gateway sees bytes right away and holds the
 * connection open instead of timing out while the gatherer works. The
 * gatherer's section queries already fan out concurrently (each gatherer
 * uses `Promise.all`), so the wall-clock cost is the slowest single query,
 * not their sum; once they resolve, the serialized CSV is sliced into
 * 64 KiB chunks and enqueued so a multi-MB payload isn't re-buffered as
 * one giant chunk and bytes keep flowing. The CSV bytes themselves are
 * thus produced in one batch after the (parallel) gather — but the
 * up-front BOM flush is what defeats the gateway-idle 504. The client
 * (`fetch` → `res.blob()`) assembles the blob as chunks arrive and
 * resolves its loading toast when the stream closes.
 *
 * Auth: `requirePageAccess(<key>)` runs first, BEFORE the stream is
 * constructed, with the same key the page uses — a role without access is
 * redirected (the DAL's denial path) before any bytes or queries, so the
 * export never exposes data a role can't see on the page. Read-only
 * against both DBs.
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

  // Page-access gate FIRST, before the stream below is constructed: on
  // denial the DAL throws a redirect (NEXT_REDIRECT) which Next turns into
  // a redirect response. Doing it here — outside the stream — means a
  // denied role gets the redirect/403 before any bytes are emitted or any
  // query runs. Same key the page itself checks, so no data a role can't
  // see leaks out.
  await requirePageAccess(descriptor.permissionKey);

  const filename = buildFilename(page, params);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 1) Flush the UTF-8 BOM synchronously, as the very first chunk, so
      //    the gateway sees bytes immediately and keeps the connection
      //    open while the (potentially slow) gather runs below. This is
      //    the part that prevents the "no response yet" gateway timeout.
      controller.enqueue(encoder.encode(UTF8_BOM));

      try {
        // 2) Run the gather (its section queries fire concurrently inside
        //    the gatherer) and serialize via the shared helper so the CSV
        //    format is byte-identical to before. Encode the whole string
        //    once so multi-byte UTF-8 sequences stay intact, then slice
        //    the resulting bytes for streaming.
        const sections = await descriptor.gather(params);
        const csvBytes = encoder.encode(sectionsToCsv(sections));

        // 3) Stream the encoded CSV out in bounded byte chunks rather than
        //    one giant enqueue. Slicing on byte offsets (not string code
        //    units) guarantees no surrogate pair is ever split.
        for (let i = 0; i < csvBytes.length; i += CSV_CHUNK_BYTES) {
          controller.enqueue(csvBytes.subarray(i, i + CSV_CHUNK_BYTES));
        }
        controller.close();
      } catch (err) {
        logError(
          "insights.export",
          `export gather failed for page=${page}`,
          err,
        );
        // Error the stream so the client's `fetch`/`res.blob()` rejects
        // and the loading toast flips to an error toast. We can't switch
        // to a JSON 500 here — headers/BOM are already on the wire.
        controller.error(err);
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // No Content-Length: the body is streamed, so its total size isn't
      // known when headers are sent. Omitting it lets the response use
      // chunked transfer encoding.
      "Cache-Control": "no-store",
    },
  });
}
