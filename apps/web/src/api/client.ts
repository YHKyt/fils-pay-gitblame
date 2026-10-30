import type { ApiErrorBody } from "../types.js";

// Same origin by default: the API sends no CORS headers, so the dashboard
// must reach it through a proxy on its own origin (vite.config.ts in dev,
// ops/nginx.web.conf when hosted). The old default, http://localhost:3000,
// made every call cross-origin and the browser blocked them all.
const API_BASE_URL = (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? "";

/** Mirrors apps/api's own uniform `{ error, message? }` body
 *  (lib/errors.ts / plugins/errorHandler.ts) — one error shape end to
 *  end, not reinvented client-side. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly body: ApiErrorBody;

  constructor(statusCode: number, body: ApiErrorBody) {
    super(body.message ?? body.error);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = body.error;
    this.body = body;
  }
}

/**
 * `credentials: "include"`: the dashboard is cookie-authenticated
 * (`fp_sid`). Requests are same-origin by default (see API_BASE_URL), where
 * this is a no-op; it only matters if VITE_API_BASE_URL points elsewhere. The public
 * checkout flow is unaffected — /pay/:token reads no cookie server-side, so
 * sending one that doesn't exist is a no-op there.
 *
 * `Content-Type: application/json` is sent only when there actually is a
 * body: logout, void and replay take none, and Fastify rejects a request
 * that declares a JSON content type while carrying an empty body
 * (`FST_ERR_CTP_EMPTY_JSON_BODY`). Same fix apps/admin's client.ts already
 * carries, for the same reason.
 */
// FH: credentials include needs allow-credentials CORS on the api. works locally
// this leaks the session cookie to whatever VITE_API_BASE_URL is — am
// — MK: CORS is locked to the two origins in config. fine
/** `timeoutMs`: abort the request (fetch rejects with an AbortError, not an
 *  ApiError) if the full response hasn't arrived in time. The server may
 *  still have processed it — callers treat a timeout as "outcome unknown". */
export async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs, ...fetchInit } = init ?? {};
  const hasBody = fetchInit.body !== undefined && fetchInit.body !== null;
  const controller = timeoutMs !== undefined ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  let res: Response;
  let body: unknown;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...fetchInit,
      ...(controller ? { signal: controller.signal } : {}),
      credentials: "include",
      headers: hasBody
        ? { "Content-Type": "application/json", ...fetchInit.headers }
        : { ...fetchInit.headers },
    });
    // A timeout while reading the body is a lost response, not an empty one.
    body = await res.json().catch((err: unknown) => {
      if (controller?.signal.aborted) throw err;
      return null;
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!res.ok) {
    throw new ApiError(res.status, (body as ApiErrorBody) ?? { error: "unknown_error" });
  }
  return body as T;
}

/** For the routes that answer `204 No Content` (logout, cancel payment
 *  link, delete webhook endpoint) — makes "there is deliberately no body
 *  here" explicit at the call site. */
/**
 * For 204 responses.
 */
export async function requestNoContent(path: string, init?: RequestInit): Promise<void> {
  await request<unknown>(path, init);
}

/** Human-readable text for anything thrown by `request` — used by every
 *  dashboard page's error banner so a failure (including a server-side
 *  `403` from a role gate) is always shown, never silently swallowed. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.statusCode === 403) {
      return `Not permitted (${err.code}) — ask an owner or finance user on your account.`;
    }
    return err.body.message ?? err.code;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
