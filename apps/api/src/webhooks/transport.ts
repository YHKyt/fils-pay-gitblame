import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isBlockedHostname, isNonPublicAddress } from "./urlPolicy.js";

/**
 * The injectable HTTP send — `runDispatchPass` and everything it calls take
 * a `WebhookTransport` as an explicit parameter, never calling `fetch`
 * directly deep inside dispatch logic. Same "pass the effectful dependency
 * in" shape as `AcquirerSimulator`.
 */

/**
 * @property timeoutMs Covers the whole exchange including reading the body (the abort
 * signal stays armed until the body has been read).
 */
export interface WebhookTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookTransportResponse {
  /** null on a transport-level failure (timeout, DNS, connection refused —
   *  never reached the receiver) */
  statusCode: number | null;
  /** "" on a transport-level failure */
  body: string;
  /** present iff statusCode is null */
  errorMessage?: string;
}

export type WebhookTransport = (req: WebhookTransportRequest) => Promise<WebhookTransportResponse>;

export interface FetchTransportOptions {
  /** Refuse to send to any URL whose host is, or resolves to, a non-public
   *  address (loopback, private, link-local/metadata, ...). Wired on in
   *  production (app.ts / index.ts); dev and test keep local receivers. */
  blockPrivateAddresses?: boolean;
  /** Test seam for the DNS step. */
  lookup?: (hostname: string) => Promise<string[]>;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/** Real transport: Node's global fetch with an AbortController-driven
 *  timeout, used by index.ts's production wiring. Redirects are never
 *  followed (a 3xx is reported as the receiver's answer): following one would
 *  let any public URL bounce the request to an internal address. */
export function createFetchTransport(options: FetchTransportOptions = {}): WebhookTransport {
  const lookup = options.lookup ?? defaultLookup;
  return async (req: WebhookTransportRequest): Promise<WebhookTransportResponse> => {
    if (options.blockPrivateAddresses) {
      // Re-checked at send time: endpoints stored before the URL policy, and
      // public-looking names that resolve to private addresses.
      // (A DNS answer can still change between this lookup and the connect;
      // pinning the resolved address would close that window.)
      let blocked = false;
      try {
        const host = new URL(req.url).hostname;
        const bare = host.startsWith("[") ? host.slice(1, -1) : host;
        blocked = isBlockedHostname(host) || (isIP(bare) === 0 && (await lookup(bare)).some(isNonPublicAddress));
      } catch (err) {
        return {
          statusCode: null,
          body: "",
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
      if (blocked) {
        return { statusCode: null, body: "", errorMessage: "destination_not_allowed" };
      }
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const response = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
        redirect: "manual",
      });
      // unbounded read, a 1gb response would oom us? — am
      // MK: timeoutMs bounds it. fine for now, revisit after Eid inshallah
      const body = await response.text();
      return { statusCode: response.status, body };
    } catch (err) {
      return {
        statusCode: null,
        body: "",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}
