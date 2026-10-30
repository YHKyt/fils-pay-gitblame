import type { ApiErrorBody } from "../types.js";

// Same origin by default: apps/api has no CORS handling, so the console
// reaches it through a proxy on its own origin (vite.config.ts in dev,
// ops/nginx.web.conf when hosted). The old default, http://localhost:3000,
// made every call cross-origin and the browser blocked them all.
const API_BASE_URL = (import.meta.env.VITE_ADMIN_API_BASE_URL as string | undefined) ?? "";

/** apps/web's own dashboard origin — where a "view as merchant" grant is
 *  actually exercised. */
// FH: used to build the impersonation link
export const WEB_BASE_URL =
  (import.meta.env.VITE_WEB_BASE_URL as string | undefined) ?? "http://localhost:5173";

/** Mirrors apps/api's own uniform `{ error, message? }` body
 *  (lib/errors.ts / plugins/errorHandler.ts) — one error shape end to
 *  end, not reinvented client-side. Identical to apps/web's ApiError. */
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
 * `credentials: "include"` on every call: the admin plane is cookie-based
 * (`fp_admin_sid`), and the admin origin (5174) is not the API origin
 * (3000), so the session cookie only rides along when it is asked for
 * explicitly.
 *
 * `Content-Type: application/json` is sent only when there actually is a
 * body. Several admin routes take none at all (logout, balance rebuild,
 * start/end impersonation), and Fastify rejects a request that declares a
 * JSON content type while carrying an empty body (`FST_ERR_CTP_EMPTY_JSON_BODY`).
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: hasBody
      ? { "Content-Type": "application/json", ...init?.headers }
      : { ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, (body as ApiErrorBody) ?? { error: "unknown_error" });
  }
  return body as T;
}

/** For the routes that answer `204 No Content` (logout, end
 *  impersonation) — a bare `request<void>` would work, but this makes
 *  "there is deliberately no body here" explicit at the call site. */
export async function requestNoContent(path: string, init?: RequestInit): Promise<void> {
  await request<unknown>(path, init);
}

/** Maps the API's machine-readable `error` codes to clear human sentences so
 *  an operator never sees a raw token like `invalid_credentials` in a banner.
 *  Presentation only: the code the server sent is unchanged — this just
 *  chooses the wording shown on screen. */
const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "That email or password is not correct.",
  invalid_code: "That one-time code is not correct. Check it and try again.",
  otp_expired: "That one-time code has expired. Use Resend code to get a new one.",
  resend_too_soon: "Please wait a moment before requesting another code.",
  no_pending_session: "Your sign-in has timed out. Start over to sign in again.",
  otp_required: "Enter the one-time code to finish signing in.",
  too_many_attempts: "Too many attempts. Wait a little while, then try again.",
  account_locked: "This account is temporarily locked after too many attempts. Try again later.",
  unauthenticated: "Your session has ended. Please sign in again.",
  session_expired: "Your session has expired. Please sign in again.",
  forbidden: "Your admin role does not allow this action.",
  not_found: "We could not find what you were looking for.",
  conflict: "That action conflicts with the current state and was not applied.",
  validation_error: "Some of the details entered are not valid. Please review and try again.",
  invalid_request: "Some of the details entered are not valid. Please review and try again.",
  rate_limited: "Too many requests just now. Please slow down and try again.",
  internal_error: "Something went wrong on our side. Please try again.",
  service_unavailable: "A required service is temporarily unavailable. Please try again shortly.",
};

/** A readable fallback for a status when the specific code is not mapped —
 *  still never surfaces the raw code to the operator. */
function messageForStatus(statusCode: number): string {
  if (statusCode === 400 || statusCode === 422) {
    return "Some of the details entered are not valid. Please review and try again.";
  }
  if (statusCode === 401) return "Your session has ended. Please sign in again.";
  if (statusCode === 403) return "Your admin role does not allow this action.";
  if (statusCode === 404) return "We could not find what you were looking for.";
  if (statusCode === 409) return "That action conflicts with the current state and was not applied.";
  if (statusCode === 429) return "Too many requests just now. Please slow down and try again.";
  if (statusCode >= 500) return "Something went wrong on our side. Please try again.";
  return "Something went wrong. Please try again.";
}

/** Treat a server `message` as human-readable only when it clearly is — not
 *  when it is just the machine code echoed back (e.g. `invalid_credentials`,
 *  `otp.expired`). Those should never reach an operator's banner. */
function looksLikeCode(text: string): boolean {
  return /^[a-z0-9]+([_.][a-z0-9]+)+$/.test(text.trim());
}

/** Human-readable text for anything thrown by `request` — used by every
 *  page's error banner so a failure (including a server-side `403` from a
 *  role gate) is always *shown*, never silently swallowed, and always in
 *  plain language rather than a raw error code. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const mapped = ERROR_MESSAGES[err.code];
    if (mapped) return mapped;
    const message = err.body.message;
    if (message && !looksLikeCode(message)) return message;
    return messageForStatus(err.statusCode);
  }
  if (err instanceof Error && err.message && !looksLikeCode(err.message)) return err.message;
  return "Something went wrong. Please try again.";
}
