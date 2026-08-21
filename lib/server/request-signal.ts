export type ComposedRequestSignal = Readonly<{
  signal: AbortSignal;
  cause: () => "caller" | "timeout" | null;
  timedOut: () => boolean;
  dispose: () => void;
}>;

export function composeRequestSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): ComposedRequestSignal {
  const controller = new AbortController();
  let firstCause: "caller" | "timeout" | null = null;

  const abortFromCaller = () => {
    if (firstCause !== null) return;
    firstCause = "caller";
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });

  const timeout = setTimeout(() => {
    if (firstCause !== null) return;
    firstCause = "timeout";
    controller.abort(new DOMException("request timeout", "TimeoutError"));
  }, timeoutMs);

  return Object.freeze({
    signal: controller.signal,
    cause: () => firstCause,
    timedOut: () => firstCause === "timeout",
    dispose: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    },
  });
}

export function isAbortLike(error: unknown): boolean {
  return error instanceof DOMException && (
    error.name === "AbortError" || error.name === "TimeoutError"
  );
}

export async function readAbortableFormData(request: Request): Promise<FormData> {
  if (request.signal.aborted) {
    throw request.signal.reason ?? new DOMException("request cancelled", "AbortError");
  }
  if (!request.body) return request.formData();

  const contentType = request.headers.get("content-type");
  const reader = request.body.getReader();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let stopped = false;
  const abortFromCaller = () => {
    if (stopped) return;
    stopped = true;
    const reason = request.signal.reason ?? new DOMException("request cancelled", "AbortError");
    streamController?.error(reason);
    void reader.cancel(reason).catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      request.signal.addEventListener("abort", abortFromCaller, { once: true });
      if (request.signal.aborted) abortFromCaller();
    },
    async pull(controller) {
      if (stopped) return;
      try {
        const { done, value } = await reader.read();
        if (stopped) return;
        if (done) {
          stopped = true;
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        if (stopped) return;
        stopped = true;
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (stopped) return;
      stopped = true;
      await reader.cancel(reason).catch(() => undefined);
    },
  });

  try {
    return await new Response(body, {
      headers: contentType ? { "content-type": contentType } : undefined,
    }).formData();
  } finally {
    request.signal.removeEventListener("abort", abortFromCaller);
    if (!stopped) {
      stopped = true;
      await reader.cancel("form data parsing finished").catch(() => undefined);
    }
    reader.releaseLock();
  }
}
