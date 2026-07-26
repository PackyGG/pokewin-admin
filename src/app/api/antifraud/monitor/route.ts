import { requireAntifraudAccess } from "@/lib/require-antifraud-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = 8_000;

function monitorConfig(): { baseUrl?: string; token?: string } {
  return {
    baseUrl: process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, ""),
    token: process.env.ANTIFRAUD_MONITOR_API_TOKEN,
  };
}

async function upstreamJson(baseUrl: string, token: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Monitor API returned ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

export async function GET(): Promise<Response> {
  try {
    await requireAntifraudAccess();
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { baseUrl, token } = monitorConfig();
  if (!baseUrl || !token) {
    return Response.json(
      {
        configured: false,
        live: [],
        cases: [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const [live, cases] = await Promise.all([
      upstreamJson(baseUrl, token, "/v1/monitors/live"),
      upstreamJson(baseUrl, token, "/v1/cases?limit=40"),
    ]);
    return Response.json(
      {
        configured: true,
        live:
          live && typeof live === "object" && "data" in live
            ? (live as { data: unknown }).data
            : [],
        cases:
          cases && typeof cases === "object" && "data" in cases
            ? (cases as { data: unknown }).data
            : [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[antifraud-monitor] snapshot failed:", error);
    return Response.json(
      {
        configured: true,
        error: "monitor_unavailable",
        live: [],
        cases: [],
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
