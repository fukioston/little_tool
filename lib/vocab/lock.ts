const VOCAB_LOCK_NAME = "private-ai-suite:vocab:database";
const VOCAB_CHANNEL_NAME = "private-ai-suite:vocab:changes";

export type VocabChangeMessage = Readonly<{
  type: "vocab-changed";
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
  `vocab-${Math.random().toString(36).slice(2)}`;
let fallbackTail: Promise<void> = Promise.resolve();
let changeChannel: BroadcastChannel | null | undefined;

function browserLockManager(): BrowserLockManager | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as Navigator & { locks?: BrowserLockManager }).locks;
  return locks ?? null;
}

async function withFallbackLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
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

function withVocabLock<Result>(
  mode: "shared" | "exclusive",
  operation: () => Promise<Result>,
): Promise<Result> {
  const locks = browserLockManager();
  if (!locks) return withFallbackLock(operation);
  return locks.request(VOCAB_LOCK_NAME, { mode }, operation);
}

function getChangeChannel(): BroadcastChannel | null {
  if (changeChannel !== undefined) return changeChannel;
  changeChannel = typeof window !== "undefined" &&
    typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(VOCAB_CHANNEL_NAME)
    : null;
  return changeChannel;
}

function isVocabChangeMessage(value: unknown): value is VocabChangeMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<VocabChangeMessage>;
  return message.type === "vocab-changed" &&
    typeof message.reason === "string" &&
    typeof message.senderId === "string" &&
    typeof message.changedAt === "number" &&
    Number.isFinite(message.changedAt);
}

export function withVocabReadLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  return withVocabLock("shared", operation);
}

export function withVocabWriteLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  return withVocabLock("exclusive", operation);
}

export function broadcastVocabChange(reason: string): void {
  getChangeChannel()?.postMessage({
    type: "vocab-changed",
    reason: reason.slice(0, 80),
    senderId,
    changedAt: Date.now(),
  } satisfies VocabChangeMessage);
}

export function subscribeVocabChanges(
  listener: (message: VocabChangeMessage) => void,
): () => void {
  const channel = getChangeChannel();
  if (!channel) return () => undefined;
  const receive = (event: MessageEvent<unknown>) => {
    if (!isVocabChangeMessage(event.data) || event.data.senderId === senderId) return;
    listener(event.data);
  };
  channel.addEventListener("message", receive);
  return () => channel.removeEventListener("message", receive);
}
