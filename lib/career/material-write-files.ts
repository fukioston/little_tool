import {
  abandonClaimedLocalFileDeletion,
  assertLocalFileKeyAvailable,
  claimLocalFileDeletion,
  deleteLocalFile,
  deleteOwnedLocalFile,
  getLocalFile,
  inspectClaimedLocalFileDeletion,
  inspectLocalFileDeletionCandidate,
  inspectOwnedLocalFileFragments,
  releaseClaimedLocalFileDeletion,
  saveLocalFileAtKey,
  sha256Blob,
  sweepClaimedLocalFileDeletion,
  type ClaimedLocalFileDeletionInspection,
  type LocalFileMetadata,
  type LocalFileDeletionCandidateInspection,
  type LocalFileResult,
  type OwnedLocalFileFragmentInspection,
  type SaveLocalFileOptions,
} from "@/lib/local-db/files";
import {
  exactKeys,
  hashCareerWriteValue,
  isCareerWriteGeneration,
  isCareerWriteOperationId,
  type CareerWriteGenerationExpectation,
} from "./write-marker";

const DATABASE = "career" as const;
const PURPOSE = "career-material-file-cleanup" as const;
const DELETE_PURPOSE = "career-material-delete-file" as const;
const VERSION = 1 as const;
const CAPABILITY_DIRECTORY = "private-ai-suite-career-capabilities";
const CAPABILITY_RECORD_MAX_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[0-9a-f]{64}$/;

export type CareerMaterialWriteFileRuntime = Readonly<{
  assertFileKeyAvailable(key: string): Promise<void>;
  saveFileAtKey(
    key: string,
    blob: Blob,
    options: SaveLocalFileOptions,
    stagingOwner: string,
  ): Promise<LocalFileMetadata>;
  getFile(key: string): Promise<LocalFileResult>;
  inspectDeletionCandidate(
    key: string,
    expected: LocalFileMetadata | null,
  ): Promise<LocalFileDeletionCandidateInspection>;
  inspectOwnedFragments(key: string, stagingOwner: string): Promise<OwnedLocalFileFragmentInspection>;
  deleteOwnedFile(key: string, stagingOwner: string): Promise<boolean>;
  deleteFile(key: string): Promise<boolean>;
  claimFileDeletion(key: string, expected: LocalFileMetadata | null, deletionOwner: string): Promise<void>;
  inspectClaimedDeletion(
    key: string,
    expected: LocalFileMetadata | null,
    deletionOwner: string,
  ): Promise<ClaimedLocalFileDeletionInspection>;
  sweepClaimedDeletion(key: string, expected: LocalFileMetadata | null, deletionOwner: string): Promise<boolean>;
  releaseClaimedDeletion(key: string, expected: LocalFileMetadata | null, deletionOwner: string): Promise<boolean>;
  abandonClaimedDeletion(key: string, expected: LocalFileMetadata | null, deletionOwner: string): Promise<boolean>;
  hashBlob(blob: Blob): Promise<string>;
  storeCapabilityRecord(handle: string, serialized: string): Promise<void>;
  replaceCapabilityRecord(handle: string, expectedSerialized: string, serialized: string): Promise<void>;
  readCapabilityRecord(handle: string): Promise<string | null>;
  deleteCapabilityRecord(handle: string): Promise<boolean>;
}>;

function browserStorage(): StorageManager {
  if (typeof navigator === "undefined" || !navigator.storage ||
    typeof navigator.storage.getDirectory !== "function") {
    throw new Error("OPFS capability storage unavailable");
  }
  return navigator.storage;
}

async function capabilityDirectory(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const root = await browserStorage().getDirectory();
  try {
    return await root.getDirectoryHandle(CAPABILITY_DIRECTORY, { create });
  } catch (error) {
    if (!create && error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

async function storeCapabilityRecord(handle: string, serialized: string): Promise<void> {
  if (!UUID_PATTERN.test(handle) || new TextEncoder().encode(serialized).byteLength > CAPABILITY_RECORD_MAX_BYTES) {
    throw new Error("invalid capability record");
  }
  const directory = await capabilityDirectory(true);
  if (!directory) throw new Error("capability directory unavailable");
  try {
    await directory.getFileHandle(`${handle}.json`);
    throw new Error("capability handle collision");
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
  const filename = `${handle}.json`;
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable({ keepExistingData: false });
  try {
    await writable.write(new TextEncoder().encode(serialized));
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    // This handle was proven absent under the enclosing Career storage lock.
    // Preserve an exact response-loss write; otherwise remove the incomplete
    // private record so a handle that was never returned cannot be orphaned.
    const recovered = await readCapabilityRecord(handle).catch(() => null);
    if (recovered === serialized) return;
    await deleteCapabilityRecord(handle);
    throw error;
  }
}

async function readCapabilityRecord(handle: string): Promise<string | null> {
  if (!UUID_PATTERN.test(handle)) throw new Error("invalid capability handle");
  const directory = await capabilityDirectory(false);
  if (!directory) return null;
  try {
    const file = await (await directory.getFileHandle(`${handle}.json`)).getFile();
    if (file.size > CAPABILITY_RECORD_MAX_BYTES) throw new Error("capability record too large");
    return file.text();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

async function replaceCapabilityRecord(
  handle: string,
  expectedSerialized: string,
  serialized: string,
): Promise<void> {
  if (!UUID_PATTERN.test(handle) ||
    new TextEncoder().encode(expectedSerialized).byteLength > CAPABILITY_RECORD_MAX_BYTES ||
    new TextEncoder().encode(serialized).byteLength > CAPABILITY_RECORD_MAX_BYTES) {
    throw new Error("invalid capability record");
  }
  const current = await readCapabilityRecord(handle);
  if (current !== expectedSerialized) throw new Error("capability record changed");
  const directory = await capabilityDirectory(false);
  if (!directory) throw new Error("capability directory unavailable");
  const file = await directory.getFileHandle(`${handle}.json`);
  const writable = await file.createWritable({ keepExistingData: false });
  try {
    await writable.write(new TextEncoder().encode(serialized));
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

async function deleteCapabilityRecord(handle: string): Promise<boolean> {
  if (!UUID_PATTERN.test(handle)) throw new Error("invalid capability handle");
  const directory = await capabilityDirectory(false);
  if (!directory) return false;
  try {
    await directory.removeEntry(`${handle}.json`);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return false;
    try {
      await directory.getFileHandle(`${handle}.json`);
    } catch (inspectionError) {
      if (inspectionError instanceof DOMException && inspectionError.name === "NotFoundError") return true;
    }
    throw error;
  }
  try {
    await directory.getFileHandle(`${handle}.json`);
    throw new Error("capability deletion uncertain");
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return true;
    throw error;
  }
}

export const defaultCareerMaterialWriteFileRuntime: CareerMaterialWriteFileRuntime = {
  assertFileKeyAvailable: (key) => assertLocalFileKeyAvailable(DATABASE, key),
  saveFileAtKey: (key, blob, options, stagingOwner) =>
    saveLocalFileAtKey(DATABASE, key, blob, options, stagingOwner),
  getFile: (key) => getLocalFile(DATABASE, key),
  inspectDeletionCandidate: (key, expected) =>
    inspectLocalFileDeletionCandidate(DATABASE, key, expected),
  inspectOwnedFragments: (key, stagingOwner) =>
    inspectOwnedLocalFileFragments(DATABASE, key, stagingOwner),
  deleteOwnedFile: (key, stagingOwner) => deleteOwnedLocalFile(DATABASE, key, stagingOwner),
  deleteFile: (key) => deleteLocalFile(DATABASE, key),
  claimFileDeletion: (key, expected, deletionOwner) =>
    claimLocalFileDeletion(DATABASE, key, expected, deletionOwner),
  inspectClaimedDeletion: (key, expected, deletionOwner) =>
    inspectClaimedLocalFileDeletion(DATABASE, key, expected, deletionOwner),
  sweepClaimedDeletion: (key, expected, deletionOwner) =>
    sweepClaimedLocalFileDeletion(DATABASE, key, expected, deletionOwner),
  releaseClaimedDeletion: (key, expected, deletionOwner) =>
    releaseClaimedLocalFileDeletion(DATABASE, key, expected, deletionOwner),
  abandonClaimedDeletion: (key, expected, deletionOwner) =>
    abandonClaimedLocalFileDeletion(DATABASE, key, expected, deletionOwner),
  hashBlob: sha256Blob,
  storeCapabilityRecord,
  replaceCapabilityRecord,
  readCapabilityRecord,
  deleteCapabilityRecord,
};

export type CareerMaterialStagedFile = LocalFileMetadata & Readonly<{
  stagingOwner: string;
}>;

export type CareerMaterialFileCleanupReceipt = Readonly<{
  purpose: typeof PURPOSE;
  version: typeof VERSION;
  handle: string;
}>;

export type CareerMaterialFileCleanupPayload = CareerWriteGenerationExpectation & Readonly<{
  operationId: string;
  materialId: string;
  stagedFile: CareerMaterialStagedFile;
}>;

export type CareerMaterialDeleteFileReceipt = Readonly<{
  purpose: typeof DELETE_PURPOSE;
  version: typeof VERSION;
  handle: string;
}>;

export type CareerMaterialDeleteFilePayload = CareerWriteGenerationExpectation & Readonly<{
  operationId: string;
  materialId: string;
  fileKey: string;
  expectedFile: Readonly<LocalFileMetadata> | null;
  deletionOwner: string | null;
}>;

type CareerMaterialCapabilityPayload =
  | CareerMaterialFileCleanupPayload
  | CareerMaterialDeleteFilePayload;

export type CareerMaterialCapabilityBinding = CareerWriteGenerationExpectation & Readonly<{
  operationId: string;
  materialId: string;
}>;

type CareerMaterialActiveCapabilityRecord = Readonly<{
  version: typeof VERSION;
  purpose: typeof PURPOSE | typeof DELETE_PURPOSE;
  handle: string;
  state: "active";
  payload: CareerMaterialCapabilityPayload;
  payloadSha256: string;
}>;

type CareerMaterialCompletedCapabilityRecord = Readonly<{
  version: typeof VERSION;
  purpose: typeof PURPOSE | typeof DELETE_PURPOSE;
  handle: string;
  state: "completed";
  binding: CareerMaterialCapabilityBinding;
  completionSha256: string;
}>;

type CareerMaterialCapabilityRecord =
  | CareerMaterialActiveCapabilityRecord
  | CareerMaterialCompletedCapabilityRecord;

export class CareerMaterialCapabilityPersistenceUnknownError extends Error {
  readonly capabilityReceipt: CareerMaterialFileCleanupReceipt | CareerMaterialDeleteFileReceipt;

  constructor(record: CareerMaterialActiveCapabilityRecord) {
    super("material capability persistence is uncertain");
    this.name = "CareerMaterialCapabilityPersistenceUnknownError";
    this.capabilityReceipt = {
      purpose: record.purpose,
      version: VERSION,
      handle: record.handle,
    } as CareerMaterialFileCleanupReceipt | CareerMaterialDeleteFileReceipt;
  }
}

export type CareerMaterialCapabilityResolution<
  Receipt extends CareerMaterialFileCleanupReceipt | CareerMaterialDeleteFileReceipt,
  Payload extends CareerMaterialCapabilityPayload,
> =
  | Readonly<{ state: "active"; receipt: Receipt; payload: Payload; serialized: string }>
  | Readonly<{ state: "completed"; receipt: Receipt; binding: CareerMaterialCapabilityBinding }>
  | Readonly<{ state: "missing" | "malformed" | "unknown"; receipt: Receipt }>;

function normalizeStagedFile(value: unknown): CareerMaterialStagedFile {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [
    "version", "key", "namespace", "originalName", "mimeType", "category",
    "byteSize", "sha256", "createdAt", "updatedAt", "stagingOwner",
  ])) throw new Error("invalid staged file");
  const file = value as CareerMaterialStagedFile;
  if (file.version !== 1 || !UUID_PATTERN.test(file.key) || file.namespace !== DATABASE ||
    typeof file.originalName !== "string" || typeof file.mimeType !== "string" ||
    !(file.category === null || typeof file.category === "string") ||
    !Number.isSafeInteger(file.byteSize) || file.byteSize < 0 ||
    !SHA_PATTERN.test(file.sha256) || typeof file.createdAt !== "string" ||
    typeof file.updatedAt !== "string" || !SHA_PATTERN.test(file.stagingOwner)) {
    throw new Error("invalid staged file fields");
  }
  return { ...file, sha256: file.sha256.toLowerCase(), stagingOwner: file.stagingOwner.toLowerCase() };
}

function normalizePayload(value: unknown): CareerMaterialFileCleanupPayload {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [
    "generationId", "generationSequence", "operationId", "materialId", "stagedFile",
  ])) throw new Error("invalid payload");
  const payload = value as CareerMaterialFileCleanupPayload;
  if (!isCareerWriteGeneration({
    generationId: payload.generationId,
    generationSequence: payload.generationSequence,
  }) || !isCareerWriteOperationId(payload.operationId, "career-material-write") ||
    typeof payload.materialId !== "string" || !payload.materialId.trim() || payload.materialId.length > 240) {
    throw new Error("invalid payload fields");
  }
  return { ...payload, stagedFile: normalizeStagedFile(payload.stagedFile) };
}

function normalizeDeletePayload(value: unknown): CareerMaterialDeleteFilePayload {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [
    "generationId", "generationSequence", "operationId", "materialId", "fileKey", "expectedFile",
    "deletionOwner",
  ])) throw new Error("invalid delete payload");
  const payload = value as CareerMaterialDeleteFilePayload;
  if (!isCareerWriteGeneration({
    generationId: payload.generationId,
    generationSequence: payload.generationSequence,
  }) || !isCareerWriteOperationId(payload.operationId, "career-material-write") ||
    typeof payload.materialId !== "string" || !payload.materialId.trim() || payload.materialId.length > 240 ||
    !UUID_PATTERN.test(payload.fileKey) ||
    !(payload.deletionOwner === null || SHA_PATTERN.test(payload.deletionOwner))) {
    throw new Error("invalid delete payload fields");
  }
  if (payload.expectedFile !== null) {
    const file = payload.expectedFile;
    if (!file || typeof file !== "object" || Array.isArray(file) ||
      !(exactKeys(file, [
        "version", "key", "namespace", "originalName", "mimeType", "category",
        "byteSize", "sha256", "createdAt", "updatedAt",
      ]) || exactKeys(file, [
        "version", "key", "namespace", "originalName", "mimeType", "category",
        "byteSize", "sha256", "createdAt", "updatedAt", "stagingOwner",
      ])) || file.version !== 1 || file.key !== payload.fileKey || file.namespace !== DATABASE ||
      typeof file.originalName !== "string" || typeof file.mimeType !== "string" ||
      !(file.category === null || typeof file.category === "string") ||
      !Number.isSafeInteger(file.byteSize) || file.byteSize < 0 || !SHA_PATTERN.test(file.sha256) ||
      typeof file.createdAt !== "string" || typeof file.updatedAt !== "string" ||
      !(file.stagingOwner === undefined || SHA_PATTERN.test(file.stagingOwner))) {
      throw new Error("invalid expected delete file");
    }
  }
  if (payload.expectedFile?.stagingOwner !== undefined && payload.deletionOwner !== null) {
    throw new Error("owned staging files do not use ordinary deletion claims");
  }
  if ((payload.expectedFile === null || payload.expectedFile.stagingOwner === undefined) &&
    payload.deletionOwner === null) {
    throw new Error("ordinary or missing files require a deletion claim owner");
  }
  return {
    ...payload,
    deletionOwner: payload.deletionOwner?.toLowerCase() ?? null,
    expectedFile: payload.expectedFile ? { ...payload.expectedFile } : null,
  };
}

export async function careerMaterialStagingOwner(operationId: string): Promise<string> {
  return hashCareerWriteValue({ purpose: PURPOSE, operationId });
}

export async function careerMaterialDeletionOwner(
  generation: CareerWriteGenerationExpectation,
  operationId: string,
  materialId: string,
  fileKey: string,
): Promise<string> {
  return hashCareerWriteValue({
    purpose: "career-material-file-deletion-claim",
    ...generation,
    operationId,
    materialId,
    fileKey,
  });
}

function publicCapability(
  value: unknown,
  purpose: typeof PURPOSE | typeof DELETE_PURPOSE,
): Readonly<{ purpose: typeof PURPOSE | typeof DELETE_PURPOSE; version: typeof VERSION; handle: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !exactKeys(value, ["purpose", "version", "handle"])) {
    throw new Error("invalid material capability");
  }
  const receipt = value as CareerMaterialFileCleanupReceipt | CareerMaterialDeleteFileReceipt;
  if (receipt.purpose !== purpose || receipt.version !== VERSION || !UUID_PATTERN.test(receipt.handle)) {
    throw new Error("invalid material capability");
  }
  return { purpose, version: VERSION, handle: receipt.handle.toLowerCase() };
}

export function isCareerMaterialFileCleanupReceipt(
  value: unknown,
): value is CareerMaterialFileCleanupReceipt {
  try { publicCapability(value, PURPOSE); return true; }
  catch { return false; }
}

export function isCareerMaterialDeleteFileReceipt(
  value: unknown,
): value is CareerMaterialDeleteFileReceipt {
  try { publicCapability(value, DELETE_PURPOSE); return true; }
  catch { return false; }
}

export function createCareerMaterialFileCleanupReceipt(
  handle: string,
): CareerMaterialFileCleanupReceipt {
  return publicCapability({ purpose: PURPOSE, version: VERSION, handle }, PURPOSE) as
    CareerMaterialFileCleanupReceipt;
}

export function createCareerMaterialDeleteFileReceipt(
  handle: string,
): CareerMaterialDeleteFileReceipt {
  return publicCapability({ purpose: DELETE_PURPOSE, version: VERSION, handle }, DELETE_PURPOSE) as
    CareerMaterialDeleteFileReceipt;
}

function normalizeBinding(value: unknown): CareerMaterialCapabilityBinding {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, [
    "generationId", "generationSequence", "operationId", "materialId",
  ])) throw new Error("invalid capability binding");
  const binding = value as CareerMaterialCapabilityBinding;
  if (!isCareerWriteGeneration({
    generationId: binding.generationId,
    generationSequence: binding.generationSequence,
  }) ||
    !isCareerWriteOperationId(binding.operationId, "career-material-write") ||
    typeof binding.materialId !== "string" || !binding.materialId.trim() ||
    binding.materialId.length > 240) {
    throw new Error("invalid capability binding");
  }
  return { ...binding };
}

function bindingFromPayload(payload: CareerMaterialCapabilityPayload): CareerMaterialCapabilityBinding {
  return {
    generationId: payload.generationId,
    generationSequence: payload.generationSequence,
    operationId: payload.operationId,
    materialId: payload.materialId,
  };
}

export function sameCareerMaterialCapabilityBinding(
  left: CareerMaterialCapabilityBinding,
  right: CareerMaterialCapabilityBinding,
): boolean {
  return left.generationId === right.generationId &&
    left.generationSequence === right.generationSequence &&
    left.operationId === right.operationId && left.materialId === right.materialId;
}

async function capabilityRecord(
  purpose: typeof PURPOSE | typeof DELETE_PURPOSE,
  handle: string,
  payload: CareerMaterialCapabilityPayload,
): Promise<CareerMaterialActiveCapabilityRecord> {
  return {
    version: VERSION,
    purpose,
    handle,
    state: "active",
    payload,
    payloadSha256: await hashCareerWriteValue({
      version: VERSION, purpose, handle, state: "active", payload,
    }),
  };
}

async function completedCapabilityRecord(
  purpose: typeof PURPOSE | typeof DELETE_PURPOSE,
  handle: string,
  binding: CareerMaterialCapabilityBinding,
): Promise<CareerMaterialCompletedCapabilityRecord> {
  return {
    version: VERSION,
    purpose,
    handle,
    state: "completed",
    binding,
    completionSha256: await hashCareerWriteValue({
      version: VERSION, purpose, handle, state: "completed", binding,
    }),
  };
}

function serializeCapabilityRecord(record: CareerMaterialCapabilityRecord): string {
  const serialized = JSON.stringify(record);
  if (new TextEncoder().encode(serialized).byteLength > CAPABILITY_RECORD_MAX_BYTES) {
    throw new Error("capability record too large");
  }
  return serialized;
}

async function persistCapabilityRecord(
  record: CareerMaterialActiveCapabilityRecord,
  runtime: CareerMaterialWriteFileRuntime,
): Promise<void> {
  const serialized = serializeCapabilityRecord(record);
  let stored = false;
  try {
    await runtime.storeCapabilityRecord(record.handle, serialized);
    stored = true;
  } catch (error) {
    const recovered = await runtime.readCapabilityRecord(record.handle).catch(() => null);
    if (recovered !== serialized) throw error;
    stored = true;
  }
  let readback: string | null;
  try { readback = await runtime.readCapabilityRecord(record.handle); }
  catch (error) {
    if (!stored) throw error;
    // The store returned, so this random handle is ours. Remove it before
    // failing the prepare; if deletion cannot be confirmed, surface the opaque
    // handle as the only safe recovery authority rather than orphaning it.
    try {
      await runtime.deleteCapabilityRecord(record.handle);
      if (await runtime.readCapabilityRecord(record.handle) !== null) {
        throw new Error("capability cleanup was not confirmed");
      }
    } catch {
      throw new CareerMaterialCapabilityPersistenceUnknownError(record);
    }
    throw error;
  }
  if (readback !== serialized) {
    if (stored) {
      try {
        await runtime.deleteCapabilityRecord(record.handle);
        if (await runtime.readCapabilityRecord(record.handle) !== null) {
          throw new Error("capability cleanup was not confirmed");
        }
      } catch {
        throw new CareerMaterialCapabilityPersistenceUnknownError(record);
      }
    }
    throw new Error("capability record was not stored exactly");
  }
}

async function inspectCapabilityRecord(
  value: unknown,
  purpose: typeof PURPOSE | typeof DELETE_PURPOSE,
  runtime: CareerMaterialWriteFileRuntime,
): Promise<CareerMaterialCapabilityResolution<
  CareerMaterialFileCleanupReceipt | CareerMaterialDeleteFileReceipt,
  CareerMaterialCapabilityPayload
>> {
  const receipt = publicCapability(value, purpose);
  let serialized: string | null;
  try { serialized = await runtime.readCapabilityRecord(receipt.handle); }
  catch { return { state: "unknown", receipt }; }
  if (serialized === null) return { state: "missing", receipt };
  if (new TextEncoder().encode(serialized).byteLength > CAPABILITY_RECORD_MAX_BYTES) {
    return { state: "malformed", receipt };
  }
  let raw: unknown;
  try { raw = JSON.parse(serialized); }
  catch { return { state: "malformed", receipt }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { state: "malformed", receipt };
  }
  const record = raw as CareerMaterialCapabilityRecord;
  if (record.version !== VERSION || record.purpose !== purpose ||
    record.handle !== receipt.handle) {
    return { state: "malformed", receipt };
  }
  if (record.state === "completed") {
    if (!exactKeys(record, [
      "version", "purpose", "handle", "state", "binding", "completionSha256",
    ]) || !SHA_PATTERN.test(record.completionSha256)) {
      return { state: "malformed", receipt };
    }
    let binding: CareerMaterialCapabilityBinding;
    try { binding = normalizeBinding(record.binding); }
    catch { return { state: "malformed", receipt }; }
    try {
      if (await hashCareerWriteValue({
        version: record.version,
        purpose: record.purpose,
        handle: record.handle,
        state: record.state,
        binding,
      }) !== record.completionSha256) return { state: "malformed", receipt };
    } catch { return { state: "unknown", receipt }; }
    return { state: "completed", receipt, binding };
  }
  if (record.state !== "active" || !exactKeys(record, [
    "version", "purpose", "handle", "state", "payload", "payloadSha256",
  ]) || !SHA_PATTERN.test(record.payloadSha256)) {
    return { state: "malformed", receipt };
  }
  let payload: CareerMaterialCapabilityPayload;
  try {
    payload = purpose === PURPOSE
      ? normalizePayload(record.payload)
      : normalizeDeletePayload(record.payload);
  } catch { return { state: "malformed", receipt }; }
  try {
    if (await hashCareerWriteValue({
      version: record.version,
      purpose: record.purpose,
      handle: record.handle,
      state: record.state,
      payload,
    }) !== record.payloadSha256) return { state: "malformed", receipt };
    if (purpose === PURPOSE) {
      const cleanup = payload as CareerMaterialFileCleanupPayload;
      if (cleanup.stagedFile.stagingOwner !==
        await careerMaterialStagingOwner(cleanup.operationId)) {
        return { state: "malformed", receipt };
      }
    } else {
      const deletion = payload as CareerMaterialDeleteFilePayload;
      if (deletion.deletionOwner !== null && deletion.deletionOwner !==
        await careerMaterialDeletionOwner(
          {
            generationId: deletion.generationId,
            generationSequence: deletion.generationSequence,
          },
          deletion.operationId,
          deletion.materialId,
          deletion.fileKey,
        )) return { state: "malformed", receipt };
    }
  } catch { return { state: "unknown", receipt }; }
  return { state: "active", receipt, payload, serialized };
}

export async function issueCareerMaterialFileCleanupReceipt(
  payloadValue: CareerMaterialFileCleanupPayload,
  handleValue: string,
  runtime: CareerMaterialWriteFileRuntime = defaultCareerMaterialWriteFileRuntime,
): Promise<CareerMaterialFileCleanupReceipt> {
  const payload = normalizePayload(payloadValue);
  const handle = createCareerMaterialFileCleanupReceipt(handleValue).handle;
  if (payload.stagedFile.stagingOwner !== await careerMaterialStagingOwner(payload.operationId)) {
    throw new Error("cleanup owner does not match operation");
  }
  await persistCapabilityRecord(await capabilityRecord(PURPOSE, handle, payload), runtime);
  return { purpose: PURPOSE, version: VERSION, handle };
}

/** @internal Storage-service resolver; UI and journals must retain only the opaque handle. */
export async function resolveCareerMaterialFileCleanupReceipt(
  value: unknown,
  runtime: CareerMaterialWriteFileRuntime = defaultCareerMaterialWriteFileRuntime,
): Promise<CareerMaterialCapabilityResolution<
  CareerMaterialFileCleanupReceipt,
  CareerMaterialFileCleanupPayload
>> {
  return await inspectCapabilityRecord(value, PURPOSE, runtime) as
    CareerMaterialCapabilityResolution<CareerMaterialFileCleanupReceipt, CareerMaterialFileCleanupPayload>;
}

export async function issueCareerMaterialDeleteFileReceipt(
  payloadValue: CareerMaterialDeleteFilePayload,
  handleValue: string,
  runtime: CareerMaterialWriteFileRuntime = defaultCareerMaterialWriteFileRuntime,
): Promise<CareerMaterialDeleteFileReceipt> {
  const payload = normalizeDeletePayload(payloadValue);
  const handle = createCareerMaterialDeleteFileReceipt(handleValue).handle;
  if (payload.deletionOwner !== null && payload.deletionOwner !==
    await careerMaterialDeletionOwner(
      { generationId: payload.generationId, generationSequence: payload.generationSequence },
      payload.operationId,
      payload.materialId,
      payload.fileKey,
    )) {
    throw new Error("delete owner does not match operation");
  }
  await persistCapabilityRecord(await capabilityRecord(DELETE_PURPOSE, handle, payload), runtime);
  return { purpose: DELETE_PURPOSE, version: VERSION, handle };
}

/** @internal Storage-service resolver; UI and journals must retain only the opaque handle. */
export async function resolveCareerMaterialDeleteFileReceipt(
  value: unknown,
  runtime: CareerMaterialWriteFileRuntime = defaultCareerMaterialWriteFileRuntime,
): Promise<CareerMaterialCapabilityResolution<
  CareerMaterialDeleteFileReceipt,
  CareerMaterialDeleteFilePayload
>> {
  return await inspectCapabilityRecord(value, DELETE_PURPOSE, runtime) as
    CareerMaterialCapabilityResolution<CareerMaterialDeleteFileReceipt, CareerMaterialDeleteFilePayload>;
}

export async function completeCareerMaterialFileCapabilityReceipt(
  value: unknown,
  expectedBinding: CareerMaterialCapabilityBinding,
  runtime: CareerMaterialWriteFileRuntime = defaultCareerMaterialWriteFileRuntime,
): Promise<boolean> {
  const purpose = isCareerMaterialFileCleanupReceipt(value) ? PURPOSE
    : isCareerMaterialDeleteFileReceipt(value) ? DELETE_PURPOSE
      : null;
  if (purpose === null) throw new Error("invalid material capability");
  const binding = normalizeBinding(expectedBinding);
  let resolved = await inspectCapabilityRecord(value, purpose, runtime);
  if (resolved.state === "completed") {
    return sameCareerMaterialCapabilityBinding(resolved.binding, binding);
  }
  if (resolved.state !== "active" ||
    !sameCareerMaterialCapabilityBinding(bindingFromPayload(resolved.payload), binding)) {
    return false;
  }
  const completed = await completedCapabilityRecord(purpose, resolved.receipt.handle, binding);
  const serialized = serializeCapabilityRecord(completed);
  try {
    await runtime.replaceCapabilityRecord(resolved.receipt.handle, resolved.serialized, serialized);
  } catch (error) {
    resolved = await inspectCapabilityRecord(value, purpose, runtime);
    if (resolved.state !== "completed" ||
      !sameCareerMaterialCapabilityBinding(resolved.binding, binding)) throw error;
    return true;
  }
  resolved = await inspectCapabilityRecord(value, purpose, runtime);
  if (resolved.state !== "completed" ||
    !sameCareerMaterialCapabilityBinding(resolved.binding, binding)) {
    throw new Error("material capability completion uncertain");
  }
  return true;
}

/**
 * Backwards-named internal finalizer. It now persists a redacted completion
 * proof rather than deleting the private record, so response loss is replayable.
 */
export async function releaseCareerMaterialFileCapabilityReceipt(
  value: unknown,
  runtime: CareerMaterialWriteFileRuntime = defaultCareerMaterialWriteFileRuntime,
): Promise<boolean> {
  const purpose = isCareerMaterialFileCleanupReceipt(value) ? PURPOSE
    : isCareerMaterialDeleteFileReceipt(value) ? DELETE_PURPOSE
      : null;
  if (purpose === null) throw new Error("invalid material capability");
  const resolved = await inspectCapabilityRecord(value, purpose, runtime);
  if (resolved.state === "completed") return true;
  if (resolved.state !== "active") return false;
  return completeCareerMaterialFileCapabilityReceipt(
    value,
    bindingFromPayload(resolved.payload),
    runtime,
  );
}

export function sameCareerMaterialStagedFile(
  actual: LocalFileMetadata,
  expected: LocalFileMetadata,
): boolean {
  const keys = [
    "version", "key", "namespace", "originalName", "mimeType", "category",
    "byteSize", "sha256", "createdAt", "updatedAt",
    ...(expected.stagingOwner === undefined ? [] : ["stagingOwner"]),
  ];
  return Boolean(actual && typeof actual === "object" && !Array.isArray(actual) && exactKeys(actual, [
    ...keys,
  ])) && actual.version === expected.version && actual.key === expected.key &&
    actual.namespace === expected.namespace && actual.originalName === expected.originalName &&
    actual.mimeType === expected.mimeType && actual.category === expected.category &&
    actual.byteSize === expected.byteSize && actual.sha256.toLowerCase() === expected.sha256 &&
    actual.createdAt === expected.createdAt && actual.updatedAt === expected.updatedAt &&
    actual.stagingOwner === expected.stagingOwner;
}

export function isLocalFileMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error &&
    (error.code === "FILE_NOT_FOUND" || error.code === "FILE_BYTES_NOT_FOUND"));
}
