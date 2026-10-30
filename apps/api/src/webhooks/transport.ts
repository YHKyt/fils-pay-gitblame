import { lookup as dnsLookupCallback, type LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
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
  /** Test seam for the resolution the connection itself uses when
   *  blockPrivateAddresses is on (defaults to dns.lookup). */
  connectLookup?: (hostname: string) => Promise<string[]>;
  /** Test seam: which connect-time addresses are allowed (defaults to
   *  public unicast only). */
  connectAddressAllowed?: (ip: string) => boolean;
}

/** Response bytes kept from a receiver; callers store a 2000-char excerpt. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - total;
      const piece = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(piece);
      total += piece.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
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
      // public-looking names that resolve to private addresses. A DNS answer
      // can change between this lookup and the connect (rebinding), so
      // sendPinned also checks the addresses the connection itself uses.
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

    if (options.blockPrivateAddresses) {
      return sendPinned(req, options.connectLookup, options.connectAddressAllowed);
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
      // Bounded read: every consumer keeps at most a 2000-char excerpt, and a
      // receiver (merchant-controlled) can stream hundreds of MB well inside
      // the timeout. Read up to MAX_RESPONSE_BYTES, then drop the rest.
      const body = await readBounded(response, MAX_RESPONSE_BYTES);
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

/**
 * The guarded send: node:http(s) with a `lookup` that refuses any non-public
 * address, so the address checked is the address connected to. fetch
 * resolved the name again on its own, after the check above, and a name
 * answering a public address to the check and 127.0.0.1 or 169.254.169.254
 * to the connect (DNS rebinding, TTL 0) reached an internal service whose
 * reply the merchant then read in the delivery's response excerpt.
 * Redirects are not followed; the body read is bounded like the fetch path.
 */
function sendPinned(
  req: WebhookTransportRequest,
  connectLookup?: (hostname: string) => Promise<string[]>,
  addressAllowed: (ip: string) => boolean = (ip) => !isNonPublicAddress(ip),
): Promise<WebhookTransportResponse> {
  const guardedLookup: LookupFunction = (hostname, lookupOptions, callback) => {
    const resolve: Promise<LookupAddress[]> = connectLookup
      ? connectLookup(hostname).then((list) => list.map((address) => ({ address, family: isIP(address) })))
      : new Promise((ok, fail) =>
          dnsLookupCallback(hostname, { all: true, verbatim: true }, (err, list) => (err ? fail(err) : ok(list))),
        );
    resolve.then(
      (list) => {
        if (list.length === 0 || !list.every((a) => addressAllowed(a.address))) {
          callback(new Error("destination_not_allowed"), "", 0);
          return;
        }
        if (lookupOptions.all) {
          (callback as unknown as (err: null, addresses: LookupAddress[]) => void)(null, list);
        } else {
          callback(null, list[0]!.address, list[0]!.family);
        }
      },
      (err: Error) => callback(err as NodeJS.ErrnoException, "", 0),
    );
  };

  return new Promise((resolve) => {
    let settled = false;
    const done = (result: WebhookTransportResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (err: unknown) =>
      done({ statusCode: null, body: "", errorMessage: err instanceof Error ? err.message : String(err) });

    let url: URL;
    try {
      url = new URL(req.url);
    } catch (err) {
      fail(err);
      return;
    }
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(url, {
      method: "POST",
      headers: { ...req.headers, "content-length": String(Buffer.byteLength(req.body)) },
      lookup: guardedLookup,
    });
    const timer = setTimeout(() => {
      outgoing.destroy(new Error("This operation was aborted"));
    }, req.timeoutMs);
    outgoing.on("error", fail);
    outgoing.on("response", (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        if (total >= MAX_RESPONSE_BYTES) return;
        const piece = chunk.subarray(0, MAX_RESPONSE_BYTES - total);
        chunks.push(piece);
        total += piece.length;
        if (total >= MAX_RESPONSE_BYTES) {
          done({ statusCode: response.statusCode ?? null, body: Buffer.concat(chunks).toString("utf8") });
          response.destroy();
        }
      });
      response.on("end", () =>
        done({ statusCode: response.statusCode ?? null, body: Buffer.concat(chunks).toString("utf8") }),
      );
      response.on("error", fail);
    });
    outgoing.end(req.body);
  });
}
