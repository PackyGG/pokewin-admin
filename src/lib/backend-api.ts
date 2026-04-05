/**
 * Helper for making authenticated requests to the backend API.
 * Throws on non-OK responses with the error message from the backend.
 */
export async function backendApiRequest<T = unknown>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${process.env.BACKEND_API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.BACKEND_API_KEY!,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({ message: "Unknown error" }));

  if (!res.ok) {
    throw new Error(data.message || data.error || res.statusText);
  }

  return data as T;
}
