const FITNESS_LOCK_NAME = "private-ai-suite:fitness:database";
const FITNESS_CHANNEL_NAME = "private-ai-suite:fitness:changes";

export type FitnessChangeMessage = Readonly<{
  type: "fitness-changed";
  reason: string;
  senderId: string;
  changedAt: number;
}>;

type BrowserLockManager = Readonly<{
  request<Result>(
    name: string,
    options: Readonly<{ mode: "shared" | "exclusive" }>,
    callback: () => Promise<Result>,
  ): Promise<Result>;
}>;

const senderId = globalThis.crypto?.randomUUID?.() ??
  `fitness-${Math.random().toString(36).slice(2)}`;
let fallbackTail: Promise<void> = Promise.resolve();
let changeChannel: BroadcastChannel | null | undefined;

function browserLockManager(): BrowserLockManager | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as Navigator & { locks?: BrowserLockManager }).locks ?? null;
}

async function withFallbackLock<Result>(operation: () => Promise<Result>) {
  const previous = fallbackTail;
  let release: (() => void) | undefined;
  fallbackTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
  }
}

function withFitnessLock<Result>(
  mode: "shared" | "exclusive",
  operation: () => Promise<Result>,
): Promise<Result> {
  const locks = browserLockManager();
  if (!locks) return withFallbackLock(operation);
  return locks.request(FITNESS_LOCK_NAME, { mode }, operation);
}

function channel(): BroadcastChannel | null {
  if (changeChannel !== undefined) return changeChannel;
  changeChannel = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(FITNESS_CHANNEL_NAME)
    : null;
  return changeChannel;
}

function isFitnessChangeMessage(value: unknown): value is FitnessChangeMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<FitnessChangeMessage>;
  return message.type === "fitness-changed" &&
    typeof message.reason === "string" &&
    typeof message.senderId === "string" &&
    typeof message.changedAt === "number" &&
    Number.isFinite(message.changedAt);
}

export function withFitnessReadLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  return withFitnessLock("shared", operation);
}

export function withFitnessWriteLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  return withFitnessLock("exclusive", operation);
}

export function requireFitnessWebLocks(): void {
  if (!browserLockManager()) {
    throw new Error("当前浏览器不支持安全的跨标签页备份锁，请使用最新版 Chrome、Edge 或 Safari。");
  }
}

export function broadcastFitnessChange(reason: string): void {
  channel()?.postMessage({
    type: "fitness-changed",
    reason: reason.slice(0, 80),
    senderId,
    changedAt: Date.now(),
  } satisfies FitnessChangeMessage);
}

export function subscribeFitnessChanges(
  listener: (message: FitnessChangeMessage) => void,
): () => void {
  const current = channel();
  if (!current) return () => undefined;
  const receive = (event: MessageEvent<unknown>) => {
    if (!isFitnessChangeMessage(event.data) || event.data.senderId === senderId) return;
    listener(event.data);
  };
  current.addEventListener("message", receive);
  return () => current.removeEventListener("message", receive);
}
