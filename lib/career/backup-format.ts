const FORMAT = "career-backup" as const;
const VERSION = 1 as const;
const PRODUCT = "zhiji" as const;
const MAGIC = "CAREER-BACKUP\r\n\u001a";
const SQLITE_HEADER = "SQLite format 3\u0000";
const SQLITE_IDENTITY_BYTE_SIZE = 72;
const UINT32_MAX = 0xffff_ffff;

const textEncoder = new TextEncoder();
const magicBytes = textEncoder.encode(MAGIC);
const sqliteHeaderBytes = textEncoder.encode(SQLITE_HEADER);

export const CAREER_BACKUP_MAGIC = MAGIC;
export const CAREER_BACKUP_MIME_TYPE =
  "application/vnd.zhiji.career-backup";
export const CAREER_BACKUP_PREFIX_BYTE_SIZE = magicBytes.byteLength + 4;
export const CAREER_BACKUP_LIMITS = Object.freeze({
  manifestBytes: 2 * 1024 * 1024,
  databaseBytes: 512 * 1024 * 1024,
  attachmentCount: 1_000,
  attachmentBytes: 512 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
  originalNameCharacters: 255,
  mimeTypeCharacters: 127,
  categoryCharacters: 255,
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MIME_TYPE_PATTERN =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

export type CareerBackupHashBlob = (blob: Blob) => Promise<string>;

export type CareerBackupAttachmentMetadata = Readonly<{
  key: string;
  originalName: string;
  mimeType: string;
  category: string | null;
  byteSize: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
}>;

export type CareerBackupManifest = Readonly<{
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
  attachments: readonly CareerBackupAttachmentMetadata[];
  manifestSha256: string;
}>;

type UnsignedCareerBackupManifest = Omit<
  CareerBackupManifest,
  "manifestSha256"
>;

type SqliteIdentity = Readonly<{
  applicationId: number;
  userVersion: number;
}>;

export type CareerBackupAttachmentInput = Readonly<{
  metadata: CareerBackupAttachmentMetadata;
  blob: Blob;
}>;

export type CreateCareerBackupInput = Readonly<{
  database: Uint8Array;
  attachments: readonly CareerBackupAttachmentInput[];
  exportedAt?: string;
}>;

export type ParsedCareerBackup = Readonly<{
  manifest: CareerBackupManifest;
  database: Uint8Array;
  attachments: readonly Readonly<{
    metadata: CareerBackupAttachmentMetadata;
    blob: Blob;
  }>[];
}>;

export class CareerBackupFormatError extends Error {
  constructor(
    message: string,
    readonly code = "INVALID_CAREER_BACKUP",
  ) {
    super(message);
    this.name = "CareerBackupFormatError";
  }
}

function fail(message: string, code: string): never {
  throw new CareerBackupFormatError(message, code);
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
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(`${label} must be a safe integer.`, "INVALID_MANIFEST");
  }
  if (value < minimum) {
    fail(`${label} is below the supported minimum.`, "INVALID_MANIFEST");
  }
  if (value > maximum) {
    fail(`${label} exceeds the safety limit.`, tooLargeCode);
  }
}

function assertCanonicalIsoDate(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length !== 24) {
    fail(`${label} must be an ISO-8601 timestamp.`, "INVALID_MANIFEST");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp.`, "INVALID_MANIFEST");
  }
}

function assertDisplayString(
  value: unknown,
  label: string,
  maximumLength: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    fail(`${label} is invalid or too long.`, "INVALID_MANIFEST");
  }
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(`${label} must be a canonical UUID v4.`, "INVALID_MANIFEST");
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest.`, "INVALID_MANIFEST");
  }
}

function assertMimeType(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > CAREER_BACKUP_LIMITS.mimeTypeCharacters ||
    !MIME_TYPE_PATTERN.test(value)
  ) {
    fail(`${label} must be a canonical MIME type.`, "INVALID_MANIFEST");
  }
}

function readSqliteIdentity(bytes: Uint8Array): SqliteIdentity {
  if (bytes.byteLength < SQLITE_IDENTITY_BYTE_SIZE) {
    fail(
      "The database payload is too short to contain a SQLite identity.",
      "INVALID_SQLITE",
    );
  }
  for (let index = 0; index < sqliteHeaderBytes.byteLength; index += 1) {
    if (bytes[index] !== sqliteHeaderBytes[index]) {
      fail("The database payload does not have a SQLite 3 header.", "INVALID_SQLITE");
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    applicationId: view.getUint32(68, false),
    userVersion: view.getUint32(60, false),
  };
}

function checkedAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    fail("The declared backup size is not safe to process.", "BACKUP_TOO_LARGE");
  }
  return sum;
}

function validateAttachmentMetadata(
  value: unknown,
  label: string,
  requireExactKeys: boolean,
): CareerBackupAttachmentMetadata {
  if (!isRecord(value)) {
    fail(`${label} must be an object.`, "INVALID_MANIFEST");
  }
  if (requireExactKeys) {
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
  assertDisplayString(
    value.originalName,
    `${label}.originalName`,
    CAREER_BACKUP_LIMITS.originalNameCharacters,
  );
  if (
    value.originalName === "." ||
    value.originalName === ".." ||
    value.originalName.includes("/") ||
    value.originalName.includes("\\")
  ) {
    fail(`${label}.originalName is not a safe file name.`, "INVALID_MANIFEST");
  }
  assertMimeType(value.mimeType, `${label}.mimeType`);
  let category: string | null;
  if (value.category === null) {
    category = null;
  } else {
    assertDisplayString(
      value.category,
      `${label}.category`,
      CAREER_BACKUP_LIMITS.categoryCharacters,
    );
    category = value.category;
  }
  assertSafeInteger(
    value.byteSize,
    `${label}.byteSize`,
    0,
    CAREER_BACKUP_LIMITS.attachmentBytes,
    "ATTACHMENT_TOO_LARGE",
  );
  assertSha256(value.sha256, `${label}.sha256`);
  assertCanonicalIsoDate(value.createdAt, `${label}.createdAt`);
  assertCanonicalIsoDate(value.updatedAt, `${label}.updatedAt`);

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

function validateManifest(value: unknown): CareerBackupManifest {
  if (!isRecord(value)) {
    fail("The backup manifest must be an object.", "INVALID_MANIFEST");
  }
  assertExactKeys(
    value,
    [
      "format",
      "version",
      "product",
      "exportedAt",
      "database",
      "attachments",
      "manifestSha256",
    ],
    "The backup manifest",
  );
  if (value.format !== FORMAT || value.version !== VERSION || value.product !== PRODUCT) {
    fail("The backup format, version, or product is unsupported.", "UNSUPPORTED_FORMAT");
  }
  assertCanonicalIsoDate(value.exportedAt, "manifest.exportedAt");

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
    SQLITE_IDENTITY_BYTE_SIZE,
    CAREER_BACKUP_LIMITS.databaseBytes,
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

  if (!Array.isArray(value.attachments)) {
    fail("manifest.attachments must be an array.", "INVALID_MANIFEST");
  }
  if (value.attachments.length > CAREER_BACKUP_LIMITS.attachmentCount) {
    fail("The backup contains too many attachments.", "TOO_MANY_ATTACHMENTS");
  }

  const seenKeys = new Set<string>();
  const attachments = value.attachments.map((attachment, index) => {
    const metadata = validateAttachmentMetadata(
      attachment,
      `manifest.attachments[${index}]`,
      true,
    );
    if (seenKeys.has(metadata.key)) {
      fail("The backup contains duplicate attachment keys.", "DUPLICATE_ATTACHMENT_KEY");
    }
    seenKeys.add(metadata.key);
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
    attachments,
    manifestSha256: value.manifestSha256,
  };
}

function unsignedManifestProjection(
  manifest: UnsignedCareerBackupManifest | CareerBackupManifest,
): UnsignedCareerBackupManifest {
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
    attachments: manifest.attachments.map((metadata) => ({
      key: metadata.key,
      originalName: metadata.originalName,
      mimeType: metadata.mimeType,
      category: metadata.category,
      byteSize: metadata.byteSize,
      sha256: metadata.sha256,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    })),
  };
}

function manifestWithDigest(
  manifest: UnsignedCareerBackupManifest,
  manifestSha256: string,
): CareerBackupManifest {
  return {
    ...unsignedManifestProjection(manifest),
    manifestSha256,
  };
}

async function trustedHash(
  blob: Blob,
  hashBlob: CareerBackupHashBlob,
): Promise<string> {
  let digest: unknown;
  try {
    digest = await hashBlob(blob);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    fail(`SHA-256 calculation failed.${detail}`, "HASH_FAILED");
  }
  if (typeof digest !== "string" || !SHA256_PATTERN.test(digest)) {
    fail("The hash function returned an invalid SHA-256 digest.", "HASH_FAILED");
  }
  return digest;
}

function writeManifestLength(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, byteLength, false);
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * Build a versioned Career backup. Attachment bytes are checked against their
 * OPFS metadata before any backup Blob is returned.
 */
export async function createCareerBackupBlob(
  input: CreateCareerBackupInput,
  hashBlob: CareerBackupHashBlob,
): Promise<Blob> {
  if (!isRecord(input) || !(input.database instanceof Uint8Array)) {
    fail("The backup database must be a Uint8Array.", "INVALID_INPUT");
  }
  if (!Array.isArray(input.attachments)) {
    fail("The backup attachments must be an array.", "INVALID_INPUT");
  }
  if (typeof hashBlob !== "function") {
    fail("A SHA-256 Blob hashing function is required.", "INVALID_INPUT");
  }
  if (input.database.byteLength > CAREER_BACKUP_LIMITS.databaseBytes) {
    fail("The database exceeds the backup safety limit.", "DATABASE_TOO_LARGE");
  }
  const databaseIdentity = readSqliteIdentity(input.database);
  if (input.attachments.length > CAREER_BACKUP_LIMITS.attachmentCount) {
    fail("The backup contains too many attachments.", "TOO_MANY_ATTACHMENTS");
  }

  const exportedAt = input.exportedAt ?? new Date().toISOString();
  assertCanonicalIsoDate(exportedAt, "exportedAt");
  const databaseBlob = new Blob([copyArrayBuffer(input.database)]);

  const seenKeys = new Set<string>();
  const preparedAttachments = input.attachments.map((attachment, index) => {
    if (!isRecord(attachment) || !(attachment.blob instanceof Blob)) {
      fail(`attachments[${index}] must contain a Blob.`, "INVALID_INPUT");
    }
    const metadata = validateAttachmentMetadata(
      attachment.metadata,
      `attachments[${index}].metadata`,
      false,
    );
    if (seenKeys.has(metadata.key)) {
      fail("The backup contains duplicate attachment keys.", "DUPLICATE_ATTACHMENT_KEY");
    }
    seenKeys.add(metadata.key);
    if (attachment.blob.size !== metadata.byteSize) {
      fail(
        `Attachment ${metadata.originalName} does not match its recorded size.`,
        "ATTACHMENT_SIZE_MISMATCH",
      );
    }
    return { metadata, blob: attachment.blob };
  });

  let payloadByteSize = databaseBlob.size;
  for (const attachment of preparedAttachments) {
    payloadByteSize = checkedAdd(payloadByteSize, attachment.blob.size);
  }
  if (payloadByteSize > CAREER_BACKUP_LIMITS.totalBytes) {
    fail("The backup exceeds the total size safety limit.", "BACKUP_TOO_LARGE");
  }

  // Every digest has a fixed 64-character representation, so this placeholder
  // manifest has the exact final byte length. Reject oversized exports before
  // spending time hashing any potentially large payload.
  const preflightUnsignedManifest: UnsignedCareerBackupManifest = {
    format: FORMAT,
    version: VERSION,
    product: PRODUCT,
    exportedAt,
    database: {
      byteSize: databaseBlob.size,
      sha256: "0".repeat(64),
      applicationId: databaseIdentity.applicationId,
      userVersion: databaseIdentity.userVersion,
    },
    attachments: preparedAttachments.map((attachment) => attachment.metadata),
  };
  const preflightManifest = manifestWithDigest(
    preflightUnsignedManifest,
    "0".repeat(64),
  );
  const preflightManifestByteSize = textEncoder.encode(
    JSON.stringify(preflightManifest),
  ).byteLength;
  if (preflightManifestByteSize > CAREER_BACKUP_LIMITS.manifestBytes) {
    fail("The backup manifest exceeds the safety limit.", "MANIFEST_TOO_LARGE");
  }
  const preflightTotalByteSize = checkedAdd(
    checkedAdd(CAREER_BACKUP_PREFIX_BYTE_SIZE, preflightManifestByteSize),
    payloadByteSize,
  );
  if (preflightTotalByteSize > CAREER_BACKUP_LIMITS.totalBytes) {
    fail("The backup exceeds the total size safety limit.", "BACKUP_TOO_LARGE");
  }

  const databaseSha256 = await trustedHash(databaseBlob, hashBlob);
  const manifestAttachments: CareerBackupAttachmentMetadata[] = [];
  for (const attachment of preparedAttachments) {
    const sha256 = await trustedHash(attachment.blob, hashBlob);
    if (sha256 !== attachment.metadata.sha256) {
      fail(
        `Attachment ${attachment.metadata.originalName} failed its SHA-256 check.`,
        "ATTACHMENT_HASH_MISMATCH",
      );
    }
    manifestAttachments.push({ ...attachment.metadata, sha256 });
  }

  const unsignedManifest: UnsignedCareerBackupManifest = {
    format: FORMAT,
    version: VERSION,
    product: PRODUCT,
    exportedAt,
    database: {
      byteSize: databaseBlob.size,
      sha256: databaseSha256,
      applicationId: databaseIdentity.applicationId,
      userVersion: databaseIdentity.userVersion,
    },
    attachments: manifestAttachments,
  };
  const unsignedManifestBytes = textEncoder.encode(
    JSON.stringify(unsignedManifestProjection(unsignedManifest)),
  );
  const manifestSha256 = await trustedHash(
    new Blob([copyArrayBuffer(unsignedManifestBytes)]),
    hashBlob,
  );
  const manifest = manifestWithDigest(unsignedManifest, manifestSha256);
  const manifestBytes = textEncoder.encode(JSON.stringify(manifest));
  if (manifestBytes.byteLength > CAREER_BACKUP_LIMITS.manifestBytes) {
    fail("The backup manifest exceeds the safety limit.", "MANIFEST_TOO_LARGE");
  }
  const totalByteSize = checkedAdd(
    checkedAdd(CAREER_BACKUP_PREFIX_BYTE_SIZE, manifestBytes.byteLength),
    payloadByteSize,
  );
  if (totalByteSize > CAREER_BACKUP_LIMITS.totalBytes) {
    fail("The backup exceeds the total size safety limit.", "BACKUP_TOO_LARGE");
  }

  return new Blob(
    [
      copyArrayBuffer(magicBytes),
      copyArrayBuffer(writeManifestLength(manifestBytes.byteLength)),
      copyArrayBuffer(manifestBytes),
      databaseBlob,
      ...preparedAttachments.map((attachment) => attachment.blob),
    ],
    { type: CAREER_BACKUP_MIME_TYPE },
  );
}

/**
 * Parse and fully authenticate every payload segment before exposing database
 * bytes or attachment slices to the caller.
 */
export async function parseCareerBackupBlob(
  blob: Blob,
  hashBlob: CareerBackupHashBlob,
): Promise<ParsedCareerBackup> {
  if (!(blob instanceof Blob)) {
    fail("The backup must be a Blob.", "INVALID_INPUT");
  }
  if (typeof hashBlob !== "function") {
    fail("A SHA-256 Blob hashing function is required.", "INVALID_INPUT");
  }
  if (blob.size > CAREER_BACKUP_LIMITS.totalBytes) {
    fail("The backup exceeds the total size safety limit.", "BACKUP_TOO_LARGE");
  }
  if (blob.size < CAREER_BACKUP_PREFIX_BYTE_SIZE) {
    fail("The file is too short to be a Career backup.", "INVALID_MAGIC");
  }

  const prefix = new Uint8Array(
    await blob.slice(0, CAREER_BACKUP_PREFIX_BYTE_SIZE).arrayBuffer(),
  );
  if (!equalBytes(prefix.subarray(0, magicBytes.byteLength), magicBytes)) {
    fail("The file does not have the Career backup magic bytes.", "INVALID_MAGIC");
  }
  const manifestByteLength = new DataView(
    prefix.buffer,
    prefix.byteOffset + magicBytes.byteLength,
    4,
  ).getUint32(0, false);
  if (manifestByteLength === 0) {
    fail("The backup manifest is empty.", "INVALID_MANIFEST_LENGTH");
  }
  if (manifestByteLength > CAREER_BACKUP_LIMITS.manifestBytes) {
    fail("The backup manifest exceeds the safety limit.", "MANIFEST_TOO_LARGE");
  }

  const manifestStart = CAREER_BACKUP_PREFIX_BYTE_SIZE;
  const manifestEnd = checkedAdd(manifestStart, manifestByteLength);
  if (manifestEnd > blob.size) {
    fail("The declared manifest extends beyond the file.", "SIZE_MISMATCH");
  }
  const manifestBytes = new Uint8Array(
    await blob.slice(manifestStart, manifestEnd).arrayBuffer(),
  );

  let manifestJson: string;
  try {
    manifestJson = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  } catch {
    fail("The backup manifest is not valid UTF-8.", "INVALID_MANIFEST");
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(manifestJson);
  } catch {
    fail("The backup manifest is not valid JSON.", "INVALID_MANIFEST");
  }
  const manifest = validateManifest(parsedManifest);
  const canonicalManifestBytes = textEncoder.encode(JSON.stringify(manifest));
  if (!equalBytes(manifestBytes, canonicalManifestBytes)) {
    fail("The backup manifest is not in canonical form.", "INVALID_MANIFEST");
  }

  let expectedSize = checkedAdd(manifestEnd, manifest.database.byteSize);
  if (expectedSize > CAREER_BACKUP_LIMITS.totalBytes) {
    fail("The declared backup exceeds the total size safety limit.", "BACKUP_TOO_LARGE");
  }
  for (const attachment of manifest.attachments) {
    expectedSize = checkedAdd(expectedSize, attachment.byteSize);
    if (expectedSize > CAREER_BACKUP_LIMITS.totalBytes) {
      fail("The declared backup exceeds the total size safety limit.", "BACKUP_TOO_LARGE");
    }
  }
  if (expectedSize !== blob.size) {
    fail("The backup size does not match its manifest.", "SIZE_MISMATCH");
  }

  const unsignedManifestBytes = textEncoder.encode(
    JSON.stringify(unsignedManifestProjection(manifest)),
  );
  const manifestDigest = await trustedHash(
    new Blob([copyArrayBuffer(unsignedManifestBytes)]),
    hashBlob,
  );
  if (manifestDigest !== manifest.manifestSha256) {
    fail("The manifest SHA-256 digest does not match.", "MANIFEST_HASH_MISMATCH");
  }

  const databaseStart = manifestEnd;
  const databaseEnd = databaseStart + manifest.database.byteSize;
  const databaseBlob = blob.slice(databaseStart, databaseEnd);
  const sqliteIdentityBytes = new Uint8Array(
    await databaseBlob.slice(0, SQLITE_IDENTITY_BYTE_SIZE).arrayBuffer(),
  );
  const databaseIdentity = readSqliteIdentity(sqliteIdentityBytes);
  if (
    databaseIdentity.applicationId !== manifest.database.applicationId ||
    databaseIdentity.userVersion !== manifest.database.userVersion
  ) {
    fail(
      "The SQLite application ID or user version does not match the manifest.",
      "DATABASE_IDENTITY_MISMATCH",
    );
  }

  const attachmentSegments: Array<{
    metadata: CareerBackupAttachmentMetadata;
    blob: Blob;
  }> = [];
  let attachmentOffset = databaseEnd;
  for (const metadata of manifest.attachments) {
    const end = attachmentOffset + metadata.byteSize;
    attachmentSegments.push({
      metadata,
      blob: blob.slice(attachmentOffset, end, metadata.mimeType),
    });
    attachmentOffset = end;
  }

  const databaseDigest = await trustedHash(databaseBlob, hashBlob);
  if (databaseDigest !== manifest.database.sha256) {
    fail("The database SHA-256 digest does not match.", "DATABASE_HASH_MISMATCH");
  }
  for (const attachment of attachmentSegments) {
    const digest = await trustedHash(attachment.blob, hashBlob);
    if (digest !== attachment.metadata.sha256) {
      fail(
        `Attachment ${attachment.metadata.originalName} failed its SHA-256 check.`,
        "ATTACHMENT_HASH_MISMATCH",
      );
    }
  }

  const database = new Uint8Array(await databaseBlob.arrayBuffer());
  return {
    manifest,
    database,
    attachments: attachmentSegments,
  };
}
