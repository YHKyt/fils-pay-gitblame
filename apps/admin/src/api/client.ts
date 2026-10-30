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
    if (res.status === 401 && !path.startsWith("/v1/admin/auth/") && typeof window !== "undefined") {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
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

/** Fired on any 401 from a non-auth route: the session ended mid-use.
 *  AdminAuthProvider listens, drops to anonymous, and the route guard sends
 *  the operator to the login screen with a "session expired" notice. */
export const UNAUTHORIZED_EVENT = "admin:unauthorized";

/** Maps the API's machine-readable `error` codes to plain sentences so an
 *  operator never sees a raw token like `invalid_credentials` in a banner.
 *  Presentation only: the code the server sent is unchanged. */
const ERROR_COPY: Record<string, string> = {
  validation_error: "Some details aren't valid. Check the highlighted fields and try again.",
  invalid_json: "We couldn't read that request. Refresh the page and try again.",
  invalid_json_body: "Something went wrong sending this request. Please try again.",
  invalid_request: "Some information is missing or in the wrong format. Check your entries and try again.",
  payload_too_large: "That upload is too large. Split the file into smaller parts and try again.",
  uri_too_long: "That search is too long. Shorten your filters and try again.",
  internal_error: "Something went wrong on our side. Try again. If it keeps happening, contact FilsPay support.",
  method_not_allowed: "Something went wrong on our side. Please try again.",
  not_found: "We couldn't find that page.",
  unknown_error: "Something went wrong. Please try again.",
  unauthenticated: "Your session has ended. Please sign in again.",
  forbidden: "You don't have permission to do that.",
  forbidden_role: "You don't have permission to do that.",
  invalid_credentials:
    "The email or password is incorrect. After several failed tries, sign-in pauses for a few minutes.",
  no_pending_session: "Your sign-in timed out. Enter your email and password again.",
  otp_expired: "That code has expired. Use Resend code to get a new one.",
  otp_required: "Enter the one-time code to finish signing in.",
  invalid_code: "That code isn't correct. Check the latest code we sent and try again.",
  too_many_attempts: "Too many incorrect codes. For your security, sign in again.",
  resend_too_soon: "We just sent a code. You can request another in 30 seconds.",
  kyc_document_not_found: "We couldn't find that document. It may have been replaced.",
  kyc_thumbnail_not_found: "No preview is available for this document.",
  merchant_not_found: "We couldn't find that merchant.",
  merchant_not_under_review: "This merchant isn't waiting for review. Refresh to see its status.",
  invalid_amount: "Enter an amount between 0.001 and 10,000,000.000 BHD (up to 3 decimals).",
  invalid_id: "That link looks broken. Go back and open the item again.",
  invalid_idempotency_key: "Something went wrong sending this request. Refresh the page and try again.",
  idempotency_key_reused: "This request was already sent with different details. Refresh the page and try again.",
  request_in_progress: "This request is still being processed. Wait a moment and refresh. Don't submit it again.",
  invalid_date: "Choose a valid date range.",
  invalid_filter: "One of the filters isn't valid. Reset the filters and try again.",
  invalid_cursor: "These results are out of date. Reload from the start.",
  webhook_endpoint_not_found: "We couldn't find that webhook endpoint. It may have been deleted.",
  webhook_delivery_archive_not_found: "That archived delivery no longer exists.",
  endpoint_disabled: "This endpoint is turned off. Turn it on before resending events.",
  api_key_not_found: "We couldn't find that API key.",
  api_key_already_revoked: "This API key was already revoked. Create a new key instead.",
  credit_request_not_found: "We couldn't find that credit request.",
  credit_request_not_pending: "This credit has already been approved or rejected. Refresh to see its status.",
  self_approval_forbidden: "You can't approve your own request. Another admin must approve it.",
  invalid_memo: "The memo is too long. Shorten it and try again.",
  invalid_reason_code: "Choose a reason from the list.",
  invalid_effective_date: "Choose an effective date of today (Bahrain time) or earlier.",
  merchant_balance_not_found: "This merchant has no balance yet, so it can't be adjusted.",
  empty_import: "The CSV is empty. Add a header row and at least one adjustment.",
  invalid_csv_header: "The first row must be exactly: merchantId,amount,reason",
  invalid_csv_row: "A row is missing a merchant ID or amount, or names an unknown merchant.",
  duplicate_adjustment_import: "An identical import is already posted or waiting for approval.",
  adjustment_import_not_found: "We couldn't find that import.",
  adjustment_import_not_pending: "This import has already been approved or rejected.",
  impersonation_grant_not_found: "That view-as-merchant session has already ended.",
  business_day_not_over: "That business day hasn't closed yet (Bahrain time). Choose an earlier date.",
  settlement_unreachable:
    "The settlement service didn't respond. The run may still finish. Check the batches before running it again.",
  settlement_run_failed:
    "The settlement run didn't finish. Review the batches, then run it again (re-running is safe).",
  date_required: "Choose a business date.",
  invalid_merchant_id: "That merchant ID isn't valid.",
  invalid_from: "Choose a valid start date.",
  invalid_to: "Choose a valid end date.",
  batch_events_incomplete: "Some payments in this period aren't settled yet. Try again after the batch closes.",
  service_unavailable: "A required service is temporarily unavailable. Please try again shortly.",
};

/** A readable fallback for a status when the specific code is not mapped. */
function messageForStatus(statusCode: number, code: string): string {
  if (statusCode === 401) return ERROR_COPY.unauthenticated!;
  if (statusCode === 403) return ERROR_COPY.forbidden!;
  if (statusCode === 404) return ERROR_COPY.not_found!;
  if (statusCode >= 500) return ERROR_COPY.internal_error!;
  return `Something went wrong. Please try again. (ref: ${code})`;
}

/** Human-readable text for anything thrown by `request`. Server `message`
 *  text is never shown: it is written for developers, not operators. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "invalid_csv_row") {
      const row = /row\s+(\d+)/i.exec(err.body.message ?? "");
      if (row) return `Row ${row[1]} is missing a merchant ID or amount, or names an unknown merchant.`;
    }
    return ERROR_COPY[err.code] ?? messageForStatus(err.statusCode, err.code);
  }
  if (err instanceof RangeError || err instanceof TypeError) {
    return err.message ? err.message : ERROR_COPY.unknown_error!;
  }
  return ERROR_COPY.unknown_error!;
}
