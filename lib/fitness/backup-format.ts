const FORMAT = "fitness-backup" as const;
const VERSION = 1 as const;
const PRODUCT = "shilian" as const;
const MAGIC = "FITNESS-BACKUP\r\n\u001a";
const SQLITE_HEADER = "SQLite format 3\u0000";
const SQLITE_IDENTITY_BYTES = 72;
const APPLICATION_ID = 0x5348_4c4e;
const USER_VERSION = 1;

const encoder = new TextEncoder();
const magicBytes = encoder.encode(MAGIC);
const sqliteHeaderBytes = encoder.encode(SQLITE_HEADER);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIME_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

export const FITNESS_BACKUP_MAGIC = MAGIC;
export const FITNESS_BACKUP_MIME_TYPE =
  "application/vnd.shilian.fitness-backup";
export const FITNESS_BACKUP_PREFIX_BYTES = magicBytes.byteLength + 4;
export const FITNESS_BACKUP_APPLICATION_ID = APPLICATION_ID;
export const FITNESS_BACKUP_USER_VERSION = USER_VERSION;
export const FITNESS_BACKUP_LIMITS = Object.freeze({
  manifestBytes: 2 * 1024 * 1024,
  databaseBytes: 512 * 1024 * 1024,
  fileCount: 1_000,
  fileBytes: 512 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
  idCharacters: 255,
  entityIdCharacters: 255,
  originalNameCharacters: 255,
  mimeTypeCharacters: 127,
});

export type FitnessBackupHashBlob = (blob: Blob) => Promise<string>;

export type FitnessBackupFileMetadata = Readonly<{
  id: string;
  entityType: "venue" | "equipment" | "exercise" | "session";
  entityId: string;
  purpose: "photo" | "instruction" | "other";
  key: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  status: "ready";
  createdAt: number;
  updatedAt: number;
}>;

export type FitnessBackupManifest = Readonly<{
  format: typeof FORMAT;
  version: typeof VERSION;
  product: typeof PRODUCT;
  exportedAt: string;
  database: Readonly<{
    byteSize: number;
    sha256: string;
    applicationId: typeof APPLICATION_ID;
    userVersion: typeof USER_VERSION;
  }>;
  files: readonly FitnessBackupFileMetadata[];
  manifestSha256: string;
}>;

type UnsignedManifest = Omit<FitnessBackupManifest, "manifestSha256">;

export type FitnessBackupFileInput = Readonly<{
  metadata: FitnessBackupFileMetadata;
  blob: Blob;
}>;

export type CreateFitnessBackupInput = Readonly<{
  database: Uint8Array;
  files: readonly FitnessBackupFileInput[];
  exportedAt?: string;
}>;

export type ParsedFitnessBackup = Readonly<{
  manifest: FitnessBackupManifest;
  database: Uint8Array;
  files: readonly Readonly<{
    metadata: FitnessBackupFileMetadata;
    blob: Blob;
  }>[];
}>;

export class FitnessBackupFormatError extends Error {
  constructor(message: string, readonly code = "INVALID_FITNESS_BACKUP") {
    super(message);
    this.name = "FitnessBackupFormatError";
  }
}

function fail(message: string, code: string): never {
  throw new FitnessBackupFormatError(message, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    fail(`${label} contains unsupported or missing fields.`, "INVALID_MANIFEST");
  }
}

function assertSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  tooLargeCode: string,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    fail(`${label} must be a supported safe integer.`, "INVALID_MANIFEST");
  }
  if (value > maximum) fail(`${label} exceeds the safety limit.`, tooLargeCode);
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length !== 24) {
    fail(`${label} must be an ISO-8601 timestamp.`, "INVALID_MANIFEST");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp.`, "INVALID_MANIFEST");
  }
}

function assertDisplayText(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    Array.from(value).some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || point === 127;
    })
  ) {
    fail(`${label} is invalid or too long.`, "INVALID_MANIFEST");
  }
}

function assertSafeFileName(value: unknown, label: string): asserts value is string {
  assertDisplayText(value, label, FITNESS_BACKUP_LIMITS.originalNameCharacters);
  if (
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    fail(`${label} is not a safe file name.`, "INVALID_MANIFEST");
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest.`, "INVALID_MANIFEST");
  }
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
    fail(`${label} must be a canonical UUID v4.`, "INVALID_MANIFEST");
  }
}

function assertMimeType(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > FITNESS_BACKUP_LIMITS.mimeTypeCharacters ||
    !MIME_PATTERN.test(value)
  ) {
    fail(`${label} must be a canonical MIME type.`, "INVALID_MANIFEST");
  }
}

const FILE_KEYS = [
  "id",
  "entityType",
  "entityId",
  "purpose",
  "key",
  "originalName",
  "mimeType",
  "byteSize",
  "sha256",
  "status",
  "createdAt",
  "updatedAt",
] as const;

function validateFileMetadata(
  value: unknown,
  label: string,
): FitnessBackupFileMetadata {
  if (!isRecord(value)) fail(`${label} must be an object.`, "INVALID_MANIFEST");
  assertExactKeys(value, FILE_KEYS, label);
  assertDisplayText(value.id, `${label}.id`, FITNESS_BACKUP_LIMITS.idCharacters);
  if (
    value.entityType !== "venue" &&
    value.entityType !== "equipment" &&
    value.entityType !== "exercise" &&
    value.entityType !== "session"
  ) {
    fail(`${label}.entityType is unsupported.`, "INVALID_MANIFEST");
  }
  assertDisplayText(
    value.entityId,
    `${label}.entityId`,
    FITNESS_BACKUP_LIMITS.entityIdCharacters,
  );
  if (
    value.purpose !== "photo" &&
    value.purpose !== "instruction" &&
    value.purpose !== "other"
  ) {
    fail(`${label}.purpose is unsupported.`, "INVALID_MANIFEST");
  }
  assertUuid(value.key, `${label}.key`);
  assertSafeFileName(value.originalName, `${label}.originalName`);
  assertMimeType(value.mimeType, `${label}.mimeType`);
  assertSafeInteger(
    value.byteSize,
    `${label}.byteSize`,
    0,
    FITNESS_BACKUP_LIMITS.fileBytes,
    "FILE_TOO_LARGE",
  );
  assertSha256(value.sha256, `${label}.sha256`);
  if (value.status !== "ready") {
    fail(`${label}.status must be ready.`, "INVALID_MANIFEST");
  }
  assertSafeInteger(
    value.createdAt,
    `${label}.createdAt`,
    0,
    Number.MAX_SAFE_INTEGER,
    "INVALID_MANIFEST",
  );
  assertSafeInteger(
    value.updatedAt,
    `${label}.updatedAt`,
    value.createdAt,
    Number.MAX_SAFE_INTEGER,
    "INVALID_MANIFEST",
  );

  return {
    id: value.id,
    entityType: value.entityType,
    entityId: value.entityId,
    purpose: value.purpose,
    key: value.key,
    originalName: value.originalName,
    mimeType: value.mimeType,
    byteSize: value.byteSize,
    sha256: value.sha256,
    status: "ready",
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function readSqliteIdentity(database: Uint8Array) {
  if (database.byteLength < SQLITE_IDENTITY_BYTES) {
    fail("The database payload is too short.", "INVALID_SQLITE");
  }
  for (let index = 0; index < sqliteHeaderBytes.byteLength; index += 1) {
    if (database[index] !== sqliteHeaderBytes[index]) {
      fail("The database payload is not SQLite 3.", "INVALID_SQLITE");
    }
  }
  const view = new DataView(
    database.buffer,
    database.byteOffset,
    database.byteLength,
  );
  return {
    applicationId: view.getUint32(68, false),
    userVersion: view.getUint32(60, false),
  };
}

function assertFitnessIdentity(identity: Readonly<{
  applicationId: number;
  userVersion: number;
}>): void {
  if (
    identity.applicationId !== APPLICATION_ID ||
    identity.userVersion !== USER_VERSION
  ) {
    fail(
      "The SQLite payload is not the supported Fitness database.",
      "UNSUPPORTED_DATABASE_IDENTITY",
    );
  }
}

function checkedAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    fail("The declared backup size is unsafe.", "BACKUP_TOO_LARGE");
  }
  return sum;
}

function unsignedProjection(
  manifest: UnsignedManifest | FitnessBackupManifest,
): UnsignedManifest {
  return {
    format: FORMAT,
    version: VERSION,
    product: PRODUCT,
    exportedAt: manifest.exportedAt,
    database: {
      byteSize: manifest.database.byteSize,
      sha256: manifest.database.sha256,
      applicationId: APPLICATION_ID,
      userVersion: USER_VERSION,
    },
    files: manifest.files.map((metadata) => ({ ...metadata })),
  };
}

function signedManifest(
  manifest: UnsignedManifest,
  manifestSha256: string,
): FitnessBackupManifest {
  return { ...unsignedProjection(manifest), manifestSha256 };
}

function validateManifest(value: unknown): FitnessBackupManifest {
  if (!isRecord(value)) fail("The backup manifest must be an object.", "INVALID_MANIFEST");
  assertExactKeys(
    value,
    [
      "format",
      "version",
      "product",
      "exportedAt",
      "database",
      "files",
      "manifestSha256",
    ],
    "The backup manifest",
  );
  if (
    value.format !== FORMAT ||
    value.version !== VERSION ||
    value.product !== PRODUCT
  ) {
    fail("The backup format, version, or product is unsupported.", "UNSUPPORTED_FORMAT");
  }
  assertIsoTimestamp(value.exportedAt, "manifest.exportedAt");
  if (!isRecord(value.database)) {
    fail("manifest.database must be an object.", "INVALID_MANIFEST");
  }
  assertExactKeys(
    value.database,
    ["byteSize", "sha256", "applicationId", "userVersion"],
    "manifest.database",
  );
  assertSafeInteger(
    value.database.byteSize,
    "manifest.database.byteSize",
    SQLITE_IDENTITY_BYTES,
    FITNESS_BACKUP_LIMITS.databaseBytes,
    "DATABASE_TOO_LARGE",
  );
  assertSha256(value.database.sha256, "manifest.database.sha256");
  if (
    value.database.applicationId !== APPLICATION_ID ||
    value.database.userVersion !== USER_VERSION
  ) {
    fail(
      "The manifest declares an unsupported Fitness database identity.",
      "UNSUPPORTED_DATABASE_IDENTITY",
    );
  }
  if (!Array.isArray(value.files)) {
    fail("manifest.files must be an array.", "INVALID_MANIFEST");
  }
  if (value.files.length > FITNESS_BACKUP_LIMITS.fileCount) {
    fail("The backup contains too many files.", "TOO_MANY_FILES");
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  const files = value.files.map((raw, index) => {
    const metadata = validateFileMetadata(raw, `manifest.files[${index}]`);
    if (ids.has(metadata.id)) {
      fail("The backup contains duplicate file row ids.", "DUPLICATE_FILE_ID");
    }
    if (keys.has(metadata.key)) {
      fail("The backup contains duplicate file keys.", "DUPLICATE_FILE_KEY");
    }
    ids.add(metadata.id);
    keys.add(metadata.key);
    return metadata;
  });
  assertSha256(value.manifestSha256, "manifest.manifestSha256");
  return {
    format: FORMAT,
    version: VERSION,
    product: PRODUCT,
    exportedAt: value.exportedAt,
    database: {
      byteSize: value.database.byteSize,
      sha256: value.database.sha256,
      applicationId: APPLICATION_ID,
      userVersion: USER_VERSION,
    },
    files,
    manifestSha256: value.manifestSha256,
  };
}

async function trustedHash(blob: Blob, hashBlob: FitnessBackupHashBlob) {
  let digest: unknown;
  try {
    digest = await hashBlob(blob);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    fail(`SHA-256 calculation failed.${detail}`, "HASH_FAILED");
  }
  if (typeof digest !== "string" || !SHA256_PATTERN.test(digest)) {
    fail("The hash function returned an invalid digest.", "HASH_FAILED");
  }
  return digest;
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function manifestLengthBytes(length: number) {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, length, false);
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

export async function createFitnessBackupBlob(
  input: CreateFitnessBackupInput,
  hashBlob: FitnessBackupHashBlob,
): Promise<Blob> {
  if (!isRecord(input) || !(input.database instanceof Uint8Array)) {
    fail("The backup database must be a Uint8Array.", "INVALID_INPUT");
  }
  assertExactKeys(
    input,
    input.exportedAt === undefined
      ? ["database", "files"]
      : ["database", "files", "exportedAt"],
    "The backup input",
  );
  if (!Array.isArray(input.files) || typeof hashBlob !== "function") {
    fail("The backup file list or hash function is invalid.", "INVALID_INPUT");
  }
  if (input.database.byteLength > FITNESS_BACKUP_LIMITS.databaseBytes) {
    fail("The database exceeds the backup safety limit.", "DATABASE_TOO_LARGE");
  }
  if (input.files.length > FITNESS_BACKUP_LIMITS.fileCount) {
    fail("The backup contains too many files.", "TOO_MANY_FILES");
  }
  const identity = readSqliteIdentity(input.database);
  assertFitnessIdentity(identity);
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  assertIsoTimestamp(exportedAt, "exportedAt");
  const databaseBlob = new Blob([copyBuffer(input.database)]);
  const ids = new Set<string>();
  const keys = new Set<string>();
  const prepared = input.files.map((entry, index) => {
    if (!isRecord(entry) || !(entry.blob instanceof Blob)) {
      fail(`files[${index}] must contain a Blob.`, "INVALID_INPUT");
    }
    assertExactKeys(entry, ["metadata", "blob"], `files[${index}]`);
    const metadata = validateFileMetadata(
      entry.metadata,
      `files[${index}].metadata`,
    );
    if (ids.has(metadata.id)) {
      fail("The backup contains duplicate file row ids.", "DUPLICATE_FILE_ID");
    }
    if (keys.has(metadata.key)) {
      fail("The backup contains duplicate file keys.", "DUPLICATE_FILE_KEY");
    }
    ids.add(metadata.id);
    keys.add(metadata.key);
    if (entry.blob.size !== metadata.byteSize) {
      fail(
        `File ${metadata.originalName} has the wrong size.`,
        "FILE_SIZE_MISMATCH",
      );
    }
    return { metadata, blob: entry.blob };
  });

  let payloadBytes = databaseBlob.size;
  for (const entry of prepared) payloadBytes = checkedAdd(payloadBytes, entry.blob.size);
  if (payloadBytes > FITNESS_BACKUP_LIMITS.totalBytes) {
    fail("The backup exceeds the total size limit.", "BACKUP_TOO_LARGE");
  }

  const placeholder: UnsignedManifest = {
    format: FORMAT,
    version: VERSION,
    product: PRODUCT,
    exportedAt,
    database: {
      byteSize: databaseBlob.size,
      sha256: "0".repeat(64),
      applicationId: APPLICATION_ID,
      userVersion: USER_VERSION,
    },
    files: prepared.map(({ metadata }) => metadata),
  };
  const placeholderBytes = encoder.encode(
    JSON.stringify(signedManifest(placeholder, "0".repeat(64))),
  ).byteLength;
  if (placeholderBytes > FITNESS_BACKUP_LIMITS.manifestBytes) {
    fail("The backup manifest exceeds the safety limit.", "MANIFEST_TOO_LARGE");
  }
  if (
    checkedAdd(
      checkedAdd(FITNESS_BACKUP_PREFIX_BYTES, placeholderBytes),
      payloadBytes,
    ) > FITNESS_BACKUP_LIMITS.totalBytes
  ) {
    fail("The backup exceeds the total size limit.", "BACKUP_TOO_LARGE");
  }

  const files: FitnessBackupFileMetadata[] = [];
  for (const entry of prepared) {
    const digest = await trustedHash(entry.blob, hashBlob);
    if (digest !== entry.metadata.sha256) {
      fail(
        `File ${entry.metadata.originalName} failed its SHA-256 check.`,
        "FILE_HASH_MISMATCH",
      );
    }
    files.push({ ...entry.metadata, sha256: digest });
  }
  const unsigned: UnsignedManifest = {
    ...placeholder,
    database: {
      ...placeholder.database,
      sha256: await trustedHash(databaseBlob, hashBlob),
    },
    files,
  };
  const unsignedBytes = encoder.encode(JSON.stringify(unsignedProjection(unsigned)));
  const manifest = signedManifest(
    unsigned,
    await trustedHash(new Blob([copyBuffer(unsignedBytes)]), hashBlob),
  );
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  if (manifestBytes.byteLength > FITNESS_BACKUP_LIMITS.manifestBytes) {
    fail("The backup manifest exceeds the safety limit.", "MANIFEST_TOO_LARGE");
  }
  const total = checkedAdd(
    checkedAdd(FITNESS_BACKUP_PREFIX_BYTES, manifestBytes.byteLength),
    payloadBytes,
  );
  if (total > FITNESS_BACKUP_LIMITS.totalBytes) {
    fail("The backup exceeds the total size limit.", "BACKUP_TOO_LARGE");
  }

  return new Blob(
    [
      copyBuffer(magicBytes),
      copyBuffer(manifestLengthBytes(manifestBytes.byteLength)),
      copyBuffer(manifestBytes),
      databaseBlob,
      ...prepared.map(({ blob }) => blob),
    ],
    { type: FITNESS_BACKUP_MIME_TYPE },
  );
}

export async function parseFitnessBackupBlob(
  blob: Blob,
  hashBlob: FitnessBackupHashBlob,
): Promise<ParsedFitnessBackup> {
  if (!(blob instanceof Blob) || typeof hashBlob !== "function") {
    fail("The backup input is invalid.", "INVALID_INPUT");
  }
  if (blob.size > FITNESS_BACKUP_LIMITS.totalBytes) {
    fail("The backup exceeds the total size limit.", "BACKUP_TOO_LARGE");
  }
  if (blob.size < FITNESS_BACKUP_PREFIX_BYTES) {
    fail("The file is too short to be a Fitness backup.", "INVALID_MAGIC");
  }
  const prefix = new Uint8Array(
    await blob.slice(0, FITNESS_BACKUP_PREFIX_BYTES).arrayBuffer(),
  );
  if (!equalBytes(prefix.subarray(0, magicBytes.byteLength), magicBytes)) {
    fail("The file does not have Fitness backup magic bytes.", "INVALID_MAGIC");
  }
  const manifestLength = new DataView(
    prefix.buffer,
    prefix.byteOffset + magicBytes.byteLength,
    4,
  ).getUint32(0, false);
  if (manifestLength === 0) {
    fail("The manifest is empty.", "INVALID_MANIFEST_LENGTH");
  }
  if (manifestLength > FITNESS_BACKUP_LIMITS.manifestBytes) {
    fail("The manifest exceeds the safety limit.", "MANIFEST_TOO_LARGE");
  }
  const manifestStart = FITNESS_BACKUP_PREFIX_BYTES;
  const manifestEnd = checkedAdd(manifestStart, manifestLength);
  if (manifestEnd > blob.size) {
    fail("The manifest extends beyond the file.", "SIZE_MISMATCH");
  }
  const manifestBytes = new Uint8Array(
    await blob.slice(manifestStart, manifestEnd).arrayBuffer(),
  );
  let manifestText: string;
  try {
    manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  } catch {
    fail("The manifest is not valid UTF-8.", "INVALID_MANIFEST");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch {
    fail("The manifest is not valid JSON.", "INVALID_MANIFEST");
  }
  const manifest = validateManifest(raw);
  if (!equalBytes(manifestBytes, encoder.encode(JSON.stringify(manifest)))) {
    fail("The manifest is not canonical.", "INVALID_MANIFEST");
  }

  let expected = checkedAdd(manifestEnd, manifest.database.byteSize);
  for (const metadata of manifest.files) {
    expected = checkedAdd(expected, metadata.byteSize);
  }
  if (expected > FITNESS_BACKUP_LIMITS.totalBytes) {
    fail("The declared backup exceeds the total size limit.", "BACKUP_TOO_LARGE");
  }
  if (expected !== blob.size) {
    fail("The backup size does not match its manifest.", "SIZE_MISMATCH");
  }

  const unsignedBytes = encoder.encode(JSON.stringify(unsignedProjection(manifest)));
  const manifestDigest = await trustedHash(
    new Blob([copyBuffer(unsignedBytes)]),
    hashBlob,
  );
  if (manifestDigest !== manifest.manifestSha256) {
    fail("The manifest SHA-256 digest does not match.", "MANIFEST_HASH_MISMATCH");
  }

  const databaseStart = manifestEnd;
  const databaseEnd = databaseStart + manifest.database.byteSize;
  const databaseBlob = blob.slice(databaseStart, databaseEnd);
  const identity = readSqliteIdentity(
    new Uint8Array(
      await databaseBlob.slice(0, SQLITE_IDENTITY_BYTES).arrayBuffer(),
    ),
  );
  if (
    identity.applicationId !== manifest.database.applicationId ||
    identity.userVersion !== manifest.database.userVersion
  ) {
    fail("The SQLite identity does not match the manifest.", "DATABASE_IDENTITY_MISMATCH");
  }
  assertFitnessIdentity(identity);
  if (await trustedHash(databaseBlob, hashBlob) !== manifest.database.sha256) {
    fail("The database SHA-256 digest does not match.", "DATABASE_HASH_MISMATCH");
  }

  const files: Array<{ metadata: FitnessBackupFileMetadata; blob: Blob }> = [];
  let offset = databaseEnd;
  for (const metadata of manifest.files) {
    const end = offset + metadata.byteSize;
    const segment = blob.slice(offset, end, metadata.mimeType);
    if (await trustedHash(segment, hashBlob) !== metadata.sha256) {
      fail(
        `File ${metadata.originalName} failed its SHA-256 check.`,
        "FILE_HASH_MISMATCH",
      );
    }
    files.push({ metadata, blob: segment });
    offset = end;
  }

  return {
    manifest,
    database: new Uint8Array(await databaseBlob.arrayBuffer()),
    files,
  };
}
