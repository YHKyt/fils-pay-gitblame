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
 * sentence (the shared UX-audit error table). This changes only what the
 * banner reads — never a status check, a retry decision or a request — so no
 * behaviour depends on it. The server's own developer `message` is never
 * shown: an unmapped code falls back to a generic sentence that carries the
 * code only as a support reference, so a raw token or a leaked internal string
 * can never reach a user.
 */
const ERROR_SENTENCES: Record<string, string> = {
  // Validation / request shape
  validation_error: "Some details aren't valid. Check the highlighted fields and try again.",
  invalid_json: "We couldn't read that request. Refresh the page and try again.",
  invalid_json_body: "We couldn't read that request. Refresh the page and try again.",
  invalid_request: "Some information is missing or in the wrong format. Check your entries and try again.",
  payload_too_large: "That upload is too large. Split the file into smaller parts and try again.",
  uri_too_long: "That search is too long. Shorten your filters and try again.",
  internal_error: "Something went wrong on our side. Try again. If it keeps happening, contact FilsPay support.",
  method_not_allowed: "Something went wrong on our side. Please try again.",
  not_found: "We couldn't find that page.",
  // Auth / session
  unauthenticated: "Your session has ended. Please sign in again.",
  invalid_credentials: "The merchant ID, email or password is incorrect. After several failed tries, sign-in pauses for a few minutes.",
  no_pending_session: "Your sign-in timed out. Enter your email and password again.",
  otp_expired: "That code has expired. Send a new code to continue.",
  invalid_code: "That code isn't correct. Check the latest code we sent and try again.",
  too_many_attempts: "Too many incorrect codes. For your security, sign in again.",
  resend_too_soon: "We just sent a code. You can request another in 30 seconds.",
  // Amounts / money
  unsupported_currency: "FilsPay accepts Bahraini dinar (BHD) only.",
  invalid_amount: "Enter an amount between 0.001 and 10,000,000.000 BHD (up to 3 decimals).",
  invalid_id: "That link looks broken. Go back and open the item again.",
  invalid_expiry: "Choose an expiry date and time in the future (Bahrain time).",
  idempotency_key_reused: "This request was already sent with different details. Refresh the page and try again.",
  request_in_progress: "This request is still being processed. Wait a moment and refresh. Don't submit it again.",
  acquirer_unavailable: "The card network didn't respond. Nothing was charged or refunded. Try again in a minute.",
  // Transactions / captures / refunds
  transaction_not_found: "We couldn't find that transaction.",
  authorization_expired: "The card authorization has expired, so this payment can't be captured. Ask the customer to pay again.",
  capture_outcome_unknown: "We're still confirming an earlier capture with the card network. Check again in a few minutes before retrying.",
  card_captured_declined: "The card network declined the capture. The hold on the customer's card will be released.",
  refund_amount_invalid: "Enter a refund amount above 0.000 BHD.",
  refund_declined: "The card network declined this refund. Try again later or contact FilsPay support.",
  refunds_on_hold: "Refunds are paused on your account. Contact FilsPay support.",
  // Payment links
  payment_link_not_found: "This payment link isn't valid. Check the link with the business that sent it.",
  payment_link_already_paid: "This payment has already been made.",
  payment_link_canceled: "The business canceled this payment link. Contact them for a new one.",
  payment_link_expired: "This payment link has expired. Ask the business for a new one.",
  // Dates / filters
  invalid_date: "Choose a valid date range.",
  // Settlement / webhooks
  settlement_batch_not_found: "We couldn't find that settlement batch.",
  webhook_endpoint_not_found: "We couldn't find that webhook endpoint. It may have been deleted.",
  webhook_delivery_not_found: "We couldn't find that webhook delivery.",
  endpoint_disabled: "This endpoint is turned off. Turn it on before resending events.",
  invalid_url: "Enter a public HTTPS URL, for example https://example.com/webhooks. Private or local addresses aren't allowed.",
  unknown_error: "Something went wrong. Please try again.",
};

/** Optional numeric/label fields some error bodies carry, used to fill the
 *  codes whose human sentence quotes a limit or the current status. */
interface ErrorDetail {
  remainingFils?: number;
  refundableFils?: number;
  status?: string;
}

function labelStatus(status: string | undefined): string {
  if (!status) return "in its current state";
  return status.replace(/_/g, " ");
}

/** Human-readable text for anything thrown by `request` — used by every
 *  dashboard page's error banner so a failure (including a server-side
 *  `403` from a role gate) is always shown, never silently swallowed. The
 *  wording comes only from the code, never from the server's developer text. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = err.body as unknown as ErrorDetail;
    // Codes whose sentence quotes a value from the body.
    switch (err.code) {
      case "capture_exceeds_remaining":
        return `You can capture at most ${filsToBhd(detail.remainingFils)} on this payment.`;
      case "refund_exceeds_refundable":
        return `You can refund at most ${filsToBhd(detail.refundableFils)} on this payment.`;
      case "transaction_not_refundable":
        return `Only captured payments can be refunded. This one is ${labelStatus(detail.status)}.`;
      case "not_capturable":
        return `This payment can't be captured because it is already ${labelStatus(detail.status)}. Refresh to see the latest status.`;
      case "not_voidable":
        return `This payment can't be canceled because it is already ${labelStatus(detail.status)}.`;
      case "not_cancelable":
        return `This link can't be canceled because it is already ${labelStatus(detail.status)}.`;
      case "forbidden":
        return "Your role doesn't allow this. Ask an account owner to do it or to change your access.";
    }
    const mapped = ERROR_SENTENCES[err.code];
    if (mapped) return mapped;
    // A role gate with no specific code still gets a clear sentence.
    if (err.statusCode === 403) {
      return "Your role doesn't allow this. Ask an account owner to do it or to change your access.";
    }
    // Unmapped: never leak the server's developer message — carry the code
    // only as a support reference.
    return `Something went wrong. Please try again. (ref: ${err.code})`;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return "That took too long. Please check your connection and try again.";
  }
  return "Something went wrong. Please try again.";
}

/** Local BHD formatter for error-sentence interpolation (avoids a cycle with
 *  the money package import used elsewhere). 3-decimal fils → BHD. */
function filsToBhd(fils: number | undefined): string {
  if (typeof fils !== "number" || !Number.isFinite(fils)) return "the allowed amount";
  const sign = fils < 0 ? "-" : "";
  const abs = Math.abs(fils);
  const whole = Math.floor(abs / 1000);
  const frac = String(abs % 1000).padStart(3, "0");
  return `${sign}${whole}.${frac} BHD`;
}
