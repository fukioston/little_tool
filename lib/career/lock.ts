const CAREER_LOCK_NAME = "private-ai-suite:career-storage";
const CAREER_CHANNEL_NAME = "private-ai-suite:career-storage-events";
const CAREER_LOCK_TOKEN = Symbol("career-storage-lock");

export type CareerLockContext = Readonly<{
  token: symbol;
  mode: "shared" | "exclusive";
}>;

function isHeld(context: CareerLockContext | undefined) {
  return context?.token === CAREER_LOCK_TOKEN;
}

function lockManager(): LockManager | null {
  if (typeof navigator === "undefined" || !navigator.locks) return null;
  return navigator.locks;
}

async function withCareerLock<T>(
  mode: "shared" | "exclusive",
  task: (context: CareerLockContext) => Promise<T>,
  options: { context?: CareerLockContext; requireSupport?: boolean } = {},
): Promise<T> {
  if (isHeld(options.context)) return task(options.context!);
  const manager = lockManager();
  if (!manager) {
    if (options.requireSupport) {
      throw new Error("当前浏览器不支持安全的跨标签页备份锁，请使用最新版 Chrome、Edge 或 Safari");
    }
    return task({ token: CAREER_LOCK_TOKEN, mode });
  }
  return manager.request(CAREER_LOCK_NAME, { mode }, async () =>
    task({ token: CAREER_LOCK_TOKEN, mode }));
}

export function withCareerReadLock<T>(
  task: (context: CareerLockContext) => Promise<T>,
  context?: CareerLockContext,
) {
  return withCareerLock("shared", task, { context });
}

export function withCareerWriteLock<T>(
  task: (context: CareerLockContext) => Promise<T>,
  context?: CareerLockContext,
) {
  return withCareerLock("exclusive", task, { context });
}

export function withCareerBackupLock<T>(task: (context: CareerLockContext) => Promise<T>) {
  return withCareerLock("exclusive", task, { requireSupport: true });
}

export function broadcastCareerGenerationChanged(generationId: string) {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CAREER_CHANNEL_NAME);
  channel.postMessage({ type: "generation-changed", generationId });
  channel.close();
}

/**
 * Advisory refresh hint for ordinary row writes. Its fixed event type cannot
 * be mistaken for a database-generation activation.
 */
export function broadcastCareerDataChanged(reason: string) {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CAREER_CHANNEL_NAME);
  try {
    channel.postMessage({ type: "data-changed", reason });
  } finally {
    channel.close();
  }
}

export function subscribeToCareerGenerationChanges(onChange: () => void) {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(CAREER_CHANNEL_NAME);
  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (
      event.data &&
      typeof event.data === "object" &&
      "type" in event.data &&
      event.data.type === "generation-changed"
    ) {
      onChange();
    }
  });
  return () => channel.close();
}

export function subscribeToCareerDataChanges(
  onChange: (reason: string) => void,
) {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(CAREER_CHANNEL_NAME);
  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (
      event.data &&
      typeof event.data === "object" &&
      "type" in event.data &&
      event.data.type === "data-changed" &&
      "reason" in event.data &&
      typeof event.data.reason === "string"
    ) {
      onChange(event.data.reason);
    }
  });
  return () => channel.close();
}
