export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    {
      status: "healthy",
      service: "antifraud-webapp",
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        "cache-control": "no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
