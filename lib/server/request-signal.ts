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

export class RequestBodyTooLargeError extends Error {
  readonly name = "RequestBodyTooLargeError";

  constructor(public readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
  }
}

export async function readBoundedAbortableFormData(
  request: Request,
  maxBytes: number,
): Promise<FormData> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }
  if (request.signal.aborted) {
    throw request.signal.reason ?? new DOMException("request cancelled", "AbortError");
  }
  if (!request.body) return request.formData();

  const contentType = request.headers.get("content-type");
  const declaredText = request.headers.get("content-length")?.trim() ?? "";
  const declared = /^\d+$/.test(declaredText) ? Number(declaredText) : 0;
  if (Number.isSafeInteger(declared) && declared > maxBytes) {
    const reader = request.body.getReader();
    try {
      await reader.cancel(new RequestBodyTooLargeError(maxBytes)).catch(() => undefined);
    } finally {
      reader.releaseLock();
    }
    throw new RequestBodyTooLargeError(maxBytes);
  }
  const reader = request.body.getReader();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let stopped = false;
  let total = 0;
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
        if (value.byteLength > maxBytes - total) {
          stopped = true;
          const error = new RequestBodyTooLargeError(maxBytes);
          controller.error(error);
          await reader.cancel(error).catch(() => undefined);
          return;
        }
        total += value.byteLength;
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

export function readAbortableFormData(request: Request): Promise<FormData> {
  return readBoundedAbortableFormData(request, Number.MAX_SAFE_INTEGER);
}
