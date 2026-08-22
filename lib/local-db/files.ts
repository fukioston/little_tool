import type { LocalDatabaseId } from "./types";

const ROOT_DIRECTORY = "private-ai-suite-files";
const FORMAT_VERSION = 1;
const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LocalFileNamespace = LocalDatabaseId;

export type LocalFileMetadata = Readonly<{
  version: 1;
  key: string;
  namespace: LocalFileNamespace;
  originalName: string;
  mimeType: string;
  category: string | null;
  byteSize: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
  /** Internal write ownership used to make crash cleanup fail closed. */
  stagingOwner?: string;
}>;

export type SaveLocalFileOptions = Readonly<{
  originalName?: string;
  mimeType?: string;
  category?: string;
  createdAt?: string;
  updatedAt?: string;
}>;

export type LocalFileResult = Readonly<{
  metadata: LocalFileMetadata;
  file: File;
}>;

export type LocalFileObjectUrl = Readonly<{
  metadata: LocalFileMetadata;
  url: string;
  revoke(): void;
}>;

export type LocalStorageEstimate = Readonly<{
  usage: number | null;
  quota: number | null;
  available: number | null;
  persisted: boolean | null;
  usageDetails: Readonly<Record<string, number>>;
}>;

/**
 * Read-only fragment facts for crash recovery. No key or file bytes are
 * returned, and inspection never creates an OPFS directory.
 */
export type OwnedLocalFileFragmentInspection =
  | Readonly<{ state: "missing" }>
  | Readonly<{
      state: "owned";
      objectPresent: boolean;
      metadataKind: "claim" | "complete";
    }>
  | Readonly<{
      state: "foreign_or_unverifiable";
      objectPresent: boolean;
      metadataPresent: boolean;
    }>;

export type ClaimedLocalFileDeletionInspection =
  | Readonly<{ state: "missing_claim" }>
  | Readonly<{
      state: "owned";
      phase: "claimed" | "object_deleted" | "swept";
      objectPresent: boolean;
      metadataPresent: boolean;
    }>
  | Readonly<{
      state: "foreign_or_unverifiable";
      objectPresent: boolean;
      metadataPresent: boolean;
    }>;

/**
 * Read-only facts used before reserving an ordinary-file deletion. Thrown I/O
 * errors are deliberately not collapsed into any of these verified states.
 */
export type LocalFileDeletionCandidateInspection =
  | Readonly<{ state: "missing" }>
  | Readonly<{
      state: "exact";
      objectPresent: boolean;
      metadataPresent: boolean;
    }>
  | Readonly<{
      state: "verified_changed";
      objectPresent: boolean;
      metadataPresent: boolean;
    }>
  | Readonly<{
      state: "foreign_or_unverifiable";
      objectPresent: boolean;
      metadataPresent: boolean;
    }>;

export class LocalFileError extends Error {
  constructor(
    message: string,
    readonly code = "LOCAL_FILE_ERROR",
  ) {
    super(message);
    this.name = "LocalFileError";
  }
}

type NamespaceDirectories = {
  objects: FileSystemDirectoryHandle;
  metadata: FileSystemDirectoryHandle;
};

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

let rootDirectoryPromise: Promise<FileSystemDirectoryHandle> | undefined;

function requireBrowserStorage(): StorageManager {
  if (typeof navigator === "undefined" || !navigator.storage) {
    throw new LocalFileError(
      "Browser storage is unavailable in this environment.",
      "BROWSER_STORAGE_UNAVAILABLE",
    );
  }
  if (typeof navigator.storage.getDirectory !== "function") {
    throw new LocalFileError(
      "This browser does not support the Origin Private File System.",
      "OPFS_UNAVAILABLE",
    );
  }
  return navigator.storage;
}

async function getRootDirectory(): Promise<FileSystemDirectoryHandle> {
  rootDirectoryPromise ??= requireBrowserStorage()
    .getDirectory()
    .then((opfsRoot) =>
      opfsRoot.getDirectoryHandle(ROOT_DIRECTORY, { create: true }),
    );
  return rootDirectoryPromise;
}

async function getNamespaceDirectories(
  namespace: LocalFileNamespace,
): Promise<NamespaceDirectories> {
  const root = await getRootDirectory();
  const versionDirectory = await root.getDirectoryHandle(`v${FORMAT_VERSION}`, {
    create: true,
  });
  const namespaceDirectory = await versionDirectory.getDirectoryHandle(namespace, {
    create: true,
  });
  const [objects, metadata] = await Promise.all([
    namespaceDirectory.getDirectoryHandle("objects", { create: true }),
    namespaceDirectory.getDirectoryHandle("metadata", { create: true }),
  ]);
  return { objects, metadata };
}

function assertSafeKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new LocalFileError("The local file key is invalid.", "INVALID_FILE_KEY");
  }
}

function safeDisplayText(value: string | undefined, fallback: string): string {
  const sanitized = Array.from(value ?? "", (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return " ";
    if (character === "/" || character === "\\") return "_";
    return character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
  return sanitized || fallback;
}

function safeMimeType(value: string | undefined): string {
  const sanitized = (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9!#$&^_.+\-/]/g, "")
    .slice(0, 127);
  return sanitized.includes("/") ? sanitized : "application/octet-stream";
}

function safeTimestamp(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function objectFilename(key: string): string {
  return `${key}.bin`;
}

function metadataFilename(key: string): string {
  return `${key}.json`;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function isTypeMismatchError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TypeMismatchError";
}

async function fileEntryExists(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    // A directory or another incompatible entry at the exact name is still a
    // collision. It must never be replaced by a file write.
    if (isTypeMismatchError(error)) return true;
    throw error;
  }
}

async function directoryIfPresent(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await directory.getDirectoryHandle(name);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function assertKeyAvailableWithoutCreatingDirectories(
  namespace: LocalFileNamespace,
  key: string,
): Promise<void> {
  const storageRoot = await requireBrowserStorage().getDirectory();
  const root = await directoryIfPresent(storageRoot, ROOT_DIRECTORY);
  if (!root) return;
  const version = await directoryIfPresent(root, `v${FORMAT_VERSION}`);
  if (!version) return;
  const namespaceDirectory = await directoryIfPresent(version, namespace);
  if (!namespaceDirectory) return;
  const [objects, metadata] = await Promise.all([
    directoryIfPresent(namespaceDirectory, "objects"),
    directoryIfPresent(namespaceDirectory, "metadata"),
  ]);
  const [objectExists, metadataExists, deletionClaimExists] = await Promise.all([
    objects ? fileEntryExists(objects, objectFilename(key)) : false,
    metadata ? fileEntryExists(metadata, metadataFilename(key)) : false,
    metadata ? fileEntryExists(metadata, deletionClaimFilename(key)) : false,
  ]);
  if (objectExists || metadataExists || deletionClaimExists) {
    throw new LocalFileError(
      "The local file key is already in use.",
      "FILE_KEY_COLLISION",
    );
  }
}

async function assertKeyAvailableInDirectories(
  objects: FileSystemDirectoryHandle,
  metadata: FileSystemDirectoryHandle,
  key: string,
): Promise<void> {
  const [objectExists, metadataExists, deletionClaimExists] = await Promise.all([
    fileEntryExists(objects, objectFilename(key)),
    fileEntryExists(metadata, metadataFilename(key)),
    fileEntryExists(metadata, deletionClaimFilename(key)),
  ]);
  if (objectExists || metadataExists || deletionClaimExists) {
    throw new LocalFileError(
      "The local file key is already in use.",
      "FILE_KEY_COLLISION",
    );
  }
}

async function removeEntryIfPresent(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await directory.removeEntry(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return false;
    throw error;
  }
}

type LocalFileWriteClaim = Readonly<{
  version: 1;
  namespace: LocalFileNamespace;
  key: string;
  stagingOwner: string;
}>;

type LocalFileDeletionClaim = Readonly<{
  version: 1;
  kind: "local-file-deletion-claim";
  namespace: LocalFileNamespace;
  key: string;
  deletionOwner: string;
  phase: "claimed" | "object_deleted" | "swept";
  expectedMetadata: LocalFileMetadata | null;
}>;

function assertStagingOwner(stagingOwner: string): void {
  if (!/^[0-9a-f]{64}$/.test(stagingOwner)) {
    throw new LocalFileError(
      "The local file staging owner is invalid.",
      "INVALID_FILE_OWNER",
    );
  }
}

function deletionClaimFilename(key: string): string {
  return `${key}.deletion.json`;
}

async function writeJson(
  directory: FileSystemDirectoryHandle,
  name: string,
  value: unknown,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

async function writeOwnershipClaim(
  directory: FileSystemDirectoryHandle,
  namespace: LocalFileNamespace,
  key: string,
  stagingOwner: string,
): Promise<void> {
  const claim: LocalFileWriteClaim = {
    version: FORMAT_VERSION,
    namespace,
    key,
    stagingOwner,
  };
  await writeJson(directory, metadataFilename(key), claim);
}

async function writeBlobAndHash(
  handle: FileSystemFileHandle,
  blob: Blob,
): Promise<{ byteSize: number; sha256: string }> {
  const writable = await handle.createWritable({ keepExistingData: false });
  const hasher = new IncrementalSha256();
  let byteSize = 0;

  try {
    if (typeof blob.stream === "function") {
      const reader = blob.stream().getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;
          const chunk = value.slice();
          hasher.update(chunk);
          byteSize += chunk.byteLength;
          await writable.write(chunk);
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      const chunk = new Uint8Array(await blob.arrayBuffer());
      hasher.update(chunk);
      byteSize = chunk.byteLength;
      await writable.write(chunk);
    }
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }

  if (byteSize !== blob.size) {
    throw new LocalFileError(
      `The browser wrote ${byteSize} bytes but the source contained ${blob.size}.`,
      "FILE_SIZE_MISMATCH",
    );
  }

  return { byteSize, sha256: hasher.hexDigest() };
}

async function writeMetadata(
  directory: FileSystemDirectoryHandle,
  metadata: LocalFileMetadata,
): Promise<void> {
  await writeJson(directory, metadataFilename(metadata.key), metadata);
}

function isLocalFileMetadata(
  value: unknown,
  namespace: LocalFileNamespace,
  key: string,
): value is LocalFileMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Partial<LocalFileMetadata>;
  return (
    metadata.version === FORMAT_VERSION &&
    metadata.namespace === namespace &&
    metadata.key === key &&
    typeof metadata.originalName === "string" &&
    typeof metadata.mimeType === "string" &&
    (metadata.category === null || typeof metadata.category === "string") &&
    typeof metadata.byteSize === "number" &&
    Number.isSafeInteger(metadata.byteSize) &&
    metadata.byteSize >= 0 &&
    typeof metadata.sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(metadata.sha256) &&
    typeof metadata.createdAt === "string" &&
    typeof metadata.updatedAt === "string" &&
    (metadata.stagingOwner === undefined ||
      (typeof metadata.stagingOwner === "string" &&
        /^[0-9a-f]{64}$/.test(metadata.stagingOwner)))
  );
}

const LOCAL_FILE_METADATA_KEYS = [
  "version", "key", "namespace", "originalName", "mimeType", "category",
  "byteSize", "sha256", "createdAt", "updatedAt",
] as const;

function exactLocalFileMetadata(
  value: unknown,
  namespace: LocalFileNamespace,
  key: string,
): value is LocalFileMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !isLocalFileMetadata(value, namespace, key)) return false;
  const keys = Object.keys(value);
  const expected = (value as LocalFileMetadata).stagingOwner === undefined
    ? [...LOCAL_FILE_METADATA_KEYS]
    : [...LOCAL_FILE_METADATA_KEYS, "stagingOwner"];
  return keys.length === expected.length && expected.every((name) => keys.includes(name));
}

function sameLocalFileMetadata(left: LocalFileMetadata, right: LocalFileMetadata): boolean {
  const keys = left.stagingOwner === undefined && right.stagingOwner === undefined
    ? [...LOCAL_FILE_METADATA_KEYS]
    : [...LOCAL_FILE_METADATA_KEYS, "stagingOwner"] as const;
  return keys.every((key) => left[key] === right[key]);
}

function sameExpectedMetadata(
  left: LocalFileMetadata | null,
  right: LocalFileMetadata | null,
): boolean {
  return left === null || right === null
    ? left === right
    : sameLocalFileMetadata(left, right);
}

function isDeletionClaim(
  value: unknown,
  namespace: LocalFileNamespace,
  key: string,
): value is LocalFileDeletionClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as LocalFileDeletionClaim;
  const keys = Object.keys(value);
  return keys.length === 7 && [
    "version", "kind", "namespace", "key", "deletionOwner", "phase", "expectedMetadata",
  ].every((name) => keys.includes(name)) && claim.version === FORMAT_VERSION &&
    claim.kind === "local-file-deletion-claim" && claim.namespace === namespace && claim.key === key &&
    /^[0-9a-f]{64}$/.test(claim.deletionOwner) &&
    ["claimed", "object_deleted", "swept"].includes(claim.phase) &&
    (claim.expectedMetadata === null
      ? claim.phase === "swept"
      : exactLocalFileMetadata(claim.expectedMetadata, namespace, key) &&
        claim.expectedMetadata.stagingOwner === undefined);
}

function isExactWriteClaim(
  value: unknown,
  namespace: LocalFileNamespace,
  key: string,
  stagingOwner: string,
): value is LocalFileWriteClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as LocalFileWriteClaim;
  const keys = Object.keys(value);
  return keys.length === 4 && ["version", "namespace", "key", "stagingOwner"]
    .every((name) => keys.includes(name)) && claim.version === FORMAT_VERSION &&
    claim.namespace === namespace && claim.key === key && claim.stagingOwner === stagingOwner;
}

function isOwnedMetadataOrClaim(
  value: unknown,
  namespace: LocalFileNamespace,
  key: string,
  stagingOwner: string,
): boolean {
  if (isExactWriteClaim(value, namespace, key, stagingOwner)) return true;
  return exactLocalFileMetadata(value, namespace, key) &&
    value.stagingOwner === stagingOwner;
}

async function readRawMetadataIfPresent(
  directory: FileSystemDirectoryHandle,
  key: string,
): Promise<unknown | undefined> {
  try {
    const handle = await directory.getFileHandle(metadataFilename(key));
    const file = await handle.getFile();
    return JSON.parse(await file.text()) as unknown;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

async function readMetadata(
  directory: FileSystemDirectoryHandle,
  namespace: LocalFileNamespace,
  key: string,
): Promise<LocalFileMetadata> {
  let file: File;
  try {
    const handle = await directory.getFileHandle(metadataFilename(key));
    file = await handle.getFile();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      throw new LocalFileError("The local file does not exist.", "FILE_NOT_FOUND");
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new LocalFileError(
      "The local file metadata is unreadable.",
      "INVALID_FILE_METADATA",
    );
  }

  if (!isLocalFileMetadata(parsed, namespace, key)) {
    throw new LocalFileError(
      "The local file metadata failed validation.",
      "INVALID_FILE_METADATA",
    );
  }
  return parsed;
}

export async function saveLocalFile(
  namespace: LocalFileNamespace,
  blob: Blob,
  options: SaveLocalFileOptions = {},
): Promise<LocalFileMetadata> {
  if (!(blob instanceof Blob)) {
    throw new LocalFileError("saveLocalFile expects a Blob or File.", "INVALID_BLOB");
  }

  return saveLocalFileWithExactKey(
    namespace,
    crypto.randomUUID().toLowerCase(),
    blob,
    options,
  );
}

/**
 * Prove that neither side of an exact-key file record currently exists.
 * Callers that persist a crash-recovery receipt before writing can preflight
 * every key, then rely on saveLocalFileAtKey to repeat the same proof.
 */
export async function assertLocalFileKeyAvailable(
  namespace: LocalFileNamespace,
  key: string,
): Promise<void> {
  assertSafeKey(key);
  await assertKeyAvailableWithoutCreatingDirectories(namespace, key);
}

export async function inspectOwnedLocalFileFragments(
  namespace: LocalFileNamespace,
  key: string,
  stagingOwner: string,
): Promise<OwnedLocalFileFragmentInspection> {
  assertSafeKey(key);
  assertStagingOwner(stagingOwner);
  const storageRoot = await requireBrowserStorage().getDirectory();
  const root = await directoryIfPresent(storageRoot, ROOT_DIRECTORY);
  const version = root ? await directoryIfPresent(root, `v${FORMAT_VERSION}`) : null;
  const namespaceDirectory = version
    ? await directoryIfPresent(version, namespace)
    : null;
  const objects = namespaceDirectory
    ? await directoryIfPresent(namespaceDirectory, "objects")
    : null;
  const metadata = namespaceDirectory
    ? await directoryIfPresent(namespaceDirectory, "metadata")
    : null;
  const [objectPresent, rawMetadata] = await Promise.all([
    objects ? fileEntryExists(objects, objectFilename(key)) : false,
    metadata ? readRawMetadataIfPresent(metadata, key) : undefined,
  ]);
  if (!objectPresent && rawMetadata === undefined) return { state: "missing" };
  if (rawMetadata !== undefined &&
    isOwnedMetadataOrClaim(rawMetadata, namespace, key, stagingOwner)) {
    return {
      state: "owned",
      objectPresent,
      metadataKind: exactLocalFileMetadata(rawMetadata, namespace, key)
        ? "complete"
        : "claim",
    };
  }
  return {
    state: "foreign_or_unverifiable",
    objectPresent,
    metadataPresent: rawMetadata !== undefined,
  };
}

async function readRawDeletionClaimIfPresent(
  directory: FileSystemDirectoryHandle,
  key: string,
): Promise<unknown | undefined> {
  try {
    const handle = await directory.getFileHandle(deletionClaimFilename(key));
    const file = await handle.getFile();
    return JSON.parse(await file.text()) as unknown;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

function sameDeletionClaim(left: LocalFileDeletionClaim, right: LocalFileDeletionClaim): boolean {
  return left.version === right.version && left.kind === right.kind &&
    left.namespace === right.namespace && left.key === right.key &&
    left.deletionOwner === right.deletionOwner && left.phase === right.phase &&
    sameExpectedMetadata(left.expectedMetadata, right.expectedMetadata);
}

async function persistDeletionClaim(
  metadata: FileSystemDirectoryHandle,
  claim: LocalFileDeletionClaim,
  newlyReserved = false,
): Promise<void> {
  try {
    await writeJson(metadata, deletionClaimFilename(claim.key), claim);
  } catch (error) {
    let recovered: unknown | undefined;
    try { recovered = await readRawDeletionClaimIfPresent(metadata, claim.key); }
    catch (inspectionError) {
      if (newlyReserved && inspectionError instanceof SyntaxError) {
        await removeEntryAndConfirm(metadata, deletionClaimFilename(claim.key)).catch(() => undefined);
      }
      throw error;
    }
    if (isDeletionClaim(recovered, claim.namespace, claim.key) && sameDeletionClaim(recovered, claim)) return;
    throw error;
  }
  const stored = await readRawDeletionClaimIfPresent(metadata, claim.key);
  if (!isDeletionClaim(stored, claim.namespace, claim.key) || !sameDeletionClaim(stored, claim)) {
    throw new LocalFileError("The local file deletion claim was not stored exactly.", "FILE_DELETION_CLAIM_UNCERTAIN");
  }
}

async function objectFileIfPresent(
  objects: FileSystemDirectoryHandle,
  key: string,
): Promise<File | null> {
  try {
    return await (await objects.getFileHandle(objectFilename(key))).getFile();
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function inspectDeletionCandidateInDirectories(
  objects: FileSystemDirectoryHandle,
  metadata: FileSystemDirectoryHandle,
  namespace: LocalFileNamespace,
  key: string,
  expectedMetadata: LocalFileMetadata | null,
): Promise<LocalFileDeletionCandidateInspection> {
  const [objectFile, rawMetadata] = await Promise.all([
    objectFileIfPresent(objects, key),
    readRawMetadataIfPresent(metadata, key),
  ]);
  const objectPresent = objectFile !== null;
  const metadataPresent = rawMetadata !== undefined;
  if (!objectPresent && !metadataPresent) return { state: "missing" };
  if (expectedMetadata === null) {
    return { state: "foreign_or_unverifiable", objectPresent, metadataPresent };
  }
  if (metadataPresent) {
    if (!exactLocalFileMetadata(rawMetadata, namespace, key) ||
      rawMetadata.stagingOwner !== undefined) {
      return { state: "foreign_or_unverifiable", objectPresent, metadataPresent };
    }
    if (!sameLocalFileMetadata(rawMetadata, expectedMetadata)) {
      return { state: "verified_changed", objectPresent, metadataPresent };
    }
  }
  if (objectFile && (objectFile.size !== expectedMetadata.byteSize ||
    await sha256Blob(objectFile) !== expectedMetadata.sha256.toLowerCase())) {
    return { state: "verified_changed", objectPresent, metadataPresent };
  }
  return { state: "exact", objectPresent, metadataPresent };
}

export async function inspectLocalFileDeletionCandidate(
  namespace: LocalFileNamespace,
  key: string,
  expectedMetadata: LocalFileMetadata | null,
): Promise<LocalFileDeletionCandidateInspection> {
  assertSafeKey(key);
  if (expectedMetadata !== null &&
    (!exactLocalFileMetadata(expectedMetadata, namespace, key) ||
      expectedMetadata.stagingOwner !== undefined)) {
    throw new LocalFileError(
      "The expected ordinary local file metadata is invalid.",
      "INVALID_FILE_METADATA",
    );
  }
  const { objects, metadata } = await getNamespaceDirectories(namespace);
  return inspectDeletionCandidateInDirectories(
    objects, metadata, namespace, key, expectedMetadata,
  );
}

async function inspectClaimedDeletionInDirectories(
  objects: FileSystemDirectoryHandle,
  metadata: FileSystemDirectoryHandle,
  namespace: LocalFileNamespace,
  key: string,
  expectedMetadata: LocalFileMetadata | null,
  deletionOwner: string,
): Promise<ClaimedLocalFileDeletionInspection> {
  const [rawClaim, objectFile, rawMetadata] = await Promise.all([
    readRawDeletionClaimIfPresent(metadata, key),
    objectFileIfPresent(objects, key),
    readRawMetadataIfPresent(metadata, key),
  ]);
  if (rawClaim === undefined) return { state: "missing_claim" };
  const objectPresent = objectFile !== null;
  const metadataPresent = rawMetadata !== undefined;
  if (!isDeletionClaim(rawClaim, namespace, key) || rawClaim.deletionOwner !== deletionOwner ||
    !sameExpectedMetadata(rawClaim.expectedMetadata, expectedMetadata) ||
    (expectedMetadata === null && (objectPresent || metadataPresent)) ||
    (expectedMetadata !== null && metadataPresent &&
      (!exactLocalFileMetadata(rawMetadata, namespace, key) ||
        !sameLocalFileMetadata(rawMetadata, expectedMetadata))) ||
    (expectedMetadata !== null && objectPresent &&
      (objectFile.size !== expectedMetadata.byteSize ||
        await sha256Blob(objectFile) !== expectedMetadata.sha256.toLowerCase())) ||
    (rawClaim.phase === "object_deleted" && objectPresent) ||
    (rawClaim.phase === "swept" && (objectPresent || metadataPresent))) {
    return { state: "foreign_or_unverifiable", objectPresent, metadataPresent };
  }
  return {
    state: "owned",
    phase: rawClaim.phase,
    objectPresent,
    metadataPresent,
  };
}

export async function claimLocalFileDeletion(
  namespace: LocalFileNamespace,
  key: string,
  expectedMetadata: LocalFileMetadata | null,
  deletionOwner: string,
): Promise<void> {
  assertSafeKey(key);
  assertStagingOwner(deletionOwner);
  if (expectedMetadata !== null &&
    (!exactLocalFileMetadata(expectedMetadata, namespace, key) ||
      expectedMetadata.stagingOwner !== undefined)) {
    throw new LocalFileError("Only an exact ordinary local file can be claimed for deletion.", "INVALID_FILE_METADATA");
  }
  const { objects, metadata } = await getNamespaceDirectories(namespace);
  const existing = await readRawDeletionClaimIfPresent(metadata, key);
  if (existing !== undefined) {
    if (isDeletionClaim(existing, namespace, key) && existing.deletionOwner === deletionOwner &&
      sameExpectedMetadata(existing.expectedMetadata, expectedMetadata)) return;
    throw new LocalFileError("The local file has a foreign deletion claim.", "FILE_DELETION_CLAIM_MISMATCH");
  }
  const candidate = await inspectDeletionCandidateInDirectories(
    objects, metadata, namespace, key, expectedMetadata,
  );
  if (candidate.state !== "exact" && candidate.state !== "missing") {
    throw new LocalFileError("The ordinary local file changed before its deletion claim.", "FILE_DELETION_CLAIM_MISMATCH");
  }
  await persistDeletionClaim(metadata, {
    version: FORMAT_VERSION,
    kind: "local-file-deletion-claim",
    namespace,
    key,
    deletionOwner,
    phase: candidate.state === "missing" ? "swept" : "claimed",
    expectedMetadata: expectedMetadata ? { ...expectedMetadata } : null,
  }, true);
}

export async function inspectClaimedLocalFileDeletion(
  namespace: LocalFileNamespace,
  key: string,
  expectedMetadata: LocalFileMetadata | null,
  deletionOwner: string,
): Promise<ClaimedLocalFileDeletionInspection> {
  assertSafeKey(key);
  assertStagingOwner(deletionOwner);
  if (expectedMetadata !== null &&
    (!exactLocalFileMetadata(expectedMetadata, namespace, key) ||
      expectedMetadata.stagingOwner !== undefined)) {
    throw new LocalFileError("The expected ordinary local file metadata is invalid.", "INVALID_FILE_METADATA");
  }
  const { objects, metadata } = await getNamespaceDirectories(namespace);
  return inspectClaimedDeletionInDirectories(
    objects, metadata, namespace, key, expectedMetadata, deletionOwner,
  );
}

async function removeEntryAndConfirm(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    const removed = await removeEntryIfPresent(directory, name);
    if (await fileEntryExists(directory, name)) {
      throw new LocalFileError("The local file deletion could not be confirmed.", "FILE_DELETE_UNCERTAIN");
    }
    return removed;
  } catch (error) {
    if (!await fileEntryExists(directory, name).catch(() => true)) return true;
    throw error;
  }
}

export async function sweepClaimedLocalFileDeletion(
  namespace: LocalFileNamespace,
  key: string,
  expectedMetadata: LocalFileMetadata | null,
  deletionOwner: string,
): Promise<boolean> {
  assertSafeKey(key);
  assertStagingOwner(deletionOwner);
  const { objects, metadata } = await getNamespaceDirectories(namespace);
  let inspection = await inspectClaimedDeletionInDirectories(
    objects, metadata, namespace, key, expectedMetadata, deletionOwner,
  );
  if (inspection.state !== "owned") {
    throw new LocalFileError("The local file deletion claim cannot sweep these fragments.", "FILE_DELETION_CLAIM_MISMATCH");
  }
  let removed = false;
  if (inspection.phase === "claimed") {
    if (inspection.objectPresent) {
      removed = await removeEntryAndConfirm(objects, objectFilename(key)) || removed;
    }
    const current = await readRawDeletionClaimIfPresent(metadata, key);
    if (!isDeletionClaim(current, namespace, key) || current.deletionOwner !== deletionOwner ||
      !sameExpectedMetadata(current.expectedMetadata, expectedMetadata)) {
      throw new LocalFileError("The local file deletion claim changed.", "FILE_DELETION_CLAIM_MISMATCH");
    }
    await persistDeletionClaim(metadata, { ...current, phase: "object_deleted" });
    inspection = await inspectClaimedDeletionInDirectories(
      objects, metadata, namespace, key, expectedMetadata, deletionOwner,
    );
  }
  if (inspection.state !== "owned") {
    throw new LocalFileError("A foreign object appeared during local file deletion.", "FILE_DELETION_CLAIM_MISMATCH");
  }
  if (inspection.phase === "object_deleted") {
    if (inspection.metadataPresent) {
      removed = await removeEntryAndConfirm(metadata, metadataFilename(key)) || removed;
    }
    const current = await readRawDeletionClaimIfPresent(metadata, key);
    if (!isDeletionClaim(current, namespace, key) || current.deletionOwner !== deletionOwner ||
      !sameExpectedMetadata(current.expectedMetadata, expectedMetadata)) {
      throw new LocalFileError("The local file deletion claim changed.", "FILE_DELETION_CLAIM_MISMATCH");
    }
    await persistDeletionClaim(metadata, { ...current, phase: "swept" });
    inspection = await inspectClaimedDeletionInDirectories(
      objects, metadata, namespace, key, expectedMetadata, deletionOwner,
    );
  }
  if (inspection.state !== "owned" || inspection.phase !== "swept") {
    throw new LocalFileError("The local file deletion did not settle exactly.", "FILE_DELETE_UNCERTAIN");
  }
  return removed;
}

export async function releaseClaimedLocalFileDeletion(
  namespace: LocalFileNamespace,
  key: string,
  expectedMetadata: LocalFileMetadata | null,
  deletionOwner: string,
): Promise<boolean> {
  assertSafeKey(key);
  assertStagingOwner(deletionOwner);
  const { objects, metadata } = await getNamespaceDirectories(namespace);
  const inspection = await inspectClaimedDeletionInDirectories(
    objects, metadata, namespace, key, expectedMetadata, deletionOwner,
  );
  if (inspection.state === "missing_claim") return false;
  if (inspection.state !== "owned" || inspection.phase !== "swept") {
    throw new LocalFileError("The local file deletion claim is not ready for release.", "FILE_DELETION_CLAIM_MISMATCH");
  }
  return removeEntryAndConfirm(metadata, deletionClaimFilename(key));
}

export async function abandonClaimedLocalFileDeletion(
  namespace: LocalFileNamespace,
  key: string,
  expectedMetadata: LocalFileMetadata | null,
  deletionOwner: string,
): Promise<boolean> {
  assertSafeKey(key);
  assertStagingOwner(deletionOwner);
  const { objects, metadata } = await getNamespaceDirectories(namespace);
  const inspection = await inspectClaimedDeletionInDirectories(
    objects,
    metadata,
    namespace,
    key,
    expectedMetadata,
    deletionOwner,
  );
  if (inspection.state === "missing_claim") return false;
  if (inspection.state !== "owned" || inspection.phase !== "claimed" ||
    !inspection.objectPresent || !inspection.metadataPresent) {
    throw new LocalFileError(
      "Only an untouched deletion claim can be abandoned.",
      "FILE_DELETION_CLAIM_MISMATCH",
    );
  }
  return removeEntryAndConfirm(metadata, deletionClaimFilename(key));
}

/**
 * Save to an exact UUID after refusing any object or metadata collision.
 * A small ownership claim is written first, so a crash after the first write
 * can later be cleaned only by the operation that created it.
 */
export async function saveLocalFileAtKey(
  namespace: LocalFileNamespace,
  key: string,
  blob: Blob,
  options: SaveLocalFileOptions,
  stagingOwner: string,
): Promise<LocalFileMetadata> {
  assertStagingOwner(stagingOwner);
  return saveLocalFileWithExactKey(
    namespace,
    key,
    blob,
    options,
    stagingOwner,
  );
}

async function saveLocalFileWithExactKey(
  namespace: LocalFileNamespace,
  key: string,
  blob: Blob,
  options: SaveLocalFileOptions,
  stagingOwner?: string,
): Promise<LocalFileMetadata> {
  assertSafeKey(key);
  if (!(blob instanceof Blob)) {
    throw new LocalFileError(
      "saveLocalFileAtKey expects a Blob or File.",
      "INVALID_BLOB",
    );
  }
  const { objects, metadata: metadataDirectory } =
    await getNamespaceDirectories(namespace);
  await assertKeyAvailableInDirectories(objects, metadataDirectory, key);
  const objectName = objectFilename(key);
  let ownershipClaimStarted = false;

  try {
    if (stagingOwner !== undefined) {
      ownershipClaimStarted = true;
      await writeOwnershipClaim(metadataDirectory, namespace, key, stagingOwner);
    }
    const objectHandle = await objects.getFileHandle(objectName, { create: true });
    const digest = await writeBlobAndHash(objectHandle, blob);
    const now = new Date().toISOString();
    const createdAt = safeTimestamp(options.createdAt, now);
    const updatedAt = safeTimestamp(options.updatedAt, createdAt);
    const fileName =
      options.originalName ??
      (typeof File !== "undefined" && blob instanceof File ? blob.name : undefined);
    const metadata: LocalFileMetadata = {
      version: FORMAT_VERSION,
      key,
      namespace,
      originalName: safeDisplayText(fileName, "attachment"),
      mimeType: safeMimeType(options.mimeType ?? blob.type),
      category: options.category
        ? safeDisplayText(options.category, "attachment")
        : null,
      byteSize: digest.byteSize,
      sha256: digest.sha256,
      createdAt,
      updatedAt,
      ...(stagingOwner === undefined ? {} : { stagingOwner }),
    };
    await writeMetadata(metadataDirectory, metadata);
    return metadata;
  } catch (error) {
    if (stagingOwner === undefined) {
      await Promise.allSettled([
        removeEntryIfPresent(objects, objectName),
        removeEntryIfPresent(metadataDirectory, metadataFilename(key)),
      ]);
    } else if (ownershipClaimStarted) {
      await deleteOwnedLocalFile(namespace, key, stagingOwner).catch(() => undefined);
    }
    throw error;
  }
}

export async function getLocalFile(
  namespace: LocalFileNamespace,
  key: string,
): Promise<LocalFileResult> {
  assertSafeKey(key);
  const { objects, metadata: metadataDirectory } =
    await getNamespaceDirectories(namespace);
  const metadata = await readMetadata(metadataDirectory, namespace, key);

  try {
    const handle = await objects.getFileHandle(objectFilename(key));
    const storedFile = await handle.getFile();
    if (storedFile.size !== metadata.byteSize) {
      throw new LocalFileError(
        "The stored file size does not match its metadata.",
        "FILE_SIZE_MISMATCH",
      );
    }
    const file = new File([storedFile], metadata.originalName, {
      type: metadata.mimeType,
      lastModified: Date.parse(metadata.updatedAt) || storedFile.lastModified,
    });
    return { metadata, file };
  } catch (error) {
    if (error instanceof LocalFileError) throw error;
    if (error instanceof DOMException && error.name === "NotFoundError") {
      throw new LocalFileError(
        "The local file bytes are missing.",
        "FILE_BYTES_NOT_FOUND",
      );
    }
    throw error;
  }
}

export async function deleteLocalFile(
  namespace: LocalFileNamespace,
  key: string,
): Promise<boolean> {
  assertSafeKey(key);
  const { objects, metadata } = await getNamespaceDirectories(namespace);
  const [objectDeleted, metadataDeleted] = await Promise.all([
    removeEntryIfPresent(objects, objectFilename(key)),
    removeEntryIfPresent(metadata, metadataFilename(key)),
  ]);
  return objectDeleted || metadataDeleted;
}

/**
 * Delete an exact-key record only when its metadata or in-progress claim is
 * bound to the expected operation. Missing records are an idempotent success;
 * partial or foreign records fail closed and are retained.
 */
export async function deleteOwnedLocalFile(
  namespace: LocalFileNamespace,
  key: string,
  stagingOwner: string,
): Promise<boolean> {
  assertSafeKey(key);
  assertStagingOwner(stagingOwner);
  const { objects, metadata } = await getNamespaceDirectories(namespace);
  const [objectExists, rawMetadata] = await Promise.all([
    fileEntryExists(objects, objectFilename(key)),
    readRawMetadataIfPresent(metadata, key),
  ]);
  if (rawMetadata === undefined) {
    if (!objectExists) return false;
    throw new LocalFileError(
      "The local file ownership cannot be verified.",
      "FILE_OWNERSHIP_UNVERIFIED",
    );
  }
  if (!isOwnedMetadataOrClaim(rawMetadata, namespace, key, stagingOwner)) {
    throw new LocalFileError(
      "The local file belongs to a different write operation.",
      "FILE_OWNERSHIP_MISMATCH",
    );
  }
  // Preserve the ownership proof until the object side is confirmed absent.
  // A crash can therefore leave metadata-only, but this function never creates
  // an unverifiable bytes-only fragment.
  const objectDeleted = await removeEntryAndConfirm(objects, objectFilename(key));
  const metadataDeleted = await removeEntryAndConfirm(metadata, metadataFilename(key));
  return objectDeleted || metadataDeleted;
}

export async function listLocalFiles(
  namespace: LocalFileNamespace,
): Promise<LocalFileMetadata[]> {
  const { objects, metadata } = await getNamespaceDirectories(namespace);
  const records: LocalFileMetadata[] = [];

  for await (const [name, handle] of (
    metadata as IterableDirectoryHandle
  ).entries()) {
    if (handle.kind !== "file" || !name.endsWith(".json")) continue;
    const key = name.slice(0, -".json".length);
    if (!KEY_PATTERN.test(key)) continue;

    try {
      const record = await readMetadata(metadata, namespace, key);
      const objectHandle = await objects.getFileHandle(objectFilename(key));
      const objectFile = await objectHandle.getFile();
      if (objectFile.size === record.byteSize) records.push(record);
    } catch {
      // A failed/incomplete write is intentionally invisible to callers.
    }
  }

  return records.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export async function createLocalFileObjectUrl(
  namespace: LocalFileNamespace,
  key: string,
): Promise<LocalFileObjectUrl> {
  const { metadata, file } = await getLocalFile(namespace, key);
  const url = URL.createObjectURL(file);
  let revoked = false;

  return {
    metadata,
    url,
    revoke() {
      if (revoked) return;
      URL.revokeObjectURL(url);
      revoked = true;
    },
  };
}

export async function requestPersistentLocalStorage(): Promise<boolean> {
  const storage = requireBrowserStorage();
  if (typeof storage.persist !== "function") return false;
  return storage.persist();
}

export function supportsPersistentLocalStorage(): boolean {
  return typeof requireBrowserStorage().persist === "function";
}

export async function estimateLocalStorage(): Promise<LocalStorageEstimate> {
  const storage = requireBrowserStorage();
  const [estimateResult, persistedResult] = await Promise.allSettled([
    storage.estimate(),
    typeof storage.persisted === "function"
      ? storage.persisted()
      : Promise.resolve(null),
  ]);
  if (estimateResult.status === "rejected" && persistedResult.status === "rejected") {
    throw new LocalFileError(
      "浏览器暂时没有返回容量或保护状态。",
      "STORAGE_ESTIMATE_UNAVAILABLE",
    );
  }
  const estimate = estimateResult.status === "fulfilled" ? estimateResult.value : {};
  const persisted = persistedResult.status === "fulfilled" &&
    typeof persistedResult.value === "boolean"
    ? persistedResult.value
    : null;
  const usage = Number.isFinite(estimate.usage) && (estimate.usage as number) >= 0
    ? estimate.usage as number
    : null;
  const quota = Number.isFinite(estimate.quota) && (estimate.quota as number) >= 0
    ? estimate.quota as number
    : null;
  const rawDetails = (estimate as StorageEstimate & {
    usageDetails?: Record<string, number>;
  }).usageDetails;

  return {
    usage,
    quota,
    available: usage === null || quota === null ? null : Math.max(0, quota - usage),
    persisted,
    usageDetails: rawDetails ? { ...rawDetails } : {},
  };
}

/** Hash a Blob without materializing the whole payload in memory. */
export async function sha256Blob(blob: Blob): Promise<string> {
  const hasher = new IncrementalSha256();
  if (typeof blob.stream === "function") {
    const reader = blob.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) hasher.update(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    hasher.update(new Uint8Array(await blob.arrayBuffer()));
  }
  return hasher.hexDigest();
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

class IncrementalSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);
  private readonly buffer = new Uint8Array(64);
  private readonly schedule = new Uint32Array(64);
  private bufferLength = 0;
  private bytesHashed = 0;
  private finished = false;

  update(input: Uint8Array): void {
    if (this.finished) throw new Error("SHA-256 digest has already been finalized.");
    this.bytesHashed += input.byteLength;
    let offset = 0;

    if (this.bufferLength > 0) {
      const needed = 64 - this.bufferLength;
      const copied = Math.min(needed, input.byteLength);
      this.buffer.set(input.subarray(0, copied), this.bufferLength);
      this.bufferLength += copied;
      offset += copied;
      if (this.bufferLength === 64) {
        this.compress(this.buffer);
        this.bufferLength = 0;
      }
    }

    while (offset + 64 <= input.byteLength) {
      this.compress(input.subarray(offset, offset + 64));
      offset += 64;
    }

    if (offset < input.byteLength) {
      this.buffer.set(input.subarray(offset), 0);
      this.bufferLength = input.byteLength - offset;
    }
  }

  hexDigest(): string {
    const digest = this.digest();
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private digest(): Uint8Array {
    if (this.finished) throw new Error("SHA-256 digest has already been finalized.");
    this.finished = true;

    this.buffer[this.bufferLength] = 0x80;
    this.bufferLength += 1;
    if (this.bufferLength > 56) {
      this.buffer.fill(0, this.bufferLength);
      this.compress(this.buffer);
      this.bufferLength = 0;
    }
    this.buffer.fill(0, this.bufferLength, 56);

    const bitLengthHigh = Math.floor(this.bytesHashed / 0x20000000);
    const bitLengthLow = (this.bytesHashed * 8) >>> 0;
    const view = new DataView(this.buffer.buffer);
    view.setUint32(56, bitLengthHigh, false);
    view.setUint32(60, bitLengthLow, false);
    this.compress(this.buffer);

    const output = new Uint8Array(32);
    const outputView = new DataView(output.buffer);
    for (let index = 0; index < this.state.length; index += 1) {
      outputView.setUint32(index * 4, this.state[index], false);
    }
    return output;
  }

  private compress(chunk: Uint8Array): void {
    const words = this.schedule;
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      words[index] =
        ((chunk[offset] << 24) |
          (chunk[offset + 1] << 16) |
          (chunk[offset + 2] << 8) |
          chunk[offset + 3]) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const prior15 = words[index - 15];
      const prior2 = words[index - 2];
      const smallSigma0 =
        rotateRight(prior15, 7) ^ rotateRight(prior15, 18) ^ (prior15 >>> 3);
      const smallSigma1 =
        rotateRight(prior2, 17) ^ rotateRight(prior2, 19) ^ (prior2 >>> 10);
      words[index] =
        (words[index - 16] + smallSigma0 + words[index - 7] + smallSigma1) >>> 0;
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];

    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 =
        (h + bigSigma1 + choose + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (bigSigma0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}
