const FORMAT = "vocab-backup" as const;
const VERSION = 1 as const;
const PRODUCT = "shici" as const;
const MAGIC = "VOCAB-BACKUP\r\n\u001a";
const SQLITE_HEADER = "SQLite format 3\u0000";
const SQLITE_IDENTITY_BYTES = 72;
const UINT32_MAX = 0xffff_ffff;

const encoder = new TextEncoder();
const magicBytes = encoder.encode(MAGIC);
const sqliteHeaderBytes = encoder.encode(SQLITE_HEADER);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIME_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

export const VOCAB_BACKUP_MAGIC = MAGIC;
export const VOCAB_BACKUP_MIME_TYPE = "application/vnd.shici.vocab-backup";
export const VOCAB_BACKUP_PREFIX_BYTES = magicBytes.byteLength + 4;
export const VOCAB_BACKUP_LIMITS = Object.freeze({
  manifestBytes: 2 * 1024 * 1024,
  databaseBytes: 512 * 1024 * 1024,
  audioCount: 1_000,
  audioBytes: 512 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
  originalNameCharacters: 255,
  mimeTypeCharacters: 127,
  categoryCharacters: 255,
});

export type VocabBackupHashBlob = (blob: Blob) => Promise<string>;

export type VocabBackupAudioMetadata = Readonly<{
  key: string;
  originalName: string;
  mimeType: string;
  category: string | null;
  byteSize: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
}>;

export type VocabBackupManifest = Readonly<{
  format: typeof FORMAT;
  version: typeof VERSION;
  product: typeof PRODUCT;
  exportedAt: string;
  database: Readonly<{
    byteSize: number;
    sha256: string;
    applicationId: number;
    userVersion: number;
  }>;
  audio: readonly VocabBackupAudioMetadata[];
  manifestSha256: string;
}>;

type UnsignedManifest = Omit<VocabBackupManifest, "manifestSha256">;

export type VocabBackupAudioInput = Readonly<{
  metadata: VocabBackupAudioMetadata;
  blob: Blob;
}>;

export type ParsedVocabBackup = Readonly<{
  manifest: VocabBackupManifest;
  database: Uint8Array;
  audio: readonly Readonly<{
    metadata: VocabBackupAudioMetadata;
    blob: Blob;
  }>[];
}>;

export class VocabBackupFormatError extends Error {
  constructor(message: string, readonly code = "INVALID_VOCAB_BACKUP") {
    super(message);
    this.name = "VocabBackupFormatError";
  }
}

function fail(message: string, code: string): never {
  throw new VocabBackupFormatError(message, code);
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
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key))
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
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

function assertMime(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > VOCAB_BACKUP_LIMITS.mimeTypeCharacters ||
    !MIME_PATTERN.test(value)
  ) {
    fail(`${label} must be a canonical MIME type.`, "INVALID_MANIFEST");
  }
}

function validateAudioMetadata(
  value: unknown,
  label: string,
  exactKeys: boolean,
): VocabBackupAudioMetadata {
  if (!isRecord(value)) fail(`${label} must be an object.`, "INVALID_MANIFEST");
  if (exactKeys) {
    assertExactKeys(
      value,
      [
        "key",
        "originalName",
        "mimeType",
        "category",
        "byteSize",
        "sha256",
        "createdAt",
        "updatedAt",
      ],
      label,
    );
  }
  assertUuid(value.key, `${label}.key`);
  assertDisplayText(
    value.originalName,
    `${label}.originalName`,
    VOCAB_BACKUP_LIMITS.originalNameCharacters,
  );
  if (
    value.originalName === "." ||
    value.originalName === ".." ||
    value.originalName.includes("/") ||
    value.originalName.includes("\\")
  ) {
    fail(`${label}.originalName is not a safe file name.`, "INVALID_MANIFEST");
  }
  assertMime(value.mimeType, `${label}.mimeType`);
  let category: string | null = null;
  if (value.category !== null) {
    assertDisplayText(
      value.category,
      `${label}.category`,
      VOCAB_BACKUP_LIMITS.categoryCharacters,
    );
    category = value.category;
  }
  assertSafeInteger(
    value.byteSize,
    `${label}.byteSize`,
    0,
    VOCAB_BACKUP_LIMITS.audioBytes,
    "AUDIO_TOO_LARGE",
  );
  assertSha256(value.sha256, `${label}.sha256`);
  assertIsoTimestamp(value.createdAt, `${label}.createdAt`);
  assertIsoTimestamp(value.updatedAt, `${label}.updatedAt`);
  return {
    key: value.key,
    originalName: value.originalName,
    mimeType: value.mimeType,
    category,
    byteSize: value.byteSize,
    sha256: value.sha256,
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

function checkedAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    fail("The declared backup size is unsafe.", "BACKUP_TOO_LARGE");
  }
  return sum;
}

function unsignedProjection(
  manifest: UnsignedManifest | VocabBackupManifest,
): UnsignedManifest {
  return {
    format: FORMAT,
    version: VERSION,
    product: PRODUCT,
    exportedAt: manifest.exportedAt,
    database: {
      byteSize: manifest.database.byteSize,
      sha256: manifest.database.sha256,
      applicationId: manifest.database.applicationId,
      userVersion: manifest.database.userVersion,
    },
    audio: manifest.audio.map((metadata) => ({ ...metadata })),
  };
}

function signedManifest(
  manifest: UnsignedManifest,
  manifestSha256: string,
): VocabBackupManifest {
  return { ...unsignedProjection(manifest), manifestSha256 };
}

function validateManifest(value: unknown): VocabBackupManifest {
  if (!isRecord(value)) fail("The backup manifest must be an object.", "INVALID_MANIFEST");
  assertExactKeys(
    value,
    ["format", "version", "product", "exportedAt", "database", "audio", "manifestSha256"],
    "The backup manifest",
  );
  if (value.format !== FORMAT || value.version !== VERSION || value.product !== PRODUCT) {
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
    VOCAB_BACKUP_LIMITS.databaseBytes,
    "DATABASE_TOO_LARGE",
  );
  assertSha256(value.database.sha256, "manifest.database.sha256");
  assertSafeInteger(
    value.database.applicationId,
    "manifest.database.applicationId",
    0,
    UINT32_MAX,
    "INVALID_MANIFEST",
  );
  assertSafeInteger(
    value.database.userVersion,
    "manifest.database.userVersion",
    0,
    UINT32_MAX,
    "INVALID_MANIFEST",
  );
  if (!Array.isArray(value.audio)) {
    fail("manifest.audio must be an array.", "INVALID_MANIFEST");
  }
  if (value.audio.length > VOCAB_BACKUP_LIMITS.audioCount) {
    fail("The backup contains too many audio files.", "TOO_MANY_AUDIO_FILES");
  }
  const keys = new Set<string>();
  const audio = value.audio.map((raw, index) => {
    const metadata = validateAudioMetadata(raw, `manifest.audio[${index}]`, true);
    if (keys.has(metadata.key)) {
      fail("The backup contains duplicate audio keys.", "DUPLICATE_AUDIO_KEY");
    }
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
      applicationId: value.database.applicationId,
      userVersion: value.database.userVersion,
    },
    audio,
    manifestSha256: value.manifestSha256,
  };
}

async function trustedHash(blob: Blob, hashBlob: VocabBackupHashBlob) {
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

export async function createVocabBackupBlob(
  input: Readonly<{
    database: Uint8Array;
    audio: readonly VocabBackupAudioInput[];
    exportedAt?: string;
  }>,
  hashBlob: VocabBackupHashBlob,
): Promise<Blob> {
  if (!isRecord(input) || !(input.database instanceof Uint8Array)) {
    fail("The backup database must be a Uint8Array.", "INVALID_INPUT");
  }
  if (!Array.isArray(input.audio) || typeof hashBlob !== "function") {
    fail("The backup audio list or hash function is invalid.", "INVALID_INPUT");
  }
  if (input.database.byteLength > VOCAB_BACKUP_LIMITS.databaseBytes) {
    fail("The database exceeds the backup safety limit.", "DATABASE_TOO_LARGE");
  }
  if (input.audio.length > VOCAB_BACKUP_LIMITS.audioCount) {
    fail("The backup contains too many audio files.", "TOO_MANY_AUDIO_FILES");
  }
  const identity = readSqliteIdentity(input.database);
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  assertIsoTimestamp(exportedAt, "exportedAt");
  const databaseBlob = new Blob([copyBuffer(input.database)]);
  const keys = new Set<string>();
  const prepared = input.audio.map((entry, index) => {
    if (!isRecord(entry) || !(entry.blob instanceof Blob)) {
      fail(`audio[${index}] must contain a Blob.`, "INVALID_INPUT");
    }
    const metadata = validateAudioMetadata(entry.metadata, `audio[${index}].metadata`, false);
    if (keys.has(metadata.key)) {
      fail("The backup contains duplicate audio keys.", "DUPLICATE_AUDIO_KEY");
    }
    keys.add(metadata.key);
    if (entry.blob.size !== metadata.byteSize) {
      fail(`Audio ${metadata.originalName} has the wrong size.`, "AUDIO_SIZE_MISMATCH");
    }
    return { metadata, blob: entry.blob };
  });

  let payloadBytes = databaseBlob.size;
  for (const entry of prepared) payloadBytes = checkedAdd(payloadBytes, entry.blob.size);
  if (payloadBytes > VOCAB_BACKUP_LIMITS.totalBytes) {
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
      applicationId: identity.applicationId,
      userVersion: identity.userVersion,
    },
    audio: prepared.map(({ metadata }) => metadata),
  };
  const placeholderBytes = encoder.encode(
    JSON.stringify(signedManifest(placeholder, "0".repeat(64))),
  ).byteLength;
  if (placeholderBytes > VOCAB_BACKUP_LIMITS.manifestBytes) {
    fail("The backup manifest exceeds the safety limit.", "MANIFEST_TOO_LARGE");
  }
  if (
    checkedAdd(checkedAdd(VOCAB_BACKUP_PREFIX_BYTES, placeholderBytes), payloadBytes) >
    VOCAB_BACKUP_LIMITS.totalBytes
  ) {
    fail("The backup exceeds the total size limit.", "BACKUP_TOO_LARGE");
  }

  const audio: VocabBackupAudioMetadata[] = [];
  for (const entry of prepared) {
    const digest = await trustedHash(entry.blob, hashBlob);
    if (digest !== entry.metadata.sha256) {
      fail(`Audio ${entry.metadata.originalName} failed its SHA-256 check.`, "AUDIO_HASH_MISMATCH");
    }
    audio.push({ ...entry.metadata, sha256: digest });
  }
  const unsigned: UnsignedManifest = {
    ...placeholder,
    database: {
      ...placeholder.database,
      sha256: await trustedHash(databaseBlob, hashBlob),
    },
    audio,
  };
  const unsignedBytes = encoder.encode(JSON.stringify(unsignedProjection(unsigned)));
  const manifest = signedManifest(
    unsigned,
    await trustedHash(new Blob([copyBuffer(unsignedBytes)]), hashBlob),
  );
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  if (manifestBytes.byteLength > VOCAB_BACKUP_LIMITS.manifestBytes) {
    fail("The backup manifest exceeds the safety limit.", "MANIFEST_TOO_LARGE");
  }
  const total = checkedAdd(
    checkedAdd(VOCAB_BACKUP_PREFIX_BYTES, manifestBytes.byteLength),
    payloadBytes,
  );
  if (total > VOCAB_BACKUP_LIMITS.totalBytes) {
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
    { type: VOCAB_BACKUP_MIME_TYPE },
  );
}

export async function parseVocabBackupBlob(
  blob: Blob,
  hashBlob: VocabBackupHashBlob,
): Promise<ParsedVocabBackup> {
  if (!(blob instanceof Blob) || typeof hashBlob !== "function") {
    fail("The backup input is invalid.", "INVALID_INPUT");
  }
  if (blob.size > VOCAB_BACKUP_LIMITS.totalBytes) {
    fail("The backup exceeds the total size limit.", "BACKUP_TOO_LARGE");
  }
  if (blob.size < VOCAB_BACKUP_PREFIX_BYTES) {
    fail("The file is too short to be a Vocabulary backup.", "INVALID_MAGIC");
  }
  const prefix = new Uint8Array(
    await blob.slice(0, VOCAB_BACKUP_PREFIX_BYTES).arrayBuffer(),
  );
  if (!equalBytes(prefix.subarray(0, magicBytes.byteLength), magicBytes)) {
    fail("The file does not have Vocabulary backup magic bytes.", "INVALID_MAGIC");
  }
  const manifestLength = new DataView(
    prefix.buffer,
    prefix.byteOffset + magicBytes.byteLength,
    4,
  ).getUint32(0, false);
  if (manifestLength === 0) fail("The manifest is empty.", "INVALID_MANIFEST_LENGTH");
  if (manifestLength > VOCAB_BACKUP_LIMITS.manifestBytes) {
    fail("The manifest exceeds the safety limit.", "MANIFEST_TOO_LARGE");
  }
  const manifestStart = VOCAB_BACKUP_PREFIX_BYTES;
  const manifestEnd = checkedAdd(manifestStart, manifestLength);
  if (manifestEnd > blob.size) fail("The manifest extends beyond the file.", "SIZE_MISMATCH");
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
  for (const metadata of manifest.audio) expected = checkedAdd(expected, metadata.byteSize);
  if (expected > VOCAB_BACKUP_LIMITS.totalBytes) {
    fail("The declared backup exceeds the total size limit.", "BACKUP_TOO_LARGE");
  }
  if (expected !== blob.size) fail("The backup size does not match its manifest.", "SIZE_MISMATCH");

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
    new Uint8Array(await databaseBlob.slice(0, SQLITE_IDENTITY_BYTES).arrayBuffer()),
  );
  if (
    identity.applicationId !== manifest.database.applicationId ||
    identity.userVersion !== manifest.database.userVersion
  ) {
    fail("The SQLite identity does not match the manifest.", "DATABASE_IDENTITY_MISMATCH");
  }
  if (await trustedHash(databaseBlob, hashBlob) !== manifest.database.sha256) {
    fail("The database SHA-256 digest does not match.", "DATABASE_HASH_MISMATCH");
  }

  const audio: Array<{ metadata: VocabBackupAudioMetadata; blob: Blob }> = [];
  let offset = databaseEnd;
  for (const metadata of manifest.audio) {
    const end = offset + metadata.byteSize;
    const segment = blob.slice(offset, end, metadata.mimeType);
    if (await trustedHash(segment, hashBlob) !== metadata.sha256) {
      fail(`Audio ${metadata.originalName} failed its SHA-256 check.`, "AUDIO_HASH_MISMATCH");
    }
    audio.push({ metadata, blob: segment });
    offset = end;
  }
  return {
    manifest,
    database: new Uint8Array(await databaseBlob.arrayBuffer()),
    audio,
  };
}
