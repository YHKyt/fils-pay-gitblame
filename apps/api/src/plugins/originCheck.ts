import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { ForbiddenError } from "../lib/errors.js";

/**
 * CSRF defence in depth for the cookie-authenticated planes (merchant
 * dashboard, admin console, impersonation). The session cookies are already
 * `SameSite=Lax`, which stops a cross-site form POST from carrying them; this
 * check also covers the same-site-but-cross-origin case (a sibling subdomain
 * or another port on the same host) and any browser that ignores SameSite.
 *
 * Scope, deliberately narrow so API clients and test suites are untouched:
 *   - only state-changing methods (not GET / HEAD / OPTIONS) under /v1;
 *   - only requests that carry one of our auth cookies — without a cookie
 *     there is no ambient credential to forge;
 *   - requests with an `Authorization` header are exempt (API keys, internal
 *     bearer tokens: a browser never attaches those cross-site);
 *   - a request with neither `Origin` nor `Referer` is allowed: browsers
 *     always send `Origin` on a cross-origin POST, so its absence means a
 *     non-browser client (curl, server-to-server, test harness).
 *
 * When an Origin (or, failing that, a Referer) is present it must match the
 * request's own host (hostname compare: nginx forwards `$host`, which drops
 * the port) or the configured CHECKOUT_BASE_URL origin.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface OriginCheckInput {
  method: string;
  url: string;
  hasAuthorization: boolean;
  hasAuthCookie: boolean;
  origin: string | undefined;
  referer: string | undefined;
  host: string | undefined;
  allowedOrigins: readonly string[];
}

function hostnameOf(host: string): string {
  // "example.com:8080" -> "example.com"; "[::1]:3000" -> "[::1]"
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return (end === -1 ? host : host.slice(0, end + 1)).toLowerCase();
  }
  const colon = host.indexOf(":");
  return (colon === -1 ? host : host.slice(0, colon)).toLowerCase();
}

function parseOrigin(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True when the request must be refused as a cross-origin cookie request. */
export function isForbiddenCrossOrigin(input: OriginCheckInput): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return false;
  if (!input.url.startsWith("/v1/")) return false;
  if (input.hasAuthorization || !input.hasAuthCookie) return false;

  const claimed = input.origin ?? input.referer;
  if (claimed === undefined || claimed === "") return false;

  // "null" (sandboxed iframe, data: URL, some redirects) and anything that is
  // not an http(s) URL is never a legitimate dashboard caller.
  const parsed = parseOrigin(claimed);
  if (!parsed) return true;

  if (input.host && parsed.hostname.toLowerCase() === hostnameOf(input.host)) return false;
  return !input.allowedOrigins.includes(parsed.origin);
}

export const originCheckPlugin = fp(async (app: FastifyInstance): Promise<void> => {
  const allowedOrigins: string[] = [];
  const checkout = parseOrigin(app.config.checkoutBaseUrl);
  if (checkout) allowedOrigins.push(checkout.origin);
  const cookieNames = [app.config.cookieName, app.config.adminCookieName, app.config.impersonationCookieName];

  app.addHook("onRequest", async (request: FastifyRequest) => {
    const cookies = request.cookies ?? {};
    const header = (name: string): string | undefined => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    if (
      isForbiddenCrossOrigin({
        method: request.method,
        url: request.url,
        hasAuthorization: header("authorization") !== undefined,
        hasAuthCookie: cookieNames.some((name) => typeof cookies[name] === "string"),
        origin: header("origin"),
        referer: header("referer"),
        host: header("host"),
        allowedOrigins,
      })
    ) {
      throw new ForbiddenError("forbidden_origin", "cross-origin request refused");
    }
  });
});
