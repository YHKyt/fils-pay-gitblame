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
// apps/api has no CORS handling at all (no plugin, no allowed origins in
// config), so a cross-origin VITE_API_BASE_URL cannot work from a browser.
// Leave it unset: the hosted stack serves this app and /v1 on one origin
// (ops/nginx.web.conf), and the dev server proxies /v1 (vite.config.ts).
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

/**
 * Presentation-only map from the API's machine error codes to a clear human
 * sentence. This changes only what the banner reads — never a status check,
 * a retry decision or a request — so no behaviour depends on it. Any code not
 * listed falls back to the server's own `message`, then to a humanised form
 * of the code, so a new code is never shown as a raw token.
 */
const ERROR_SENTENCES: Record<string, string> = {
  invalid_credentials: "That merchant ID, email or password did not match. Please check them and try again.",
  invalid_code: "That code was not correct. Check the latest code and try again.",
  code_expired: "That code has expired. Request a new one to continue.",
  otp_expired: "That code has expired. Request a new one to continue.",
  resend_too_soon: "A code was just sent. Please wait a few seconds before requesting another.",
  too_many_attempts: "Too many attempts. For your security, please sign in again.",
  too_many_requests: "You're going a little fast. Please wait a moment and try again.",
  rate_limited: "You're going a little fast. Please wait a moment and try again.",
  account_locked: "This account is temporarily locked after several failed attempts. Please try again later.",
  session_expired: "Your session has expired. Please sign in again.",
  unauthorized: "Your session has expired. Please sign in again.",
  payment_link_already_paid: "This payment link has already been paid.",
  payment_link_canceled: "This payment link has been cancelled and can no longer be used.",
  payment_link_expired: "This payment link has expired.",
  link_expired: "This payment link has expired.",
  validation_error: "Some of the details entered weren't valid. Please review and try again.",
  payload_too_large: "That file or request was too large.",
  not_found: "We couldn't find what you were looking for.",
  conflict: "That action conflicts with the current state. Please refresh and try again.",
  unknown_error: "Something went wrong. Please try again.",
};

/** Turns a snake_case code into a readable fallback sentence. */
function humaniseCode(code: string): string {
  const words = code.replace(/_/g, " ").trim();
  if (!words) return "Something went wrong. Please try again.";
  return words.charAt(0).toUpperCase() + words.slice(1) + ".";
}

/** Human-readable text for anything thrown by `request` — used by every
 *  dashboard page's error banner so a failure (including a server-side
 *  `403` from a role gate) is always shown, never silently swallowed. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const mapped = ERROR_SENTENCES[err.code];
    if (mapped) return mapped;
    if (err.statusCode === 403) {
      return "You don't have permission to do that. Ask an owner or finance user on your account.";
    }
    // Prefer a server message only when it reads like a sentence, not a code.
    if (err.body.message && /\s/.test(err.body.message)) return err.body.message;
    return humaniseCode(err.code);
  }
  if (err instanceof Error) {
    // A fetch abort (our own request timeout) surfaces here.
    if (err.name === "AbortError") return "That took too long. Please check your connection and try again.";
    return "Something went wrong. Please try again.";
  }
  return "Something went wrong. Please try again.";
}
