import { NextRequest, NextResponse } from "next/server";

const API_KEY = process.env.TRELLO_API_KEY!;
const TOKEN = process.env.TRELLO_TOKEN!;

/**
 * Proxies Trello attachment/preview images so the API key and token
 * stay server-side and never leak to the client.
 *
 * Usage: /api/trello-image?url=<encoded-trello-url>
 */
export async function GET(request: NextRequest) {
  const rawUrl = request.nextUrl.searchParams.get("url");
  if (!rawUrl) {
    return NextResponse.json({ error: "Missing url param" }, { status: 400 });
  }

  try {
    const target = new URL(rawUrl);

    // Only proxy trello.com / trello-attachments / trello-backgrounds URLs
    const allowed =
      target.hostname.endsWith("trello.com") ||
      target.hostname.includes("trello-attachments") ||
      target.hostname.includes("trello-backgrounds");
    if (!allowed) {
      return NextResponse.json(
        { error: "URL not allowed" },
        { status: 403 },
      );
    }

    // Try multiple auth strategies — Trello download endpoints can be picky
    const headers: Record<string, string> = { Accept: "image/*" };
    if (target.hostname.endsWith("trello.com")) {
      // Strategy 1: OAuth header (preferred for download endpoints)
      headers.Authorization = `OAuth oauth_consumer_key="${API_KEY}", oauth_token="${TOKEN}"`;
      // Strategy 2: also add query params as fallback
      target.searchParams.set("key", API_KEY);
      target.searchParams.set("token", TOKEN);
    }

    const res = await fetch(target.toString(), { headers });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Upstream ${res.status}` },
        { status: res.status },
      );
    }

    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const body = await res.arrayBuffer();

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
}
