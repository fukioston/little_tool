import { lookup, resolveCname } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "./http";
import {
  pinnedHttpFetch,
  pinnedHttpTransportAvailable,
  type PinnedHttpAddress,
  type PinnedHttpRequest,
} from "./pinned-http";
import { composeRequestSignal, isAbortLike } from "./request-signal";

const MAX_REDIRECTS = 4;

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 2 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224;
}

function ipv4Bytes(value: string): number[] | null {
  const parts = value.split(".").map(Number);
  return parts.length === 4 && parts.every((part) =>
    Number.isInteger(part) && part >= 0 && part <= 255
  ) ? parts : null;
}

function ipv6Bytes(value: string): Uint8Array | null {
  let normalized = value.toLowerCase();
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);
  const embeddedIpv4 = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (embeddedIpv4) {
    const bytes = ipv4Bytes(embeddedIpv4);
    if (!bytes) return null;
    const replacement = `${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
    normalized = `${normalized.slice(0, -embeddedIpv4.length)}${replacement}`;
  }
  if ((normalized.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = normalized.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((normalized.includes("::") && missing < 1) || (!normalized.includes("::") && missing !== 0)) {
    return null;
  }
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((part) =>
    Number.parseInt(part, 16)
  );
  if (words.length !== 8) return null;
  const bytes = new Uint8Array(16);
  words.forEach((word, index) => {
    bytes[index * 2] = word >>> 8;
    bytes[index * 2 + 1] = word & 0xff;
  });
  return bytes;
}

function ipv6HasPrefix(
  value: Uint8Array,
  prefix: readonly number[],
  prefixBits: number,
): boolean {
  const wholeBytes = Math.floor(prefixBits / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (value[index] !== prefix[index]) return false;
  }
  const remainingBits = prefixBits % 8;
  if (!remainingBits) return true;
  const mask = 0xff << (8 - remainingBits);
  return (value[wholeBytes] & mask) === (prefix[wholeBytes] & mask);
}

function ipv6Equals(value: Uint8Array, expected: readonly number[]): boolean {
  return expected.length === value.length && value.every((byte, index) =>
    byte === expected[index]
  );
}

function isPrivateIpv6(value: string): boolean {
  const bytes = ipv6Bytes(value);
  if (!bytes) return true;
  const allZeroBeforeLast = bytes.slice(0, 15).every((byte) => byte === 0);
  if (bytes.every((byte) => byte === 0) || (allZeroBeforeLast && bytes[15] === 1)) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe) return true;
  if (bytes[0] === 0xff) return true;

  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return true;

  // The well-known NAT64 prefix is globally reachable in IANA's registry, but
  // its embedded IPv4 destination must independently pass the IPv4 boundary.
  if (ipv6HasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) {
    return isPrivateIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }

  // The enclosing 2001::/23 entry is non-global unless a more-specific IANA
  // registration says otherwise. Keep only its globally reachable exceptions.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] <= 0x01) {
    const globallyReachableException =
      ipv6HasPrefix(bytes, [0x20, 0x01, 0x00, 0x03], 32) ||
      ipv6HasPrefix(bytes, [0x20, 0x01, 0x00, 0x04, 0x01, 0x12], 48) ||
      ipv6HasPrefix(bytes, [0x20, 0x01, 0x00, 0x20], 28) ||
      ipv6HasPrefix(bytes, [0x20, 0x01, 0x00, 0x30], 28) ||
      ipv6Equals(bytes, [
        0x20, 0x01, 0, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01,
      ]) ||
      ipv6Equals(bytes, [
        0x20, 0x01, 0, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02,
      ]) ||
      ipv6Equals(bytes, [
        0x20, 0x01, 0, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x03,
      ]);
    return !globallyReachableException;
  }

  // Fail closed outside presently allocated global-unicast space, then remove
  // the remaining IANA entries that are explicitly not globally reachable.
  if ((bytes[0] & 0xe0) !== 0x20) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return true;
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return true;
  if (bytes[0] === 0x3f && (bytes[1] & 0xf0) === 0xf0) return true;

  if (bytes.slice(0, 12).every((byte) => byte === 0)) return true;
  return false;
}

function isPublicIpAddress(value: string): boolean {
  const version = isIP(value);
  return version === 4 ? !isPrivateIpv4(value) : version === 6 ? !isPrivateIpv6(value) : false;
}

export type SafeDnsResolution = Readonly<{
  addresses: readonly string[];
  canonicalNames?: readonly string[];
}>;

export type SafeFetchRuntime = Readonly<{
  fetchPinned: typeof pinnedHttpFetch;
  resolveDns: (hostname: string, signal?: AbortSignal) => Promise<SafeDnsResolution>;
}>;

function signalAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("request cancelled", "AbortError");
}

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signalAbortReason(signal);
}

function raceWithSignal<T>(operation: PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  if (signal.aborted) return Promise.reject(signalAbortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signalAbortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function dnsAnswerAbsent(reason: unknown): boolean {
  const code = reason && typeof reason === "object"
    ? String((reason as { code?: unknown }).code ?? "")
    : "";
  return code === "ENODATA" || code === "ENOTFOUND" || code === "ENOENT";
}

async function defaultResolveDns(
  hostname: string,
  signal?: AbortSignal,
): Promise<SafeDnsResolution> {
  throwIfSignalAborted(signal);
  if (typeof lookup !== "function" || typeof resolveCname !== "function") {
    throw new HttpError(503, "当前运行环境不能安全核对远程地址。", "DNS_SECURITY_UNAVAILABLE");
  }
  const answers = await Promise.allSettled([
    raceWithSignal(lookup(hostname, { all: true, verbatim: true }), signal),
    raceWithSignal(resolveCname(hostname), signal),
  ] as const);
  throwIfSignalAborted(signal);
  for (const answer of answers) {
    if (answer.status === "rejected" && !dnsAnswerAbsent(answer.reason)) {
      const detail = answer.reason instanceof Error ? answer.reason.message : String(answer.reason);
      const unavailable = /not implemented|unsupported|unavailable/i.test(detail);
      throw new HttpError(
        unavailable ? 503 : 502,
        unavailable ? "当前运行环境不能安全核对远程地址。" : "远程地址的 DNS 核对失败。",
        unavailable ? "DNS_SECURITY_UNAVAILABLE" : "DNS_LOOKUP_FAILED",
      );
    }
  }
  return {
    addresses: answers[0].status === "fulfilled"
      ? answers[0].value.map((entry) => entry.address)
      : [],
    canonicalNames: answers[1].status === "fulfilled" ? answers[1].value : [],
  };
}

const DEFAULT_SAFE_FETCH_RUNTIME: SafeFetchRuntime = {
  fetchPinned: pinnedHttpFetch,
  resolveDns: defaultResolveDns,
};

function pinnedTransportUnavailableError(): HttpError {
  return new HttpError(
    503,
    "当前部署不支持安全读取远程地址。请先下载内容，再使用本地文件或字幕导入。",
    "PINNED_TRANSPORT_UNAVAILABLE",
  );
}

export function assertPublicHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "链接格式不正确。", "INVALID_URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "仅支持 HTTP 或 HTTPS 链接。", "INVALID_URL_SCHEME");
  }
  if (url.username || url.password) throw new HttpError(400, "链接不能包含登录凭据。", "URL_CREDENTIALS_BLOCKED");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    host.endsWith(".internal") || host.endsWith(".home.arpa") ||
    (isIP(host) !== 0 && !isPublicIpAddress(host))
  ) {
    throw new HttpError(400, "出于安全原因，不能访问本机或私有网络地址。", "PRIVATE_URL_BLOCKED");
  }
  return url;
}

function normalizedDnsName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

async function assertPublicDnsTarget(
  url: URL,
  resolver: SafeFetchRuntime["resolveDns"] | undefined,
  signal?: AbortSignal,
): Promise<readonly PinnedHttpAddress[]> {
  throwIfSignalAborted(signal);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw new HttpError(400, "出于安全原因，不能访问本机或私有网络地址。", "PRIVATE_URL_BLOCKED");
    }
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }
  if (typeof resolver !== "function") {
    throw new HttpError(503, "当前运行环境不能安全核对远程地址。", "DNS_SECURITY_UNAVAILABLE");
  }

  const active = new Set<string>();
  const completed = new Map<string, readonly PinnedHttpAddress[]>();
  const inspect = async (
    rawHostname: string,
    depth: number,
  ): Promise<readonly PinnedHttpAddress[]> => {
    throwIfSignalAborted(signal);
    const current = normalizedDnsName(rawHostname);
    if (!current || depth > 8 || active.has(current)) {
      throw new HttpError(502, "远程地址的 DNS 别名链不安全。", "DNS_CNAME_INVALID");
    }
    const prior = completed.get(current);
    if (prior) return prior;
    if (
      current === "localhost" || current.endsWith(".localhost") ||
      current.endsWith(".local") || current.endsWith(".internal") ||
      current.endsWith(".home.arpa")
    ) {
      throw new HttpError(400, "DNS 指向本机或私有网络，已停止读取。", "PRIVATE_DNS_BLOCKED");
    }
    if (isIP(current)) {
      if (!isPublicIpAddress(current)) {
        throw new HttpError(400, "DNS 指向本机或私有网络，已停止读取。", "PRIVATE_DNS_BLOCKED");
      }
      return [{ address: current, family: isIP(current) as 4 | 6 }];
    }
    active.add(current);

    let resolution: SafeDnsResolution;
    try {
      const operation = Promise.resolve().then(() => resolver(current, signal));
      resolution = await raceWithSignal(operation, signal);
    } catch (error) {
      if (signal?.aborted) throw signalAbortReason(signal);
      if (error instanceof HttpError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      const unavailable = /not implemented|unsupported|unavailable/i.test(detail);
      throw new HttpError(
        unavailable ? 503 : 502,
        unavailable ? "当前运行环境不能安全核对远程地址。" : "远程地址的 DNS 核对失败。",
        unavailable ? "DNS_SECURITY_UNAVAILABLE" : "DNS_LOOKUP_FAILED",
      );
    }
    if (
      !resolution || !Array.isArray(resolution.addresses) ||
      (resolution.canonicalNames !== undefined && !Array.isArray(resolution.canonicalNames))
    ) {
      throw new HttpError(503, "当前运行环境没有返回可安全核对的 DNS 结果。", "DNS_SECURITY_UNAVAILABLE");
    }
    const directAddresses: PinnedHttpAddress[] = [];
    for (const address of resolution.addresses) {
      throwIfSignalAborted(signal);
      if (typeof address !== "string" || !isIP(address)) {
        throw new HttpError(502, "远程地址返回了无效的 DNS 记录。", "DNS_RESULT_INVALID");
      }
      if (!isPublicIpAddress(address)) {
        throw new HttpError(400, "DNS 指向本机或私有网络，已停止读取。", "PRIVATE_DNS_BLOCKED");
      }
      directAddresses.push({ address, family: isIP(address) as 4 | 6 });
    }
    const canonicalAddresses: PinnedHttpAddress[] = [];
    for (const canonicalName of resolution.canonicalNames ?? []) {
      throwIfSignalAborted(signal);
      if (typeof canonicalName !== "string") {
        throw new HttpError(502, "远程地址返回了无效的 DNS 别名。", "DNS_CNAME_INVALID");
      }
      canonicalAddresses.push(...await inspect(canonicalName, depth + 1));
    }
    const approved = directAddresses.length ? directAddresses : canonicalAddresses;
    if (!approved.length) {
      throw new HttpError(502, "远程地址没有可安全核对的公网 A 或 AAAA 记录。", "DNS_ADDRESS_MISSING");
    }
    const deduplicated = [...new Map(approved.map((entry) => [
      `${entry.family}:${entry.address}`,
      entry,
    ])).values()];
    active.delete(current);
    completed.set(current, deduplicated);
    return deduplicated;
  };

  return inspect(hostname, 0);
}

/** Server-only guard for outbound requests that need to stream their own body. */
export async function assertPublicRemoteTarget(
  input: string | URL,
  resolver: SafeFetchRuntime["resolveDns"] = defaultResolveDns,
  signal?: AbortSignal,
): Promise<PinnedHttpRequest> {
  throwIfSignalAborted(signal);
  const url = assertPublicHttpUrl(input.toString());
  if (resolver === defaultResolveDns && !pinnedHttpTransportAvailable()) {
    throw pinnedTransportUnavailableError();
  }
  const addresses = await assertPublicDnsTarget(url, resolver, signal);
  return { url, addresses };
}

export async function fetchPinnedRemoteTarget(
  target: PinnedHttpRequest,
  init: Parameters<typeof pinnedHttpFetch>[1],
  transport: SafeFetchRuntime["fetchPinned"] = pinnedHttpFetch,
): Promise<Response> {
  if (typeof transport !== "function") {
    throw pinnedTransportUnavailableError();
  }
  try {
    return await transport(target, init);
  } catch (error) {
    const code = error && typeof error === "object"
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    if (code === "PINNED_TRANSPORT_UNAVAILABLE") {
      throw pinnedTransportUnavailableError();
    }
    throw error;
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError(413, "远程内容过大。", "REMOTE_CONTENT_TOO_LARGE");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new HttpError(413, "远程内容过大。", "REMOTE_CONTENT_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof HttpError) throw error;
    // Preserve the original read error here so the outer request boundary can
    // still distinguish a caller cancellation from a timeout. Other stream
    // failures are mapped to the stable REMOTE_BODY_FAILED response there.
    throw error;
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function safeFetchText(
  input: string,
  options: {
    maxBytes?: number;
    accept?: string;
    signal?: AbortSignal;
    runtime?: SafeFetchRuntime;
  } = {},
): Promise<{ text: string; url: string; contentType: string; headers: Headers }> {
  if (options.signal?.aborted) {
    throw new HttpError(499, "读取已停止。", "REQUEST_CANCELLED");
  }
  let url = assertPublicHttpUrl(input);
  const maxBytes = options.maxBytes ?? 2_000_000;
  const runtime = options.runtime ?? DEFAULT_SAFE_FETCH_RUNTIME;
  if (!runtime || typeof runtime.fetchPinned !== "function" || typeof runtime.resolveDns !== "function") {
    throw new HttpError(503, "当前运行环境不能安全核对远程地址。", "DNS_SECURITY_UNAVAILABLE");
  }
  const requestSignal = composeRequestSignal(options.signal, 20_000);
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      // Re-resolve even when a redirect keeps the same hostname. A public
      // answer from an earlier request must not authorize a rebound target.
      const target = await assertPublicRemoteTarget(
        url,
        runtime.resolveDns,
        requestSignal.signal,
      );
      url = target.url;
      if (requestSignal.cause() === "caller") {
        throw new HttpError(499, "读取已停止。", "REQUEST_CANCELLED");
      }
      if (requestSignal.cause() === "timeout") {
        throw new HttpError(504, "读取远程内容超时。", "REMOTE_TIMEOUT");
      }
      let response: Response;
      try {
        response = await fetchPinnedRemoteTarget(target, {
          redirect: "manual",
          signal: requestSignal.signal,
          headers: {
            Accept: options.accept || "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.2",
            "User-Agent": "PrivateAISuite/1.0 (personal local reader)",
          },
        }, runtime.fetchPinned);
        if (requestSignal.cause() === "caller") {
          await response.body?.cancel().catch(() => undefined);
          throw new HttpError(499, "读取已停止。", "REQUEST_CANCELLED");
        }
        if (requestSignal.cause() === "timeout") {
          await response.body?.cancel().catch(() => undefined);
          throw new HttpError(504, "读取远程内容超时。", "REMOTE_TIMEOUT");
        }
      } catch (error) {
        if (requestSignal.cause() === "caller") {
          throw new HttpError(499, "读取已停止。", "REQUEST_CANCELLED");
        }
        if (requestSignal.cause() === "timeout") {
          throw new HttpError(504, "读取远程内容超时。", "REMOTE_TIMEOUT");
        }
        if (error instanceof HttpError) throw error;
        if (isAbortLike(error)) throw new HttpError(502, "无法读取这个链接，请改为粘贴内容。", "REMOTE_FETCH_FAILED");
        throw new HttpError(502, "无法读取这个链接，请改为粘贴内容。", "REMOTE_FETCH_FAILED");
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new HttpError(502, "远程链接重定向异常。", "REMOTE_REDIRECT_INVALID");
        url = assertPublicHttpUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const message = response.status === 401 || response.status === 403
          ? "该页面需要登录或禁止自动读取，请粘贴职位/文章正文。"
          : `读取链接失败（${response.status}），请改为粘贴内容。`;
        throw new HttpError(502, message, "REMOTE_FETCH_REJECTED");
      }
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!/(text|html|xml|json|rss|atom)/.test(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new HttpError(415, "这个链接不是可读取的文字内容。", "REMOTE_CONTENT_UNSUPPORTED");
      }
      const text = await readBoundedText(response, maxBytes);
      if (requestSignal.cause() === "caller") {
        throw new HttpError(499, "读取已停止。", "REQUEST_CANCELLED");
      }
      if (requestSignal.cause() === "timeout") {
        throw new HttpError(504, "读取远程内容超时。", "REMOTE_TIMEOUT");
      }
      return { text, url: url.toString(), contentType, headers: response.headers };
    }
    throw new HttpError(502, "远程链接重定向次数过多。", "TOO_MANY_REDIRECTS");
  } catch (error) {
    if (requestSignal.cause() === "caller") {
      throw new HttpError(499, "读取已停止。", "REQUEST_CANCELLED");
    }
    if (requestSignal.cause() === "timeout") {
      throw new HttpError(504, "读取远程内容超时。", "REMOTE_TIMEOUT");
    }
    if (error instanceof HttpError) throw error;
    if (isAbortLike(error)) throw new HttpError(502, "无法读取这个链接，请改为粘贴内容。", "REMOTE_FETCH_FAILED");
    throw new HttpError(502, "远程文字读取中断，请重试或改为粘贴内容。", "REMOTE_BODY_FAILED");
  } finally {
    requestSignal.dispose();
  }
}
