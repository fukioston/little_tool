import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

async function loadRequestSignalModule() {
  const input = await source("lib/server/request-signal.ts");
  const output = ts.transpileModule(input, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
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

async function loadServerModule(relativePath, transform = (value) => value) {
  const httpUrl = dataModule(`
    export class HttpError extends Error {
      constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
      }
    }
  `, "tests/stubs/http.mjs");
  const signalUrl = dataModule(await transpile("lib/server/request-signal.ts"), "lib/server/request-signal.ts");
  const output = transform(await transpile(relativePath))
    .replaceAll('"./http"', JSON.stringify(httpUrl))
    .replaceAll('"./request-signal"', JSON.stringify(signalUrl));
  return import(dataModule(output, relativePath));
}

test("caller cancellation immediately reaches the composed upstream signal", async () => {
  const { composeRequestSignal } = await loadRequestSignalModule();
  const caller = new AbortController();
  const composed = composeRequestSignal(caller.signal, 60_000);
  caller.abort(new DOMException("panel closed", "AbortError"));
  assert.equal(composed.signal.aborted, true);
  assert.equal(composed.signal.reason.name, "AbortError");
  assert.equal(composed.cause(), "caller");
  assert.equal(composed.timedOut(), false);
  composed.dispose();
});

test("timeout remains distinguishable from a user cancellation", async () => {
  const { composeRequestSignal } = await loadRequestSignalModule();
  const composed = composeRequestSignal(undefined, 1);
  await new Promise((resolve) => composed.signal.addEventListener("abort", resolve, { once: true }));
  assert.equal(composed.signal.aborted, true);
  assert.equal(composed.signal.reason.name, "TimeoutError");
  assert.equal(composed.cause(), "timeout");
  assert.equal(composed.timedOut(), true);
  composed.dispose();
});

test("the first abort cause remains truthful when caller cancellation follows a timeout", async () => {
  const { composeRequestSignal } = await loadRequestSignalModule();
  const caller = new AbortController();
  const composed = composeRequestSignal(caller.signal, 1);
  await new Promise((resolve) => composed.signal.addEventListener("abort", resolve, { once: true }));
  caller.abort(new DOMException("closed later", "AbortError"));
  assert.equal(composed.cause(), "timeout");
  assert.equal(composed.signal.reason.name, "TimeoutError");
  composed.dispose();
});

test("multipart parsing settles promptly and releases its body when the caller cancels", async () => {
  const { readAbortableFormData } = await loadRequestSignalModule();
  const caller = new AbortController();
  const encoder = new TextEncoder();
  let bodyCancelled = 0;
  const request = new Request("http://localhost/api/transcribe", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=test-boundary" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          "--test-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\npartial",
        ));
      },
      cancel() { bodyCancelled += 1; },
    }),
    signal: caller.signal,
    duplex: "half",
  });
  const pending = readAbortableFormData(request).then(
    () => "resolved",
    (error) => error?.name ?? "rejected",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  caller.abort(new DOMException("dialog closed", "AbortError"));
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 100)),
  ]);
  assert.equal(outcome, "AbortError");
  assert.equal(bodyCancelled, 1);
});

test("DeepSeek and remote fetch preserve a timeout that wins before a later caller abort", async () => {
  const [deepSeek, safeFetch] = await Promise.all([
    loadServerModule(
      "lib/server/deepseek.ts",
      (value) => value.replace("composeRequestSignal(callerSignal, 60_000)", "composeRequestSignal(callerSignal, 1)"),
    ),
    loadServerModule(
      "lib/server/safe-fetch.ts",
      (value) => value.replace("composeRequestSignal(options.signal, 20_000)", "composeRequestSignal(options.signal, 1)"),
    ),
  ]);
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      setTimeout(() => reject(options.signal.reason), 5);
    }, { once: true });
  });
  try {
    for (const operation of [
      (signal) => deepSeek.runDeepSeekJson({ system: "s", user: "u", promptVersion: "test" }, signal),
      (signal) => safeFetch.safeFetchText("https://example.com/slow", { signal }),
    ]) {
      const caller = new AbortController();
      const pending = operation(caller.signal);
      await new Promise((resolve) => setTimeout(resolve, 3));
      caller.abort(new DOMException("closed after timeout", "AbortError"));
      await assert.rejects(pending, (error) => error.status === 504);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
});

test("a late upstream response cannot turn a cancelled request back into success", async () => {
  const [deepSeek, safeFetch] = await Promise.all([
    loadServerModule("lib/server/deepseek.ts"),
    loadServerModule("lib/server/safe-fetch.ts"),
  ]);
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  let cancelledBodies = 0;
  globalThis.fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(new ReadableStream({
      cancel() { cancelledBodies += 1; },
    }), { status: 200, headers: { "content-type": "text/plain" } });
  };
  try {
    for (const operation of [
      (signal) => deepSeek.runDeepSeekJson({ system: "s", user: "u", promptVersion: "test" }, signal),
      (signal) => safeFetch.safeFetchText("https://example.com/late", { signal }),
    ]) {
      const caller = new AbortController();
      const pending = operation(caller.signal);
      await new Promise((resolve) => setTimeout(resolve, 1));
      caller.abort(new DOMException("panel closed", "AbortError"));
      await assert.rejects(
        pending,
        (error) => error.status === 499 && error.code === "REQUEST_CANCELLED",
      );
    }
    assert.equal(cancelledBodies, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
});

test("closing a request aborts an in-flight DeepSeek fetch without a repair retry", async () => {
  const deepSeek = await loadServerModule("lib/server/deepseek.ts");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const caller = new AbortController();
  const upstreamSignals = [];
  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = async (_url, options) => {
    upstreamSignals.push(options.signal);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  };
  try {
    const pending = deepSeek.runDeepSeekJson({ system: "s", user: "u", promptVersion: "test" }, caller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    caller.abort(new DOMException("panel closed", "AbortError"));
    await assert.rejects(pending, (error) => error.code === "REQUEST_CANCELLED" && error.status === 499);
    assert.equal(upstreamSignals.length, 1);
    assert.equal(upstreamSignals[0].aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
});

test("an already closed caller never starts DeepSeek or remote fetch", async () => {
  const [deepSeek, safeFetch] = await Promise.all([
    loadServerModule("lib/server/deepseek.ts"),
    loadServerModule("lib/server/safe-fetch.ts"),
  ]);
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const caller = new AbortController();
  caller.abort(new DOMException("already closed", "AbortError"));
  let calls = 0;
  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("must not run");
  };
  try {
    await assert.rejects(
      deepSeek.runDeepSeekJson({ system: "s", user: "u", promptVersion: "test" }, caller.signal),
      (error) => error.code === "REQUEST_CANCELLED",
    );
    await assert.rejects(
      safeFetch.safeFetchText("https://example.com/article", { signal: caller.signal }),
      (error) => error.code === "REQUEST_CANCELLED",
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
});

test("closing a remote text request aborts fetch and is not mislabeled as a timeout", async () => {
  const safeFetch = await loadServerModule("lib/server/safe-fetch.ts");
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  let upstreamSignal;
  globalThis.fetch = async (_url, options) => {
    upstreamSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  };
  try {
    const pending = safeFetch.safeFetchText("https://example.com/article", { signal: caller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    caller.abort(new DOMException("dialog closed", "AbortError"));
    await assert.rejects(pending, (error) => error.code === "REQUEST_CANCELLED" && error.status === 499);
    assert.equal(upstreamSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("closing while a remote response body is streaming remains a cancellation", async () => {
  const safeFetch = await loadServerModule("lib/server/safe-fetch.ts");
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  let bodyCancelled = 0;
  globalThis.fetch = async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      options.signal.addEventListener("abort", () => {
        controller.error(options.signal.reason);
      }, { once: true });
    },
    cancel() { bodyCancelled += 1; },
  }), { status: 200, headers: { "content-type": "text/plain" } });
  try {
    const pending = safeFetch.safeFetchText("https://example.com/slow-body", { signal: caller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    caller.abort(new DOMException("dialog closed", "AbortError"));
    await assert.rejects(
      pending,
      (error) => error.code === "REQUEST_CANCELLED" && error.status === 499,
    );
    assert.ok(bodyCancelled <= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("redirect and rejected upstream bodies are explicitly released", async () => {
  const [safeFetch, deepSeek] = await Promise.all([
    loadServerModule("lib/server/safe-fetch.ts"),
    loadServerModule("lib/server/deepseek.ts"),
  ]);
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let redirectsCancelled = 0;
  let rejectedCancelled = 0;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      return new Response(new ReadableStream({ cancel() { redirectsCancelled += 1; } }), {
        status: 302,
        headers: { location: "https://example.com/final" },
      });
    }
    return new Response("finished", { status: 200, headers: { "content-type": "text/plain" } });
  };
  try {
    const result = await safeFetch.safeFetchText("https://example.com/start");
    assert.equal(result.text, "finished");
    assert.equal(redirectsCancelled, 1);

    process.env.DEEPSEEK_API_KEY = "test-key";
    globalThis.fetch = async () => new Response(new ReadableStream({
      cancel() { rejectedCancelled += 1; },
    }), { status: 429 });
    await assert.rejects(
      deepSeek.runDeepSeekJson({ system: "s", user: "u", promptVersion: "test" }),
      (error) => error.code === "AI_RATE_LIMITED",
    );
    assert.equal(rejectedCancelled, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
});

test("a broken remote response body becomes a stable 502 and releases its reader", async () => {
  const safeFetch = await loadServerModule("lib/server/safe-fetch.ts");
  const originalFetch = globalThis.fetch;
  let cancelled = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.error(new Error("socket reset")); },
    cancel() { cancelled += 1; },
  }), { status: 200, headers: { "content-type": "text/plain" } });
  try {
    await assert.rejects(
      safeFetch.safeFetchText("https://example.com/broken"),
      (error) => error.code === "REMOTE_BODY_FAILED" && error.status === 502,
    );
    assert.ok(cancelled <= 1, "a stream that already errored may reject cancellation, but must not loop");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AI, remote text, transcription, and media routes forward the incoming request signal", async () => {
  const [deepSeek, safeFetch, vocab, career, fitness, article, rss, job, transcribe, media] = await Promise.all([
    source("lib/server/deepseek.ts"),
    source("lib/server/safe-fetch.ts"),
    source("app/api/ai/vocab/route.ts"),
    source("app/api/ai/career/route.ts"),
    source("app/api/ai/fitness/route.ts"),
    source("app/api/import/article/route.ts"),
    source("app/api/import/rss/route.ts"),
    source("app/api/import/job/route.ts"),
    source("app/api/transcribe/route.ts"),
    source("app/api/media/route.ts"),
  ]);

  assert.match(deepSeek, /requestCompletion\(prompt, undefined, callerSignal\)/);
  assert.match(deepSeek, /signal:\s*requestSignal\.signal/);
  assert.match(safeFetch, /signal:\s*requestSignal\.signal/);
  for (const route of [vocab, career, fitness, article, rss, job]) {
    assert.match(route, /request\.signal/);
  }
  assert.match(transcribe, /composeRequestSignal\(request\.signal/);
  assert.match(transcribe, /signal:\s*upstreamSignal\.signal/);
  assert.ok(
    transcribe.indexOf("await response.json()") < transcribe.indexOf("upstreamSignal.dispose()"),
    "transcription cancellation must stay attached until the upstream body is consumed",
  );
  assert.match(media, /request\.signal\.addEventListener\("abort", abortFromCaller/);
  assert.match(media, /signal:\s*controller\.signal/);
  assert.match(media, /await upstream\.body\?\.cancel\(\)/);
  assert.ok(
    transcribe.indexOf("if (request.signal.aborted)") < transcribe.indexOf("await readAbortableFormData(request)"),
    "an already cancelled transcription must not parse a large multipart body",
  );
});
