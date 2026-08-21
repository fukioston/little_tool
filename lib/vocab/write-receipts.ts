import {
  assertLocalFileKeyAvailable,
  deleteOwnedLocalFile,
  getLocalFile,
  LocalFileError,
  saveLocalFileAtKey,
  sha256Blob,
  type LocalFileResult,
  type SaveLocalFileOptions,
} from "@/lib/local-db/files";
import {
  inspectVocabImportWrite,
  isVocabImportWriteReceipt,
  matchesVocabPodcastWriteReceipt,
  prepareVocabPodcastWrite,
  savePodcast,
  type VocabImportWriteReceipt,
  type VocabWriteInspection,
} from "./store";
import type { ParsedPodcast } from "./types";

const FILE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER_PATTERN = /^[0-9a-f]{64}$/;

export type VocabPodcastAudioWriteReceipt = Readonly<{
  version: 1;
  kind: "podcast-audio";
  operationId: string;
  database: VocabImportWriteReceipt;
  fileKey: string;
  stagingOwner: string;
  byteSize: number;
  mimeType: string;
  fileSha256: string;
  createdAt: string;
}>;

export type VocabPodcastAudioFileInspection =
  | "exact_staged"
  | "absent"
  | "conflict"
  | "unknown";

export type VocabPodcastAudioWriteInspection = Readonly<{
  database: VocabWriteInspection;
  file: VocabPodcastAudioFileInspection;
}>;

export class VocabPodcastAudioConflictError extends Error {
  readonly code = "VOCAB_PODCAST_AUDIO_CONFLICT";

  constructor(
    message: string,
    readonly receipt: VocabPodcastAudioWriteReceipt,
  ) {
    super(message);
    this.name = "VocabPodcastAudioConflictError";
  }
}

export class VocabPodcastAudioUncertainError extends Error {
  readonly code = "VOCAB_PODCAST_AUDIO_UNCERTAIN";
  override readonly cause: unknown;

  constructor(
    message: string,
    readonly receipt: VocabPodcastAudioWriteReceipt,
    cause?: unknown,
  ) {
    super(message);
    this.name = "VocabPodcastAudioUncertainError";
    this.cause = cause;
  }
}

export class VocabPodcastAudioNotSavedError extends Error {
  readonly code = "VOCAB_PODCAST_AUDIO_NOT_SAVED";
  override readonly cause: unknown;

  constructor(
    message: string,
    readonly receipt: VocabPodcastAudioWriteReceipt,
    cause?: unknown,
  ) {
    super(message);
    this.name = "VocabPodcastAudioNotSavedError";
    this.cause = cause;
  }
}

export function isVocabPodcastAudioWriteReceipt(
  value: unknown,
): value is VocabPodcastAudioWriteReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<VocabPodcastAudioWriteReceipt>;
  return receipt.version === 1 &&
    receipt.kind === "podcast-audio" &&
    typeof receipt.operationId === "string" &&
    isVocabImportWriteReceipt(receipt.database) &&
    receipt.database.kind === "podcast" &&
    receipt.operationId === receipt.database.operationId &&
    typeof receipt.fileKey === "string" &&
    FILE_KEY_PATTERN.test(receipt.fileKey) &&
    typeof receipt.stagingOwner === "string" &&
    OWNER_PATTERN.test(receipt.stagingOwner) &&
    typeof receipt.byteSize === "number" &&
    Number.isSafeInteger(receipt.byteSize) &&
    receipt.byteSize >= 0 &&
    typeof receipt.mimeType === "string" &&
    receipt.mimeType.length > 0 &&
    receipt.mimeType.length <= 127 &&
    typeof receipt.fileSha256 === "string" &&
    OWNER_PATTERN.test(receipt.fileSha256) &&
    typeof receipt.createdAt === "string" &&
    Number.isFinite(Date.parse(receipt.createdAt));
}

function randomOwner(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function receiptMimeType(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9!#$&^_.+\-/]/g, "")
    .slice(0, 127);
  return sanitized.includes("/") ? sanitized : "audio/mpeg";
}

const blobDigestCache = new WeakMap<Blob, Promise<string>>();

function blobSha256(blob: Blob): Promise<string> {
  const cached = blobDigestCache.get(blob);
  if (cached) return cached;
  const digest = sha256Blob(blob);
  blobDigestCache.set(blob, digest);
  return digest;
}

function podcastWithReceiptAudio(
  podcast: ParsedPodcast,
  receipt: Pick<VocabPodcastAudioWriteReceipt, "fileKey">,
): ParsedPodcast {
  return { ...podcast, audioUrl: `local:${receipt.fileKey}` };
}

export async function prepareVocabPodcastAudioWrite(
  podcast: ParsedPodcast,
  method: string,
  file: File,
): Promise<VocabPodcastAudioWriteReceipt> {
  const fileKey = crypto.randomUUID().toLowerCase();
  const ready = { ...podcast, audioUrl: `local:${fileKey}` };
  const [database, fileSha256] = await Promise.all([
    prepareVocabPodcastWrite(ready, method),
    blobSha256(file),
  ]);
  return {
    version: 1,
    kind: "podcast-audio",
    operationId: database.operationId,
    database,
    fileKey,
    stagingOwner: randomOwner(),
    byteSize: file.size,
    mimeType: receiptMimeType(file.type),
    fileSha256,
    createdAt: new Date(database.createdAt).toISOString(),
  };
}

export type VocabPodcastAudioRuntime = Readonly<{
  assertFileKeyAvailable(
    namespace: "vocab",
    key: string,
  ): Promise<void>;
  saveFileAtKey(
    namespace: "vocab",
    key: string,
    blob: Blob,
    options: SaveLocalFileOptions,
    stagingOwner: string,
  ): Promise<unknown>;
  getFile(namespace: "vocab", key: string): Promise<LocalFileResult>;
  deleteOwnedFile(
    namespace: "vocab",
    key: string,
    stagingOwner: string,
  ): Promise<boolean>;
  matchesPodcast(
    podcast: ParsedPodcast,
    method: string,
    receipt: VocabImportWriteReceipt,
  ): Promise<boolean>;
  savePodcast(
    podcast: ParsedPodcast,
    method: string,
    receipt: VocabImportWriteReceipt,
  ): Promise<string>;
  inspectDatabase(receipt: VocabImportWriteReceipt): Promise<VocabWriteInspection>;
}>;

const defaultRuntime: VocabPodcastAudioRuntime = {
  assertFileKeyAvailable: assertLocalFileKeyAvailable,
  saveFileAtKey: saveLocalFileAtKey,
  getFile: getLocalFile,
  deleteOwnedFile: deleteOwnedLocalFile,
  matchesPodcast: matchesVocabPodcastWriteReceipt,
  savePodcast,
  inspectDatabase: inspectVocabImportWrite,
};

type BrowserLockManager = Readonly<{
  request<Result>(
    name: string,
    options: Readonly<{ mode: "exclusive" }>,
    callback: () => Promise<Result>,
  ): Promise<Result>;
}>;

const audioOperationFallbackTails = new Map<string, Promise<void>>();

function withAudioOperationLock<Result>(
  operationId: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const name = `private-ai-suite:vocab:podcast-audio:${operationId}`;
  const locks = typeof navigator === "undefined"
    ? null
    : (navigator as unknown as { locks?: BrowserLockManager }).locks ?? null;
  if (locks) return locks.request(name, { mode: "exclusive" }, operation);

  const previous = audioOperationFallbackTails.get(name) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  audioOperationFallbackTails.set(name, settled);
  return result.finally(() => {
    if (audioOperationFallbackTails.get(name) === settled) {
      audioOperationFallbackTails.delete(name);
    }
  });
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof LocalFileError && error.code === "FILE_NOT_FOUND";
}

async function inspectFile(
  receipt: VocabPodcastAudioWriteReceipt,
  runtime: VocabPodcastAudioRuntime,
): Promise<VocabPodcastAudioFileInspection> {
  try {
    const stored = await runtime.getFile("vocab", receipt.fileKey);
    const metadata = stored.metadata;
    if (metadata.key === receipt.fileKey &&
        metadata.namespace === "vocab" &&
        metadata.stagingOwner === receipt.stagingOwner &&
        metadata.byteSize === receipt.byteSize &&
        metadata.mimeType === receipt.mimeType &&
        metadata.sha256 === receipt.fileSha256 &&
        metadata.category === "podcast-audio"
    ) {
      return await blobSha256(stored.file) === receipt.fileSha256
        ? "exact_staged"
        : "conflict";
    }
    return "conflict";
  } catch (error) {
    if (isMissingFileError(error)) return "absent";
    if (error instanceof LocalFileError) return "conflict";
    return "unknown";
  }
}

async function assertCommittedAudioFile(
  receipt: VocabPodcastAudioWriteReceipt,
  runtime: VocabPodcastAudioRuntime,
  cause?: unknown,
): Promise<void> {
  const file = await inspectFile(receipt, runtime);
  if (file === "exact_staged") return;
  if (file === "unknown") {
    throw new VocabPodcastAudioUncertainError(
      "资料库已经保存，但暂时无法复查本地音频；回执会继续保留。",
      receipt,
      cause,
    );
  }
  throw new VocabPodcastAudioConflictError(
    "资料库已经保存，但对应的本地音频不完整；不会删除或覆盖现有文件。",
    receipt,
  );
}

export async function inspectVocabPodcastAudioWrite(
  receipt: VocabPodcastAudioWriteReceipt,
  runtime: VocabPodcastAudioRuntime = defaultRuntime,
): Promise<VocabPodcastAudioWriteInspection> {
  if (!isVocabPodcastAudioWriteReceipt(receipt)) {
    return { database: "conflict", file: "conflict" };
  }
  const [database, file] = await Promise.all([
    runtime.inspectDatabase(receipt.database).catch(() => "unknown" as const),
    inspectFile(receipt, runtime),
  ]);
  return { database, file };
}

export type SaveVocabPodcastWithAudioOptions = Readonly<{
  receipt?: VocabPodcastAudioWriteReceipt;
  onRecoveryPrepared?: (
    receipt: VocabPodcastAudioWriteReceipt,
  ) => void | Promise<void>;
  runtime?: VocabPodcastAudioRuntime;
}>;

async function saveVocabPodcastWithAudioUnlocked(
  podcast: ParsedPodcast,
  method: string,
  file: File,
  options: SaveVocabPodcastWithAudioOptions = {},
): Promise<{ itemId: string; receipt: VocabPodcastAudioWriteReceipt }> {
  const runtime = options.runtime ?? defaultRuntime;
  const receipt = options.receipt ??
    await prepareVocabPodcastAudioWrite(podcast, method, file);
  const ready = podcastWithReceiptAudio(podcast, receipt);
  if (
    !isVocabPodcastAudioWriteReceipt(receipt) ||
    file.size !== receipt.byteSize ||
    receiptMimeType(file.type) !== receipt.mimeType ||
    await blobSha256(file) !== receipt.fileSha256 ||
    !await runtime.matchesPodcast(ready, method, receipt.database)
  ) {
    throw new VocabPodcastAudioConflictError(
      "音频、字幕或写入回执不一致，未写入任何内容。",
      receipt,
    );
  }

  let inspection = await inspectVocabPodcastAudioWrite(receipt, runtime);
  if (inspection.database === "exact_saved") {
    if (inspection.file !== "exact_staged") {
      throw new VocabPodcastAudioConflictError(
        "资料库已保存，但对应的本地音频不完整；不会自动删除或覆盖。",
        receipt,
      );
    }
    return { itemId: receipt.database.itemId, receipt };
  }
  if (inspection.database === "conflict") {
    throw new VocabPodcastAudioConflictError(
      "数据库中的写入编号属于不同内容，未触碰本地音频。",
      receipt,
    );
  }
  if (inspection.database === "unknown") {
    throw new VocabPodcastAudioUncertainError(
      "暂时无法核对数据库；请先只读核对，不要重复导入。",
      receipt,
    );
  }

  if (inspection.file === "absent") {
    try {
      await runtime.assertFileKeyAvailable("vocab", receipt.fileKey);
    } catch {
      throw new VocabPodcastAudioConflictError(
        "预留的音频位置已被占用，未覆盖现有文件。",
        receipt,
      );
    }
    await options.onRecoveryPrepared?.(receipt);
    try {
      const name = typeof file.name === "string" && file.name.trim()
        ? file.name
        : "local-audio";
      await runtime.saveFileAtKey(
        "vocab",
        receipt.fileKey,
        file,
        {
          originalName: name,
          mimeType: receipt.mimeType,
          category: "podcast-audio",
          createdAt: receipt.createdAt,
          updatedAt: receipt.createdAt,
        },
        receipt.stagingOwner,
      );
      inspection = { database: "absent", file: "exact_staged" };
    } catch (cause) {
      const fileAfterFailure = await inspectFile(receipt, runtime);
      if (fileAfterFailure === "exact_staged") {
        inspection = { database: "absent", file: "exact_staged" };
      } else if (fileAfterFailure === "absent") {
        throw new VocabPodcastAudioNotSavedError(
          "音频没有写入本地文件区，资料库也没有新增内容。",
          receipt,
          cause,
        );
      } else {
        throw new VocabPodcastAudioUncertainError(
          "音频写入没有返回完整回执；数据库尚未写入，请先核对暂存文件。",
          receipt,
          cause,
        );
      }
    }
  } else if (inspection.file === "exact_staged") {
    await options.onRecoveryPrepared?.(receipt);
  } else if (inspection.file === "conflict") {
    throw new VocabPodcastAudioConflictError(
      "预留的音频位置不是这次操作的完整文件；请先核对再清理。",
      receipt,
    );
  } else {
    throw new VocabPodcastAudioUncertainError(
      "暂时无法核对本地音频；不会写数据库，也不会删除文件。",
      receipt,
    );
  }

  try {
    const itemId = await runtime.savePodcast(ready, method, receipt.database);
    await assertCommittedAudioFile(receipt, runtime);
    return { itemId, receipt };
  } catch (cause) {
    if (
      cause instanceof VocabPodcastAudioConflictError ||
      cause instanceof VocabPodcastAudioUncertainError
    ) throw cause;
    const database = await runtime.inspectDatabase(receipt.database)
      .catch(() => "unknown" as const);
    if (database === "exact_saved") {
      await assertCommittedAudioFile(receipt, runtime, cause);
      return { itemId: receipt.database.itemId, receipt };
    }
    if (database === "conflict") {
      throw new VocabPodcastAudioConflictError(
        "数据库结果与原回执不一致；本地音频已保留，未自动删除。",
        receipt,
      );
    }
    if (database === "unknown") {
      throw new VocabPodcastAudioUncertainError(
        "数据库没有返回完整回执；本地音频已保留，请先只读核对。",
        receipt,
        cause,
      );
    }
    try {
      await runtime.deleteOwnedFile(
        "vocab",
        receipt.fileKey,
        receipt.stagingOwner,
      );
    } catch (cleanupCause) {
      throw new VocabPodcastAudioUncertainError(
        "已确认数据库没有保存，但暂存音频的归属无法核实，已保留原文件。",
        receipt,
        cleanupCause,
      );
    }
    throw new VocabPodcastAudioNotSavedError(
      "已确认数据库没有保存；只清理了这次操作拥有的暂存音频。",
      receipt,
      cause,
    );
  }
}

export async function saveVocabPodcastWithAudio(
  podcast: ParsedPodcast,
  method: string,
  file: File,
  options: SaveVocabPodcastWithAudioOptions = {},
): Promise<{ itemId: string; receipt: VocabPodcastAudioWriteReceipt }> {
  const receipt = options.receipt ??
    await prepareVocabPodcastAudioWrite(podcast, method, file);
  return withAudioOperationLock(receipt.operationId, () =>
    saveVocabPodcastWithAudioUnlocked(
      podcast,
      method,
      file,
      { ...options, receipt },
    ));
}

async function cleanupVocabPodcastAudioWriteUnlocked(
  receipt: VocabPodcastAudioWriteReceipt,
  runtime: VocabPodcastAudioRuntime = defaultRuntime,
): Promise<"deleted" | "already_absent" | "blocked"> {
  if (!isVocabPodcastAudioWriteReceipt(receipt)) return "blocked";
  const database = await runtime.inspectDatabase(receipt.database)
    .catch(() => "unknown" as const);
  if (database !== "absent") return "blocked";
  const file = await inspectFile(receipt, runtime);
  if (file === "absent") return "already_absent";
  try {
    const deleted = await runtime.deleteOwnedFile(
      "vocab",
      receipt.fileKey,
      receipt.stagingOwner,
    );
    return deleted ? "deleted" : "already_absent";
  } catch {
    return "blocked";
  }
}

export async function cleanupVocabPodcastAudioWrite(
  receipt: VocabPodcastAudioWriteReceipt,
  runtime: VocabPodcastAudioRuntime = defaultRuntime,
): Promise<"deleted" | "already_absent" | "blocked"> {
  if (!isVocabPodcastAudioWriteReceipt(receipt)) return "blocked";
  return withAudioOperationLock(receipt.operationId, () =>
    cleanupVocabPodcastAudioWriteUnlocked(receipt, runtime));
}
