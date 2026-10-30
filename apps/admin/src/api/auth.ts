import { request, requestNoContent } from "./client.js";
import type { AdminLoginResponse, AdminMe, AdminOtpVerifyResponse } from "../types.js";

/** `POST /v1/admin/auth/login`. Step one of two: a success here only
 *  creates a *pending* session; nothing is authenticated until `verifyOtp`. */
/** Step 1 of 2; the admin session is unusable until verifyOtp. */
export function login(input: { email: string; password: string }): Promise<AdminLoginResponse> {
  return request("/v1/admin/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** `POST /v1/admin/auth/otp/verify`. */
export function verifyOtp(input: { code: string }): Promise<AdminOtpVerifyResponse> {
  return request("/v1/admin/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** `POST /v1/admin/auth/otp/resend`. Issues a fresh code for the pending
 *  session; the previous code stops working. Throttled server-side
 *  (`429 resend_too_soon`). */
export function resendOtp(): Promise<AdminLoginResponse> {
  return request("/v1/admin/auth/otp/resend", { method: "POST" });
}

/** `POST /v1/admin/auth/logout` (`204`). */
export function logout(): Promise<void> {
  return requestNoContent("/v1/admin/auth/logout", { method: "POST" });
}

/** `GET /v1/admin/auth/me`. The only thing this app treats as proof of
 *  being logged in; the server's session lookup is the actual gate. */
export function me(): Promise<AdminMe> {
  return request("/v1/admin/auth/me");
}
