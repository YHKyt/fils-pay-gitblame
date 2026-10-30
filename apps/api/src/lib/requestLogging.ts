/**
 * Request-log hygiene. A payment-link token is a bearer secret: anyone
 * holding `/v1/payment-links/<token>` can read and pay that link. Fastify's
 * default request serializer logs the full URL, so every hosted-page visit
 * wrote live tokens into the request log. This serializer logs the same
 * fields with the token path segment and secret-looking query values
 * replaced.
 */
const REDACTED = "[redacted]";

const PAYMENT_LINK_TOKEN = /(\/v1\/+payment-links\/+)[^/?#]+/gi;
const SECRET_QUERY_KEY = /token|secret|password|passwd|signature|otp|code|key/i;

export function redactUrl(url: string): string {
  const queryAt = url.indexOf("?");
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  const redactedPath = path.replace(PAYMENT_LINK_TOKEN, `$1${REDACTED}`);
  if (queryAt === -1) return redactedPath;

  const query = url
    .slice(queryAt + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const rawKey = pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        // keep the raw key; a malformed escape is still matched below
      }
      return SECRET_QUERY_KEY.test(key) ? `${rawKey}=${REDACTED}` : pair;
    })
    .join("&");
  return `${redactedPath}?${query}`;
}

/** The parts of Fastify's request object the serializer reads. */
interface LoggedRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Same fields as Fastify's default `req` serializer, with the URL redacted. */
export function requestLogSerializer(req: LoggedRequest) {
  return {
    method: req.method,
    url: redactUrl(req.url ?? ""),
    version: headerValue(req.headers?.["accept-version"]),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket ? req.socket.remotePort : undefined,
  };
}
