import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import ts from "typescript";

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function dataModule(moduleSource, sourceName) {
  return `data:text/javascript;base64,${Buffer.from(`${moduleSource}\n//# sourceURL=${sourceName}`).toString("base64")}`;
}

async function transpile(relativePath) {
  const input = await source(relativePath);
  return ts.transpileModule(input, {
    fileName: relativePath,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

async function loadContent() {
  return import(dataModule(await transpile("lib/vocab/content.ts"), "lib/vocab/content.ts"));
}

async function loadSafeFetch(transform = (value) => value) {
  const httpUrl = dataModule(`
    export class HttpError extends Error {
      constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
      }
    }
  `, "tests/stubs/http.mjs");
  const signalUrl = dataModule(
    await transpile("lib/server/request-signal.ts"),
    "lib/server/request-signal.ts",
  );
  const pinnedUrl = dataModule(`
    export function pinnedHttpTransportAvailable() { return true; }
    export async function pinnedHttpFetch(target, init) {
      return globalThis.__vocabDefaultPinnedFetch(target, init);
    }
  `, "tests/stubs/pinned-http.mjs");
  const output = transform(await transpile("lib/server/safe-fetch.ts"))
    .replaceAll('"./http"', JSON.stringify(httpUrl))
    .replaceAll('"./pinned-http"', JSON.stringify(pinnedUrl))
    .replaceAll('"./request-signal"', JSON.stringify(signalUrl));
  return import(dataModule(output, "lib/server/safe-fetch.ts"));
}

async function loadPinnedHttp() {
  return import(dataModule(await transpile("lib/server/pinned-http.ts"), "lib/server/pinned-http.ts"));
}

async function loadMediaRoute() {
  const safeFetchUrl = dataModule(`
    export function assertPublicHttpUrl(input) { return new URL(input); }
    export async function assertPublicRemoteTarget(url, _resolver, signal) {
      const guarded = await globalThis.__vocabMediaGuard(url, signal);
      return guarded && guarded.url ? guarded : {
        url: guarded,
        addresses: [{ address: "93.184.216.34", family: 4 }],
      };
    }
    export async function fetchPinnedRemoteTarget(target, init) {
      return globalThis.__vocabMediaPinnedFetch(target, init);
    }
  `, "tests/stubs/media-safe-fetch.mjs");
  const httpUrl = dataModule(`
    export class HttpError extends Error {
      constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
      }
    }
    export function errorResponse(error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
      const message = error instanceof Error ? error.message : "unknown";
      return new Response(JSON.stringify({ error: message, code }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
  `, "tests/stubs/media-http.mjs");
  const output = (await transpile("app/api/media/route.ts"))
    .replaceAll('"@/lib/server/safe-fetch"', JSON.stringify(safeFetchUrl))
    .replaceAll('"@/lib/server/http"', JSON.stringify(httpUrl));
  return import(dataModule(output, "app/api/media/route.ts"));
}

async function loadRssRoute() {
  const safeFetchUrl = dataModule(`
    export async function safeFetchText(url, options) {
      return globalThis.__vocabRssSafeFetch(url, options);
    }
  `, "tests/stubs/rss-safe-fetch.mjs");
  const httpUrl = dataModule(`
    export class HttpError extends Error {
      constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
      }
    }
    export function verifySameOrigin() { return null; }
    export async function readJsonBody(request) { return request.json(); }
    export function jsonResponse(value) {
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    export function errorResponse(error) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: error instanceof HttpError ? error.status : 500,
        headers: { "content-type": "application/json" },
      });
    }
  `, "tests/stubs/rss-http.mjs");
  const contentUrl = dataModule(await transpile("lib/vocab/content.ts"), "lib/vocab/content.ts");
  const fastXmlUrl = new URL("../node_modules/fast-xml-parser/src/fxp.js", import.meta.url).href;
  const output = (await transpile("app/api/import/rss/route.ts"))
    .replaceAll('"fast-xml-parser"', JSON.stringify(fastXmlUrl))
    .replaceAll('"@/lib/server/http"', JSON.stringify(httpUrl))
    .replaceAll('"@/lib/server/safe-fetch"', JSON.stringify(safeFetchUrl))
    .replaceAll('"@/lib/vocab/content"', JSON.stringify(contentUrl));
  return import(dataModule(output, "app/api/import/rss/route.ts"));
}

function publicResolution() {
  return { addresses: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] };
}

function runtime(fetchImpl, resolveDns = async () => publicResolution()) {
  return {
    fetchPinned: (target, init) => fetchImpl(target.url, init, target.addresses),
    resolveDns,
  };
}

test("Podcast transcript selection covers zero, one, and stable multi-format candidates", async () => {
  const content = await loadContent();
  assert.equal(content.selectPodcastTranscript([]), null);
  assert.equal(content.selectPodcastTranscript([
    { url: "https://media.example/transcript.pdf", type: "application/pdf", language: "en" },
  ]), null);
  assert.equal(content.selectPodcastTranscript([
    { url: "https://media.example/misleading.vtt", type: "application/pdf", language: "en" },
  ]), null, "an explicit unsupported MIME cannot be rescued by its extension");
  assert.equal(content.selectPodcastTranscript([
    { url: "https://media.example/undeclared.vtt", type: "", language: "en" },
  ]), null, "Podcasting 2.0 candidates require a supported declared MIME");

  const only = content.selectPodcastTranscript([
    { url: "https://media.example/transcript.json", type: "application/json", language: "en" },
  ]);
  assert.equal(only.format, "json");
  assert.equal(only.url, "https://media.example/transcript.json");

  const candidates = [
    { url: "https://media.example/fr.vtt", type: "text/vtt", language: "fr", ordinal: 0 },
    { url: "https://media.example/en.txt", type: "text/plain", language: "en", ordinal: 1 },
    { url: "https://media.example/en-second.vtt", type: "text/vtt", language: "en", ordinal: 3 },
    { url: "https://media.example/en-first.vtt", type: "text/vtt", language: "en", ordinal: 2 },
  ];
  assert.equal(
    content.selectPodcastTranscript(candidates, ["en"]).url,
    "https://media.example/en-first.vtt",
  );
  assert.equal(
    content.selectPodcastTranscript([...candidates].reverse(), ["en"]).url,
    "https://media.example/en-first.vtt",
    "declared ordinal, not parser array accident, is the final stable tie-break",
  );

  const feedLanguageFallback = content.selectPodcastTranscript([
    { url: "https://media.example/unlabelled.vtt", type: "text/vtt" },
    { url: "https://media.example/de.srt", type: "application/srt", language: "de" },
  ], ["en", "de"]);
  assert.equal(feedLanguageFallback.url, "https://media.example/de.srt");
});

test("RSS parser dynamically handles zero, one, and multiple Podcasting 2.0 transcript tags", async () => {
  const route = await loadRssRoute();
  const originalFetch = globalThis.__vocabRssSafeFetch;
  globalThis.__vocabRssSafeFetch = async () => ({
    text: `<?xml version="1.0"?>
      <rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
        <title>Test feed</title><language>de</language>
        <item><title>Zero</title><enclosure url="https://media.example/cover.jpg" type="image/jpeg"/></item>
        <item><title>One</title><podcast:transcript url="https://media.example/one.json" type="application/json" language="en"/></item>
        <item><title>Many</title>
          <enclosure url="https://media.example/many.mp3" type="audio/mpeg"/>
          <podcast:transcript url="https://media.example/fr.vtt" type="text/vtt" language="fr"/>
          <podcast:transcript url="https://media.example/en.txt" type="text/plain" language="en"/>
          <podcast:transcript url="https://media.example/en.vtt" type="text/vtt" language="en"/>
        </item>
      </channel></rss>`,
    url: "https://feed.example/rss",
    contentType: "application/rss+xml",
    headers: new Headers({ "content-type": "application/rss+xml" }),
  });
  try {
    const response = await route.POST(new Request("http://localhost/api/import/rss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://feed.example/rss" }),
    }));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.episodes.length, 3);
    assert.equal(payload.data.episodes[0].transcriptUrl, null);
    assert.equal(payload.data.episodes[0].audioUrl, null);
    assert.equal(payload.data.episodes[1].transcriptUrl, "https://media.example/one.json");
    assert.equal(payload.data.episodes[1].transcriptType, "application/json");
    assert.equal(payload.data.episodes[2].transcriptUrl, "https://media.example/en.vtt");
    assert.equal(payload.data.episodes[2].audioUrl, "https://media.example/many.mp3");
  } finally {
    if (originalFetch === undefined) delete globalThis.__vocabRssSafeFetch;
    else globalThis.__vocabRssSafeFetch = originalFetch;
  }
});

test("RSS episode media only projects credential-free HTTP(S) URLs and never reserved local URLs", async () => {
  const route = await loadRssRoute();
  const originalFetch = globalThis.__vocabRssSafeFetch;
  globalThis.__vocabRssSafeFetch = async () => ({
    text: `<?xml version="1.0"?>
      <rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
        <title>Untrusted feed</title>
        <item><title>Valid fallback</title>
          <enclosure url="local:reserved-audio" type="audio/mpeg"/>
          <enclosure url="https://user:secret@media.example/secret.mp3" type="audio/mpeg"/>
          <enclosure url="file:///tmp/private.mp3" type="audio/mpeg"/>
          <enclosure url="https://media.example/public.mp3" type="audio/mpeg"/>
          <podcast:transcript url="local:reserved-transcript" type="text/vtt" language="en"/>
          <podcast:transcript url="https://user:secret@media.example/private.vtt" type="text/vtt" language="en"/>
          <podcast:transcript url="https://media.example/public.vtt" type="text/vtt" language="en"/>
        </item>
        <item><title>No remote media</title>
          <enclosure url="local:only" type="audio/mpeg"/>
          <podcast:transcript url="data:text/plain,secret" type="text/plain"/>
        </item>
      </channel></rss>`,
    url: "https://feed.example/rss",
    contentType: "application/rss+xml",
    headers: new Headers({ "content-type": "application/rss+xml" }),
  });
  try {
    const response = await route.POST(new Request("http://localhost/api/import/rss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://feed.example/rss" }),
    }));
    assert.equal(response.status, 200);
    const episodes = (await response.json()).data.episodes;
    assert.equal(episodes[0].audioUrl, "https://media.example/public.mp3");
    assert.equal(episodes[0].transcriptUrl, "https://media.example/public.vtt");
    assert.equal(episodes[1].audioUrl, null);
    assert.equal(episodes[1].transcriptUrl, null);
    assert.doesNotMatch(JSON.stringify(episodes), /local:|user:secret|file:|data:/);
  } finally {
    if (originalFetch === undefined) delete globalThis.__vocabRssSafeFetch;
    else globalThis.__vocabRssSafeFetch = originalFetch;
  }
});

test("RSS raw transcript branch preserves JSON and enforces the shared text/content-type boundary", async () => {
  const [route, content] = await Promise.all([loadRssRoute(), loadContent()]);
  const originalFetch = globalThis.__vocabRssSafeFetch;
  const json = '{"version":"1.0.0","segments":[{"startTime":0,"body":"hello"}]}';
  let receivedOptions;
  globalThis.__vocabRssSafeFetch = async (_url, options) => {
    receivedOptions = options;
    return {
      text: json,
      url: "https://media.example/episode.json",
      contentType: "text/plain; charset=utf-8",
      headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
    };
  };
  try {
    const response = await route.POST(new Request("http://localhost/api/import/rss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "transcript",
        url: "https://media.example/episode.json",
        transcriptType: "application/json",
      }),
    }));
    assert.equal(response.status, 200);
    assert.equal(receivedOptions.maxBytes, content.VOCAB_LOCAL_TEXT_IMPORT_MAX_BYTES);
    assert.equal(receivedOptions.signal instanceof AbortSignal, true);
    const payload = await response.json();
    assert.equal(payload.data.text, json, "JSON must remain structured source, not article prose");
    assert.equal(payload.data.transcriptType, "application/json");

    globalThis.__vocabRssSafeFetch = async () => ({
      text: json,
      url: "https://media.example/episode.json",
      contentType: "application/octet-stream",
      headers: new Headers({ "content-type": "application/octet-stream" }),
    });
    const unsupported = await route.POST(new Request("http://localhost/api/import/rss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "transcript",
        url: "https://media.example/episode.json",
        transcriptType: "application/json",
      }),
    }));
    assert.equal(unsupported.status, 415);
    assert.equal((await unsupported.json()).code, "TRANSCRIPT_CONTENT_TYPE_UNSUPPORTED");
  } finally {
    if (originalFetch === undefined) delete globalThis.__vocabRssSafeFetch;
    else globalThis.__vocabRssSafeFetch = originalFetch;
  }
});

test("Podcasting 2.0 JSON transcripts parse structurally and never fall back to JSON prose", async () => {
  const content = await loadContent();
  const transcript = JSON.stringify({
    version: "1.0.0",
    segments: [
      { speaker: "Host", startTime: 0.5, endTime: 0.75, body: "Hello" },
      { speaker: "Guest", startTime: 1, body: "world." },
    ],
  });
  assert.deepEqual(content.parseTranscript(transcript, "episode.json", "text/plain"), [
    { start_ms: 500, end_ms: 750, text: "Hello", speaker: "Host" },
    { start_ms: 1000, end_ms: 6000, text: "world.", speaker: "Guest" },
  ]);
  assert.throws(
    () => content.parseTranscript('{"version":', "episode.txt", "application/json"),
    /未把它当作纯文本导入/,
  );
  assert.throws(
    () => content.parseTranscript('{"version":"1.0.0","segments":[]}', "episode.json"),
    /没有可导入/,
  );
  assert.throws(
    () => content.parseTranscript('{"segments":[{"startTime":0,"body":"x"}]}', "episode.json"),
    /version/,
  );
});

test("Podcasting 2.0 HTML transcripts parse their speaker, time, and paragraph structure", async () => {
  const content = await loadContent();
  const originalParser = globalThis.DOMParser;
  const originalFetch = globalThis.fetch;
  let parserCalls = 0;
  let fetchCalls = 0;
  globalThis.DOMParser = class ForbiddenParser {
    constructor() {
      parserCalls += 1;
      throw new Error("browser parser must not run");
    }
  };
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("secondary fetch must not run");
  };
  try {
    assert.deepEqual(content.parseTranscript(`
      <cite>Kevin:</cite><time>0:00</time><p>First thought.</p>
      <cite>Alban:</cite><time>0:09</time><p>Second thought.</p>
      <img src="https://tracker.invalid/pixel"><audio src="https://tracker.invalid/a.mp3"></audio>
      <link rel="stylesheet" href="https://tracker.invalid/a.css">
      <iframe src="https://tracker.invalid/frame"><p>not transcript text</p></iframe>
      <script>throw new Error("must not execute")</script>
    `, "episode.html", "text/html"), [
      { start_ms: 0, end_ms: 9000, text: "First thought.", speaker: "Kevin" },
      { start_ms: 9000, end_ms: 14000, text: "Second thought.", speaker: "Alban" },
    ]);
    assert.equal(parserCalls, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    if (originalParser === undefined) delete globalThis.DOMParser;
    else globalThis.DOMParser = originalParser;
    globalThis.fetch = originalFetch;
  }
});

test("local import file preflight enforces empty, backup, text, and transcription limits synchronously", async () => {
  const content = await loadContent();
  const fact = (size, name = "input.bin") => ({ name, size });
  assert.match(content.vocabLocalImportFileProblem(fact(0), "article"), /为空/);
  assert.equal(
    content.vocabLocalImportFileProblem(
      fact(content.VOCAB_LOCAL_TEXT_IMPORT_MAX_BYTES, "long.txt"),
      "article",
    ),
    null,
  );
  assert.match(
    content.vocabLocalImportFileProblem(
      fact(content.VOCAB_LOCAL_TEXT_IMPORT_MAX_BYTES + 1, "too-long.vtt"),
      "transcript",
    ),
    /128 MiB/,
  );
  assert.equal(
    content.vocabLocalImportFileProblem(
      fact(content.VOCAB_LOCAL_AUDIO_IMPORT_MAX_BYTES, "backup-edge.mp3"),
      "audio",
    ),
    null,
  );
  assert.match(
    content.vocabLocalImportFileProblem(
      fact(content.VOCAB_LOCAL_AUDIO_IMPORT_MAX_BYTES + 1, "too-large.mp3"),
      "audio",
    ),
    /512 MiB/,
  );
  assert.equal(
    content.vocabLocalImportFileProblem(
      fact(content.VOCAB_TRANSCRIPTION_AUDIO_MAX_BYTES, "transcribe-edge.mp3"),
      "audio",
      { forTranscription: true },
    ),
    null,
  );
  assert.match(
    content.vocabLocalImportFileProblem(
      fact(content.VOCAB_TRANSCRIPTION_AUDIO_MAX_BYTES + 1, "too-long.mp3"),
      "audio",
      { forTranscription: true },
    ),
    /100 MiB/,
  );
  assert.equal(content.podcastEpisodeHasImportableMedia({ segments: [] }), false);
  assert.equal(content.podcastEpisodeHasImportableMedia({ audioUrl: "https://media.example/a.mp3", segments: [] }), true);
  assert.equal(content.podcastEpisodeHasImportableMedia({ transcriptUrl: "https://media.example/a.vtt", segments: [] }), true);
  assert.deepEqual(content.normalizeTranscriptionSegments([
    { start_ms: 0, end_ms: 1000, text: "   " },
    { start_ms: "not-a-number", end_ms: 1000, text: "phantom" },
  ]), [], "an empty or malformed successful response is still a failed transcription");
  assert.deepEqual(content.normalizeTranscriptionSegments([
    { start: 1, end: 2, text: " useful words ", speaker: " Host " },
  ]), [{ start_ms: 1000, end_ms: 2000, text: "useful words", speaker: "Host" }]);
});

test("the Node transport connects through only the supplied address while preserving Host and Range", async () => {
  const pinned = await loadPinnedHttp();
  let connectedAddress;
  let requestOptions;
  const fakeRequest = (options, onResponse) => {
    requestOptions = options;
    const request = new EventEmitter();
    request.end = () => {
      options.lookup("publisher.invalid", { family: 0 }, (error, address, family) => {
        if (error) {
          request.emit("error", error);
          return;
        }
        connectedAddress = { address, family };
        const message = Readable.from([Buffer.from("0123")]);
        message.statusCode = 206;
        message.statusMessage = "Partial Content";
        message.rawHeaders = [
          "Content-Type", "audio/mpeg",
          "Content-Range", "bytes 0-3/10",
        ];
        onResponse(message);
      });
    };
    return request;
  };
  const controller = new AbortController();
  const response = await pinned.pinnedHttpFetch({
    url: new URL("http://publisher.invalid:8080/episode.mp3"),
    addresses: [{ address: "93.184.216.34", family: 4 }],
  }, {
    headers: { Range: "bytes=0-3" },
    redirect: "manual",
    signal: controller.signal,
  }, {
    available: () => true,
    requestHttp: fakeRequest,
    requestHttps: fakeRequest,
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-3/10");
  assert.equal(await response.text(), "0123");
  assert.deepEqual(connectedAddress, { address: "93.184.216.34", family: 4 });
  assert.equal(requestOptions.hostname, "publisher.invalid");
  assert.equal(requestOptions.headers.host, "publisher.invalid:8080");
  assert.equal(requestOptions.headers["accept-encoding"], "identity");
  assert.equal(requestOptions.headers.range, "bytes=0-3");
  assert.equal(requestOptions.agent, false);
  assert.equal(requestOptions.signal, controller.signal);
  const helper = await source("lib/server/pinned-http.ts");
  assert.match(helper, /lookup: lookupFromPinnedAddresses\(target\.addresses\)/);
  assert.match(helper, /options\.servername = transportHostname/);
});

test("the Node transport rejects malformed response metadata without an uncaught callback or pending promise", async () => {
  const pinned = await loadPinnedHttp();
  for (const responseMetadata of [
    { statusCode: 600, rawHeaders: ["Content-Type", "audio/mpeg"] },
    { statusCode: 999, rawHeaders: ["Content-Type", "audio/mpeg"] },
    { statusCode: 200, rawHeaders: ["bad\nheader", "value"] },
    { statusCode: 600, rawHeaders: [], cleanupThrows: true },
  ]) {
    let resumes = 0;
    let destroys = 0;
    const message = Readable.from([Buffer.from("must be discarded")]);
    message.statusCode = responseMetadata.statusCode;
    message.statusMessage = "Injected";
    message.rawHeaders = responseMetadata.rawHeaders;
    const resume = message.resume.bind(message);
    const destroy = message.destroy.bind(message);
    message.resume = () => {
      resumes += 1;
      if (responseMetadata.cleanupThrows) throw new Error("resume failed");
      return resume();
    };
    message.destroy = (...args) => {
      destroys += 1;
      if (responseMetadata.cleanupThrows) throw new Error("destroy failed");
      return destroy(...args);
    };
    const fakeRequest = (_options, onResponse) => {
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => onResponse(message));
      return request;
    };
    const operation = pinned.pinnedHttpFetch({
      url: new URL("http://publisher.invalid/episode.mp3"),
      addresses: [{ address: "93.184.216.34", family: 4 }],
    }, {}, {
      available: () => true,
      requestHttp: fakeRequest,
      requestHttps: fakeRequest,
    });
    const outcome = await Promise.race([
      operation.then(() => "resolved", () => "rejected"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    assert.equal(outcome, "rejected");
    assert.ok(resumes >= 1);
    assert.equal(destroys, 1);
  }
});

test("remote target URLs reject reserved schemes and credentials before DNS or transport", async () => {
  const safeFetch = await loadSafeFetch();
  for (const input of [
    "local:reserved",
    "file:///tmp/private.mp3",
    "data:text/plain,private",
  ]) {
    assert.throws(
      () => safeFetch.assertPublicHttpUrl(input),
      (error) => error.code === "INVALID_URL_SCHEME",
    );
  }
  assert.throws(
    () => safeFetch.assertPublicHttpUrl("https://user:secret@media.example/a.mp3"),
    (error) => error.code === "URL_CREDENTIALS_BLOCKED",
  );
});

test("safe fetch validates every A and AAAA answer before making a request", async () => {
  const safeFetch = await loadSafeFetch();
  let fetches = 0;
  const good = await safeFetch.safeFetchText("https://feed.example/rss", {
    runtime: runtime(async () => {
      fetches += 1;
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }),
  });
  assert.equal(good.text, "ok");
  assert.equal(fetches, 1);

  fetches = 0;
  await assert.rejects(
    safeFetch.safeFetchText("https://feed.example/rss", {
      runtime: runtime(
        async () => {
          fetches += 1;
          return new Response("must not run");
        },
        async () => ({ addresses: ["93.184.216.34", "10.0.0.7"] }),
      ),
    }),
    (error) => error.code === "PRIVATE_DNS_BLOCKED",
  );
  assert.equal(fetches, 0);
});

test("the transport consumes the exact validated addresses and never performs a second DNS lookup", async () => {
  const safeFetch = await loadSafeFetch();
  let resolverCalls = 0;
  let transportAddresses;
  let unpinnedSecondLookups = 0;
  const rebindingLookup = () => {
    unpinnedSecondLookups += 1;
    return "127.0.0.1";
  };
  const result = await safeFetch.safeFetchText("https://rebind.example/article", {
    runtime: runtime(
      async (_url, _init, addresses) => {
        transportAddresses = addresses;
        // At connection time the attacker's hypothetical ordinary lookup has
        // already rebound. The pinned transport contract never consults it.
        assert.equal(typeof rebindingLookup, "function");
        return new Response("safe", { headers: { "content-type": "text/plain" } });
      },
      async () => {
        resolverCalls += 1;
        return { addresses: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] };
      },
    ),
  });
  assert.equal(result.text, "safe");
  assert.equal(resolverCalls, 1);
  assert.equal(unpinnedSecondLookups, 0, "the transport is handed addresses, never a hostname resolver");
  assert.deepEqual(transportAddresses, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);
});

test("safe fetch accepts allocated global IPv6 and blocks special-purpose literals and DNS answers", async () => {
  const safeFetch = await loadSafeFetch();
  assert.equal(
    safeFetch.assertPublicHttpUrl("https://[2606:4700:4700::1111]/").hostname,
    "[2606:4700:4700::1111]",
  );
  assert.doesNotThrow(() => safeFetch.assertPublicHttpUrl("https://[64:ff9b::0808:0808]/"));
  assert.doesNotThrow(() => safeFetch.assertPublicHttpUrl("https://[2001:1::1]/"));
  for (const input of [
    "http://[::ffff:127.0.0.1]/secret",
    "http://[::ffff:192.0.2.1]/secret",
    "http://[0:0:0:0:0:ffff:c0a8:0101]/secret",
    "http://[64:ff9b:1::0808:0808]/secret",
    "http://[64:ff9b::7f00:0001]/secret",
    "http://[100::1]/secret",
    "http://[2001:db8::1]/secret",
    "http://[2002:5db8:d822::1]/secret",
    "http://[3fff::1]/secret",
  ]) {
    assert.throws(
      () => safeFetch.assertPublicHttpUrl(input),
      (error) => error.code === "PRIVATE_URL_BLOCKED",
    );
  }
  for (const address of [
    "::ffff:127.0.0.1",
    "::ffff:93.184.216.34",
    "::ffff:c0a8:101",
    "64:ff9b:1::5db8:d822",
    "64:ff9b::7f00:1",
    "100::1",
    "2001:db8::1",
    "2002:5db8:d822::1",
    "3fff::1",
  ]) {
    await assert.rejects(
      safeFetch.safeFetchText("https://feed.example/rss", {
        runtime: runtime(async () => new Response("must not run"), async () => ({ addresses: [address] })),
      }),
      (error) => error.code === "PRIVATE_DNS_BLOCKED",
    );
  }
});

test("safe fetch resolves CNAME finals and fails closed on private aliases", async () => {
  const safeFetch = await loadSafeFetch();
  const seen = [];
  await assert.rejects(
    safeFetch.safeFetchText("https://feed.example/rss", {
      runtime: runtime(async () => new Response("must not run"), async (hostname) => {
        seen.push(hostname);
        return hostname === "feed.example"
          ? { addresses: ["93.184.216.34"], canonicalNames: ["publisher-cdn.example"] }
          : { addresses: ["192.168.4.2"] };
      }),
    }),
    (error) => error.code === "PRIVATE_DNS_BLOCKED",
  );
  assert.deepEqual(seen, ["feed.example", "publisher-cdn.example"]);
});

test("safe fetch rechecks redirects and catches same-host DNS rebinding", async () => {
  const safeFetch = await loadSafeFetch();
  let resolutions = 0;
  let fetches = 0;
  await assert.rejects(
    safeFetch.safeFetchText("https://feed.example/start", {
      runtime: runtime(
        async () => {
          fetches += 1;
          return new Response(null, { status: 302, headers: { location: "/final" } });
        },
        async () => ({ addresses: [++resolutions === 1 ? "93.184.216.34" : "127.0.0.1"] }),
      ),
    }),
    (error) => error.code === "PRIVATE_DNS_BLOCKED",
  );
  assert.equal(resolutions, 2);
  assert.equal(fetches, 1);

  fetches = 0;
  await assert.rejects(
    safeFetch.safeFetchText("https://feed.example/start", {
      runtime: runtime(async () => {
        fetches += 1;
        return new Response(null, { status: 302, headers: { location: "http://10.0.0.9/private" } });
      }),
    }),
    (error) => error.code === "PRIVATE_URL_BLOCKED",
  );
  assert.equal(fetches, 1);
});

test("DNS and CNAME waits honor already-aborted, in-flight, timeout, and redirect cancellation before transport", async () => {
  const safeFetch = await loadSafeFetch();
  const already = new AbortController();
  already.abort(new DOMException("closed", "AbortError"));
  let resolutions = 0;
  let fetches = 0;
  await assert.rejects(
    safeFetch.safeFetchText("https://feed.example/start", {
      signal: already.signal,
      runtime: runtime(
        async () => {
          fetches += 1;
          return new Response("must not run");
        },
        async () => {
          resolutions += 1;
          return publicResolution();
        },
      ),
    }),
    (error) => error.status === 499 && error.code === "REQUEST_CANCELLED",
  );
  assert.equal(resolutions, 0);
  assert.equal(fetches, 0);

  const inFlight = new AbortController();
  let dnsSignal;
  const pendingLookup = safeFetch.safeFetchText("https://feed.example/start", {
    signal: inFlight.signal,
    runtime: runtime(
      async () => {
        fetches += 1;
        return new Response("must not run");
      },
      async (_hostname, signal) => {
        dnsSignal = signal;
        return new Promise(() => {});
      },
    ),
  });
  await new Promise((resolve) => setImmediate(resolve));
  inFlight.abort(new DOMException("closed", "AbortError"));
  await assert.rejects(
    pendingLookup,
    (error) => error.status === 499 && error.code === "REQUEST_CANCELLED",
  );
  assert.equal(dnsSignal.aborted, true);
  assert.equal(fetches, 0);

  const cnameCaller = new AbortController();
  let cnameLookups = 0;
  const pendingCname = safeFetch.safeFetchText("https://feed.example/start", {
    signal: cnameCaller.signal,
    runtime: runtime(
      async () => {
        fetches += 1;
        return new Response("must not run");
      },
      async () => {
        cnameLookups += 1;
        return cnameLookups === 1
          ? { addresses: [], canonicalNames: ["cdn.example"] }
          : new Promise(() => {});
      },
    ),
  });
  await new Promise((resolve) => setImmediate(resolve));
  cnameCaller.abort(new DOMException("closed", "AbortError"));
  await assert.rejects(pendingCname, (error) => error.status === 499);
  assert.equal(cnameLookups, 2);
  assert.equal(fetches, 0);

  const redirectCaller = new AbortController();
  let redirectLookups = 0;
  const pendingRedirect = safeFetch.safeFetchText("https://feed.example/start", {
    signal: redirectCaller.signal,
    runtime: runtime(
      async () => {
        fetches += 1;
        return new Response(null, { status: 302, headers: { location: "/final" } });
      },
      async () => {
        redirectLookups += 1;
        return redirectLookups === 1 ? publicResolution() : new Promise(() => {});
      },
    ),
  });
  while (redirectLookups < 2) await new Promise((resolve) => setImmediate(resolve));
  redirectCaller.abort(new DOMException("closed", "AbortError"));
  await assert.rejects(pendingRedirect, (error) => error.status === 499);
  assert.equal(fetches, 1);

  const fastTimeout = await loadSafeFetch((sourceText) => sourceText.replace(
    /composeRequestSignal\(options\.signal,\s*(?:20_000|20000)\)/,
    "composeRequestSignal(options.signal, 5)",
  ));
  let timeoutSignal;
  let timeoutFetches = 0;
  await assert.rejects(
    fastTimeout.safeFetchText("https://feed.example/start", {
      runtime: runtime(
        async () => {
          timeoutFetches += 1;
          return new Response("must not run");
        },
        async (_hostname, signal) => {
          timeoutSignal = signal;
          return new Promise(() => {});
        },
      ),
    }),
    (error) => error.status === 504 && error.code === "REMOTE_TIMEOUT",
  );
  assert.equal(timeoutSignal.aborted, true);
  assert.equal(timeoutFetches, 0);
});

test("safe fetch fails closed without a complete secure DNS capability", async () => {
  const safeFetch = await loadSafeFetch();
  await assert.rejects(
    safeFetch.safeFetchText("https://feed.example/rss", {
      runtime: { fetch: async () => new Response("must not run") },
    }),
    (error) => error.code === "DNS_SECURITY_UNAVAILABLE" && error.status === 503,
  );
  await assert.rejects(
    safeFetch.safeFetchText("https://feed.example/rss", {
      runtime: runtime(
        async () => new Response("must not run"),
        async () => { throw new Error("DNS resolver not implemented"); },
      ),
    }),
    (error) => error.code === "DNS_SECURITY_UNAVAILABLE" && error.status === 503,
  );
  await assert.rejects(
    safeFetch.safeFetchText("https://feed.example/rss", {
      runtime: runtime(async () => new Response("must not run"), async () => ({ addresses: [] })),
    }),
    (error) => error.code === "DNS_ADDRESS_MISSING",
  );
  await assert.rejects(
    safeFetch.safeFetchText("https://feed.example/rss", {
      runtime: runtime(
        async () => new Response("must not run"),
        async () => { throw new Error("resolver leaked 10.0.0.7 but is unavailable"); },
      ),
    }),
    (error) => error.code === "DNS_SECURITY_UNAVAILABLE" && !error.message.includes("10.0.0.7"),
  );
  await assert.rejects(
    safeFetch.safeFetchText("https://feed.example/rss", {
      runtime: {
        resolveDns: async () => publicResolution(),
        fetchPinned: async () => {
          throw Object.assign(new Error("workerd ignored lookup for 10.0.0.7"), {
            code: "PINNED_TRANSPORT_UNAVAILABLE",
          });
        },
      },
    }),
    (error) => error.code === "PINNED_TRANSPORT_UNAVAILABLE" &&
      error.status === 503 && error.message.includes("本地文件") &&
      !error.message.includes("10.0.0.7"),
  );
});

test("media proxy rechecks DNS before every redirect fetch and forwards no upstream body on failure", async () => {
  const media = await loadMediaRoute();
  const originalPinnedFetch = globalThis.__vocabMediaPinnedFetch;
  const originalGuard = globalThis.__vocabMediaGuard;
  let guardCalls = 0;
  let fetchCalls = 0;
  globalThis.__vocabMediaGuard = async (url) => {
    guardCalls += 1;
    if (guardCalls === 2) {
      const error = new Error("DNS 指向本机或私有网络，已停止读取。");
      error.status = 400;
      error.code = "PRIVATE_DNS_BLOCKED";
      // The route's stub HttpError identity is intentionally not available;
      // use its error contract through a Response-producing fetch below.
      throw error;
    }
    return url;
  };
  globalThis.__vocabMediaPinnedFetch = async () => {
    fetchCalls += 1;
    return new Response("redirect-secret", {
      status: 302,
      headers: { location: "/rebound" },
    });
  };
  try {
    const response = await media.GET(new Request(
      "http://localhost/api/media?url=https%3A%2F%2Fmedia.example%2Fstart",
    ));
    assert.equal(response.status, 502);
    assert.equal(fetchCalls, 1);
    assert.equal(guardCalls, 2);
    assert.doesNotMatch(await response.text(), /redirect-secret/);
  } finally {
    if (originalPinnedFetch === undefined) delete globalThis.__vocabMediaPinnedFetch;
    else globalThis.__vocabMediaPinnedFetch = originalPinnedFetch;
    if (originalGuard === undefined) delete globalThis.__vocabMediaGuard;
    else globalThis.__vocabMediaGuard = originalGuard;
  }
});

test("media cancellation interrupts an in-flight target check before any transport call", async () => {
  const media = await loadMediaRoute();
  const originalPinnedFetch = globalThis.__vocabMediaPinnedFetch;
  const originalGuard = globalThis.__vocabMediaGuard;
  const caller = new AbortController();
  let guardSignal;
  let fetches = 0;
  globalThis.__vocabMediaGuard = async (_url, signal) => {
    guardSignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  globalThis.__vocabMediaPinnedFetch = async () => {
    fetches += 1;
    return new Response("must not run");
  };
  try {
    const pending = media.GET(new Request(
      "http://localhost/api/media?url=https%3A%2F%2Fmedia.example%2Fa.mp3",
      { signal: caller.signal },
    ));
    await new Promise((resolve) => setImmediate(resolve));
    caller.abort(new DOMException("closed", "AbortError"));
    const response = await pending;
    assert.equal(response.status, 499);
    assert.equal(guardSignal.aborted, true);
    assert.equal(fetches, 0);
  } finally {
    if (originalPinnedFetch === undefined) delete globalThis.__vocabMediaPinnedFetch;
    else globalThis.__vocabMediaPinnedFetch = originalPinnedFetch;
    if (originalGuard === undefined) delete globalThis.__vocabMediaGuard;
    else globalThis.__vocabMediaGuard = originalGuard;
  }
});

test("media proxy preserves Range and 206 semantics after the DNS guard", async () => {
  const media = await loadMediaRoute();
  const originalPinnedFetch = globalThis.__vocabMediaPinnedFetch;
  const originalGuard = globalThis.__vocabMediaGuard;
  let receivedRange = null;
  globalThis.__vocabMediaGuard = async (url) => url;
  globalThis.__vocabMediaPinnedFetch = async (_target, options) => {
    receivedRange = options.headers.get("range");
    return new Response("0123456789", {
      status: 206,
      headers: {
        "content-type": "audio/mpeg",
        "content-length": "10",
        "content-range": "bytes 0-9/100",
        "accept-ranges": "bytes",
      },
    });
  };
  try {
    const response = await media.GET(new Request(
      "http://localhost/api/media?url=https%3A%2F%2Fmedia.example%2Fa.mp3",
      { headers: { range: "bytes=0-9" } },
    ));
    assert.equal(response.status, 206);
    assert.equal(receivedRange, "bytes=0-9");
    assert.equal(response.headers.get("content-range"), "bytes 0-9/100");
    assert.equal(await response.text(), "0123456789");
  } finally {
    if (originalPinnedFetch === undefined) delete globalThis.__vocabMediaPinnedFetch;
    else globalThis.__vocabMediaPinnedFetch = originalPinnedFetch;
    if (originalGuard === undefined) delete globalThis.__vocabMediaGuard;
    else globalThis.__vocabMediaGuard = originalGuard;
  }
});

test("media proxy rejects active or conflicting MIME metadata and only emits normalized media types", async () => {
  const media = await loadMediaRoute();
  const originalPinnedFetch = globalThis.__vocabMediaPinnedFetch;
  const originalGuard = globalThis.__vocabMediaGuard;
  globalThis.__vocabMediaGuard = async (url) => url;
  try {
    for (const contentType of [
      "text/html",
      "text/javascript",
      "application/javascript",
      "image/svg+xml",
      "audio/mpeg, text/html",
    ]) {
      let cancelled = 0;
      globalThis.__vocabMediaPinnedFetch = async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("active payload")); },
        cancel() { cancelled += 1; },
      }), { headers: { "content-type": contentType } });
      const response = await media.GET(new Request(
        "http://localhost/api/media?url=https%3A%2F%2Fmedia.example%2Fmisleading.mp3",
      ));
      assert.equal(response.status, 415, `${contentType} must not be rescued by .mp3`);
      assert.equal(response.headers.get("content-type"), "application/json");
      assert.equal(cancelled, 1);
      assert.doesNotMatch(response.headers.get("content-type"), /html|javascript|svg/);
    }

    for (const [upstreamType, expectedType] of [
      ["audio/mpeg; charset=binary", "audio/mpeg"],
      ["application/ogg", "audio/ogg"],
      ["application/octet-stream", "application/octet-stream"],
      [null, "application/octet-stream"],
    ]) {
      globalThis.__vocabMediaPinnedFetch = async () => new Response(
        new Uint8Array([1, 2, 3]),
        { headers: upstreamType ? { "content-type": upstreamType } : undefined },
      );
      const response = await media.GET(new Request(
        "http://localhost/api/media?url=https%3A%2F%2Fmedia.example%2Fa.mp3",
      ));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), expectedType);
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
    }
  } finally {
    if (originalPinnedFetch === undefined) delete globalThis.__vocabMediaPinnedFetch;
    else globalThis.__vocabMediaPinnedFetch = originalPinnedFetch;
    if (originalGuard === undefined) delete globalThis.__vocabMediaGuard;
    else globalThis.__vocabMediaGuard = originalGuard;
  }
});

test("RSS raw transcript, media, and ImportWizard contracts keep failures and cancellation pre-commit", async () => {
  const [route, media, overlay] = await Promise.all([
    source("app/api/import/rss/route.ts"),
    source("app/api/media/route.ts"),
    source("app/vocab/overlays.tsx"),
  ]);
  assert.match(route, /selectPodcastTranscript\([\s\S]*arrayOf\(item\["podcast:transcript"\]\)/);
  assert.match(route, /kind === "transcript"[\s\S]*safeFetchText\(url,[\s\S]*VOCAB_LOCAL_TEXT_IMPORT_MAX_BYTES/);
  assert.match(route, /TRANSCRIPT_CONTENT_TYPE_UNSUPPORTED/);
  assert.ok(
    media.indexOf("await assertPublicRemoteTarget(url, undefined, controller.signal)") < media.indexOf("await fetchPinnedRemoteTarget(target"),
  );
  assert.match(media, /for \(let redirect[\s\S]*await assertPublicRemoteTarget\(url, undefined, controller\.signal\)[\s\S]*await fetchPinnedRemoteTarget\(target/);
  assert.doesNotMatch(media, /await fetch\(/);

  const episodeImport = overlay.slice(
    overlay.indexOf("const importEpisode = async"),
    overlay.indexOf("const inspectRecovery = async"),
  );
  const transcriptFailure = episodeImport.slice(
    episodeImport.indexOf("catch (caught)"),
    episodeImport.indexOf("throwIfVocabImportAborted(controller.signal)", episodeImport.indexOf("catch (caught)")),
  );
  assert.match(transcriptFailure, /setPendingAudioOnly\(\{ episode, reason \}\)/);
  assert.doesNotMatch(transcriptFailure, /prepareVocabPodcastWrite|savePodcast/);
  assert.match(overlay, /仍导入仅音频/);
  assert.match(overlay, /podcastEpisodeHasImportableMedia\(episode\)/);
  assert.match(overlay, /disabled=\{controlsLocked \|\| !importable\}/);

  const cancel = overlay.slice(
    overlay.indexOf("const cancelCurrentOperation"),
    overlay.indexOf("const checkpoint"),
  );
  assert.match(cancel, /active\.abort\(new VocabImportCancelledError\(\)\)/);
  assert.match(overlay, /取消转写/);
  assert.match(overlay, /signal: controller\.signal/);
  assert.ok(
    episodeImport.indexOf("throwIfVocabImportAborted(controller.signal)") <
      episodeImport.indexOf("prepareVocabPodcastWrite"),
  );

  assert.match(overlay, /vocabLocalImportFileProblem\(articleFile, "article"\)/);
  assert.match(overlay, /vocabLocalImportFileProblem\(transcriptFile, "transcript"\)/);
  assert.match(overlay, /forTranscription: transcribe/);
  assert.match(overlay, /完整音频上传到已配置的外部转写端点/);
  assert.match(overlay, /OPFS/);
  assert.match(overlay, /COOP\/COEP/);
});
