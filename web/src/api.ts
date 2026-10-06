// Every call to the Python server goes through here. State-changing requests carry the
// X-Gaer header, which the server requires as CSRF protection.

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Inside the browser extension or an Office pane the app runs in an iframe; the server then
// issues a partitioned SameSite=None session cookie that works there.
const embedded = window.self !== window.top;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "X-Gaer": "1" };
  if (embedded) headers["X-Gaer-Embedded"] = "1";
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, credentials: "same-origin" });
  if (!res.ok) {
    let message = `Fejl ${res.status}`;
    try {
      const data = await res.json();
      if (typeof data.detail === "string") message = data.detail;
      else if (Array.isArray(data.detail)) message = "Tjek felterne og prøv igen";
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "Noget gik galt";
}
