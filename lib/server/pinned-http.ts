import { request as requestHttp, type IncomingMessage, type RequestOptions } from "node:http";
import { request as requestHttps, type RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

export type PinnedHttpAddress = Readonly<{
  address: string;
  family: 4 | 6;
}>;

export type PinnedHttpRequest = Readonly<{
  url: URL;
  addresses: readonly PinnedHttpAddress[];
}>;

export type PinnedHttpRuntime = Readonly<{
  available: () => boolean;
  requestHttp: typeof requestHttp;
  requestHttps: typeof requestHttps;
}>;

function runningInRealNode(): boolean {
  const workerRuntime = (typeof navigator === "object" &&
    navigator.userAgent === "Cloudflare-Workers") ||
    typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === "function";
  return !workerRuntime &&
    typeof process === "object" &&
    process.release?.name === "node" &&
    typeof process.versions?.node === "string";
}

const DEFAULT_PINNED_HTTP_RUNTIME: PinnedHttpRuntime = {
  available: runningInRealNode,
  requestHttp,
  requestHttps,
};

export function pinnedHttpTransportAvailable(
  runtime: PinnedHttpRuntime = DEFAULT_PINNED_HTTP_RUNTIME,
): boolean {
  return runtime.available() &&
    typeof runtime.requestHttp === "function" &&
    typeof runtime.requestHttps === "function" &&
    typeof Readable.toWeb === "function";
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index];
    const value = message.rawHeaders[index + 1];
    if (name && value !== undefined) headers.append(name, value);
  }
  return headers;
}

function lookupFromPinnedAddresses(
  addresses: readonly PinnedHttpAddress[],
): LookupFunction {
  return ((_hostname, options, callback) => {
    const requestedFamily = typeof options === "number" ? options : options?.family ?? 0;
    const eligible = requestedFamily === 4 || requestedFamily === 6
      ? addresses.filter((entry) => entry.family === requestedFamily)
      : [...addresses];
    if (!eligible.length) {
      const error = Object.assign(new Error("No validated address matches the requested family."), {
        code: "EAI_AGAIN",
      });
      callback(error, "", 0);
      return;
    }
    if (typeof options === "object" && options?.all) {
      callback(null, eligible);
      return;
    }
    callback(null, eligible[0].address, eligible[0].family);
  }) as LookupFunction;
}

/**
 * Node-only HTTP transport. DNS is never consulted here: the request's custom
 * lookup returns only addresses already approved by the caller, while the URL
 * hostname remains intact for Host and TLS SNI/certificate verification.
 */
export async function pinnedHttpFetch(
  target: PinnedHttpRequest,
  init: Readonly<{
    method?: "GET";
    headers?: HeadersInit;
    redirect?: "manual";
    signal?: AbortSignal;
  }> = {},
  runtime: PinnedHttpRuntime = DEFAULT_PINNED_HTTP_RUNTIME,
): Promise<Response> {
  if (!pinnedHttpTransportAvailable(runtime)) {
    throw Object.assign(new Error("Pinned HTTP transport is unavailable."), {
      code: "PINNED_TRANSPORT_UNAVAILABLE",
    });
  }
  if (!target.addresses.length || target.addresses.some((entry) =>
    isIP(entry.address) !== entry.family
  )) {
    throw Object.assign(new Error("Pinned HTTP target is invalid."), {
      code: "PINNED_TRANSPORT_INVALID",
    });
  }
  if (init.signal?.aborted) throw init.signal.reason;

  const url = target.url;
  const transportHostname = url.hostname.replace(/^\[|\]$/g, "");
  const headers = new Headers(init.headers);
  headers.set("Accept-Encoding", "identity");
  headers.set("Host", url.host);
  const options: RequestOptions & HttpsRequestOptions = {
    protocol: url.protocol,
    hostname: transportHostname,
    port: url.port || undefined,
    method: init.method ?? "GET",
    path: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(headers.entries()),
    lookup: lookupFromPinnedAddresses(target.addresses),
    // A fresh agent guarantees each request consumes this request's approved
    // address set instead of reusing a socket authorized by another lookup.
    agent: false,
    signal: init.signal,
  };
  if (url.protocol === "https:" && isIP(transportHostname) === 0) {
    options.servername = transportHostname;
  }

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const request = (url.protocol === "https:" ? runtime.requestHttps : runtime.requestHttp)(
      options,
      (message) => {
        try {
          const status = message.statusCode ?? 502;
          const bodyForbidden = status === 204 || status === 205 || status === 304;
          const headers = responseHeaders(message);
          const body = bodyForbidden
            ? null
            : Readable.toWeb(message) as ReadableStream<Uint8Array>;
          const response = new Response(body, {
            status,
            statusText: message.statusMessage,
            headers,
          });
          if (bodyForbidden) message.resume();
          resolve(response);
          settled = true;
        } catch (error) {
          // A malformed upstream status/header must reject this operation,
          // rather than escape the Node callback or leave the promise pending.
          // Drain first when possible, then close the socket without attaching
          // the parser error to IncomingMessage (which could emit it unhandled).
          try { message.resume(); } catch { /* best-effort drain */ }
          try { message.destroy(); } catch { /* best-effort close */ }
          if (!settled) reject(error);
        }
      },
    );
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
    request.end();
  });
}
