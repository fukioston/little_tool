import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

async function loadStandaloneTypeScriptModule(relativePath) {
  const source = await readFile(new URL(relativePath, projectRoot), "utf8");
  const { outputText, diagnostics = [] } = ts.transpileModule(source, {
    fileName: relativePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  assert.deepEqual(
    diagnostics.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  const sourceUrl = `\n//# sourceURL=${relativePath.replaceAll(" ", "%20")}`;
  const encoded = Buffer.from(`${outputText}${sourceUrl}`).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

const backupFormat = await loadStandaloneTypeScriptModule(
  "lib/career/backup-format.ts",
);
const {
  CAREER_BACKUP_LIMITS,
  CAREER_BACKUP_MAGIC,
  CAREER_BACKUP_MIME_TYPE,
  CAREER_BACKUP_PREFIX_BYTE_SIZE,
  createCareerBackupBlob,
  parseCareerBackupBlob,
} = backupFormat;

const encoder = new TextEncoder();
const magicBytes = encoder.encode(CAREER_BACKUP_MAGIC);
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EXPORTED_AT = "2026-08-21T02:03:04.000Z";
const APPLICATION_ID = 0x5a48_4a49;
const USER_VERSION = 1;

async function hashBlob(blob) {
  return createHash("sha256")
    .update(Buffer.from(await blob.arrayBuffer()))
    .digest("hex");
}

function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function sqliteBytes(
  label = "career-db",
  { applicationId = APPLICATION_ID, userVersion = USER_VERSION } = {},
) {
  const suffix = encoder.encode(label);
  const bytes = new Uint8Array(100 + suffix.byteLength);
  bytes.set(encoder.encode("SQLite format 3\u0000"));
  const view = new DataView(bytes.buffer);
  view.setUint32(60, userVersion, false);
  view.setUint32(68, applicationId, false);
  bytes.set(suffix, 100);
  return bytes;
}

async function attachment({
  index,
  name,
  type = "application/octet-stream",
  category = "career-material",
  content,
  createdAt = "2026-08-20T01:00:00.000Z",
  updatedAt = "2026-08-21T01:00:00.000Z",
}) {
  const blob = new Blob([content], { type });
  return {
    metadata: {
      key: uuid(index),
      originalName: name,
      mimeType: type,
      category,
      byteSize: blob.size,
      sha256: await hashBlob(blob),
      createdAt,
      updatedAt,
    },
    blob,
  };
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.name, "CareerBackupFormatError");
    assert.equal(error?.code, code);
    return true;
  });
}

async function inspectContainer(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const manifestLength = new DataView(
    bytes.buffer,
    bytes.byteOffset + magicBytes.byteLength,
    4,
  ).getUint32(0, false);
  const manifestStart = CAREER_BACKUP_PREFIX_BYTE_SIZE;
  const manifestEnd = manifestStart + manifestLength;
  const manifest = JSON.parse(
    new TextDecoder().decode(bytes.subarray(manifestStart, manifestEnd)),
  );
  const databaseStart = manifestEnd;
  const databaseEnd = databaseStart + manifest.database.byteSize;
  const attachmentBytes = [];
  let offset = databaseEnd;
  for (const metadata of manifest.attachments) {
    attachmentBytes.push(bytes.slice(offset, offset + metadata.byteSize));
    offset += metadata.byteSize;
  }
  return {
    bytes,
    manifest,
    manifestStart,
    manifestEnd,
    databaseStart,
    databaseEnd,
    databaseBytes: bytes.slice(databaseStart, databaseEnd),
    attachmentBytes,
  };
}

function assembleContainer(manifest, databaseBytes, attachmentBytes = []) {
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  const lengthBytes = new Uint8Array(4);
  new DataView(lengthBytes.buffer).setUint32(0, manifestBytes.byteLength, false);
  return new Blob([
    magicBytes,
    lengthBytes,
    manifestBytes,
    databaseBytes,
    ...attachmentBytes,
  ]);
}

function unsignedManifestProjection(manifest) {
  return {
    format: manifest.format,
    version: manifest.version,
    product: manifest.product,
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

async function resignManifest(manifest) {
  manifest.manifestSha256 = await hashBlob(
    new Blob([JSON.stringify(unsignedManifestProjection(manifest))]),
  );
  return manifest;
}

async function baseBackup(attachments = []) {
  return createCareerBackupBlob(
    { database: sqliteBytes(), attachments, exportedAt: EXPORTED_AT },
    hashBlob,
  );
}

test("zero-attachment backups round-trip with a versioned manifest", async () => {
  let hashCalls = 0;
  const countingHash = async (blob) => {
    hashCalls += 1;
    return hashBlob(blob);
  };
  const database = sqliteBytes("empty attachment set");
  const backup = await createCareerBackupBlob(
    { database, attachments: [], exportedAt: EXPORTED_AT },
    countingHash,
  );

  assert.equal(backup.type, CAREER_BACKUP_MIME_TYPE);
  assert.equal(hashCalls, 2, "database and unsigned manifest were hashed");

  const parsed = await parseCareerBackupBlob(backup, countingHash);
  assert.equal(hashCalls, 4, "manifest integrity was checked before database bytes");
  assert.deepEqual(parsed.database, database);
  assert.deepEqual(parsed.attachments, []);
  assert.equal(parsed.manifest.format, "career-backup");
  assert.equal(parsed.manifest.version, 1);
  assert.equal(parsed.manifest.product, "zhiji");
  assert.equal(parsed.manifest.exportedAt, EXPORTED_AT);
  assert.equal(parsed.manifest.database.byteSize, database.byteLength);
  assert.equal(parsed.manifest.database.sha256, await hashBlob(new Blob([database])));
  assert.equal(parsed.manifest.database.applicationId, APPLICATION_ID);
  assert.equal(parsed.manifest.database.userVersion, USER_VERSION);
  assert.match(parsed.manifest.manifestSha256, /^[0-9a-f]{64}$/);
});

test("Unicode metadata and multiple ordered attachments round-trip exactly", async () => {
  const sources = [
    await attachment({
      index: 1,
      name: "产品设计简历·秋招.pdf",
      type: "application/pdf",
      category: "求职材料",
      content: "第一份：简历内容 👋",
    }),
    await attachment({
      index: 2,
      name: "作品集_日本語版.pptx",
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      category: null,
      content: new Uint8Array([0, 1, 2, 3, 254, 255]),
    }),
    await attachment({
      index: 3,
      name: "case-study.md",
      type: "text/markdown",
      content: "# Café onboarding\n\n用户研究与复盘",
    }),
  ];
  // LocalFileMetadata has two extra fields; the standalone format deliberately
  // selects only the portable manifest fields.
  sources[0].metadata.version = 1;
  sources[0].metadata.namespace = "career";

  const database = sqliteBytes("Unicode 数据库");
  const backup = await createCareerBackupBlob(
    { database, attachments: sources, exportedAt: EXPORTED_AT },
    hashBlob,
  );
  const parsed = await parseCareerBackupBlob(backup, hashBlob);

  assert.deepEqual(parsed.database, database);
  assert.deepEqual(
    parsed.attachments.map(({ metadata }) => metadata.originalName),
    sources.map(({ metadata }) => metadata.originalName),
  );
  assert.equal(parsed.attachments[0].metadata.category, "求职材料");
  assert.equal(parsed.attachments[1].metadata.category, null);
  assert.equal(parsed.attachments[0].metadata.version, undefined);
  assert.equal(parsed.attachments[0].blob.type, "application/pdf");
  for (let index = 0; index < sources.length; index += 1) {
    assert.deepEqual(
      new Uint8Array(await parsed.attachments[index].blob.arrayBuffer()),
      new Uint8Array(await sources[index].blob.arrayBuffer()),
    );
    assert.equal(
      await hashBlob(parsed.attachments[index].blob),
      sources[index].metadata.sha256,
    );
  }
});

test("magic and manifest framing corruption are rejected", async (t) => {
  const backup = await baseBackup();

  await t.test("magic", async () => {
    const bytes = new Uint8Array(await backup.arrayBuffer());
    bytes[0] ^= 0xff;
    await expectCode(() => parseCareerBackupBlob(new Blob([bytes]), hashBlob), "INVALID_MAGIC");
  });

  await t.test("empty manifest", async () => {
    const bytes = new Uint8Array(await backup.arrayBuffer());
    new DataView(bytes.buffer).setUint32(magicBytes.byteLength, 0, false);
    await expectCode(
      () => parseCareerBackupBlob(new Blob([bytes]), hashBlob),
      "INVALID_MANIFEST_LENGTH",
    );
  });

  await t.test("oversized manifest declaration", async () => {
    const bytes = new Uint8Array(await backup.arrayBuffer());
    new DataView(bytes.buffer).setUint32(
      magicBytes.byteLength,
      CAREER_BACKUP_LIMITS.manifestBytes + 1,
      false,
    );
    await expectCode(
      () => parseCareerBackupBlob(new Blob([bytes]), hashBlob),
      "MANIFEST_TOO_LARGE",
    );
  });

  await t.test("invalid UTF-8", async () => {
    const bytes = new Uint8Array(await backup.arrayBuffer());
    bytes[CAREER_BACKUP_PREFIX_BYTE_SIZE] = 0xff;
    await expectCode(
      () => parseCareerBackupBlob(new Blob([bytes]), hashBlob),
      "INVALID_MANIFEST",
    );
  });

  await t.test("unsupported semantic manifest change", async () => {
    const parts = await inspectContainer(backup);
    parts.manifest.format = "career-b4ckup";
    await expectCode(
      () =>
        parseCareerBackupBlob(
          assembleContainer(parts.manifest, parts.databaseBytes),
          hashBlob,
        ),
      "UNSUPPORTED_FORMAT",
    );
  });
});

test("manifest SHA-256 catches a same-length valid-JSON metadata bit flip before payload hashing", async () => {
  const source = await attachment({
    index: 40,
    name: "portfolio.pdf",
    type: "application/pdf",
    content: "portfolio bytes",
  });
  const backup = await baseBackup([source]);
  const parts = await inspectContainer(backup);
  const bytes = parts.bytes.slice();
  const manifestText = new TextDecoder().decode(
    bytes.subarray(parts.manifestStart, parts.manifestEnd),
  );
  const nameOffset = manifestText.indexOf("portfolio.pdf");
  assert.ok(nameOffset >= 0);
  bytes[parts.manifestStart + nameOffset] = "q".charCodeAt(0);

  const mutatedManifest = JSON.parse(
    new TextDecoder().decode(bytes.subarray(parts.manifestStart, parts.manifestEnd)),
  );
  assert.equal(mutatedManifest.attachments[0].originalName, "qortfolio.pdf");

  let hashCalls = 0;
  await expectCode(
    () =>
      parseCareerBackupBlob(new Blob([bytes]), async (blob) => {
        hashCalls += 1;
        return hashBlob(blob);
      }),
    "MANIFEST_HASH_MISMATCH",
  );
  assert.equal(hashCalls, 1, "no database or attachment payload was hashed");
});

test("SQLite application ID and user version are derived and matched exactly", async (t) => {
  const applicationId = 0x1234_abcd;
  const userVersion = 37;
  const database = sqliteBytes("identity", { applicationId, userVersion });
  const backup = await createCareerBackupBlob(
    { database, attachments: [], exportedAt: EXPORTED_AT },
    hashBlob,
  );
  const parts = await inspectContainer(backup);

  assert.equal(parts.manifest.database.applicationId, applicationId);
  assert.equal(parts.manifest.database.userVersion, userVersion);
  const parsed = await parseCareerBackupBlob(backup, hashBlob);
  assert.equal(parsed.manifest.database.applicationId, applicationId);
  assert.equal(parsed.manifest.database.userVersion, userVersion);

  async function rejectDatabaseIdentityMutation(offset, replacement) {
    const bytes = parts.bytes.slice();
    new DataView(bytes.buffer).setUint32(
      parts.databaseStart + offset,
      replacement,
      false,
    );
    let hashCalls = 0;
    await expectCode(
      () =>
        parseCareerBackupBlob(new Blob([bytes]), async (blob) => {
          hashCalls += 1;
          return hashBlob(blob);
        }),
      "DATABASE_IDENTITY_MISMATCH",
    );
    assert.equal(hashCalls, 1, "only the unsigned manifest was hashed");
  }

  await t.test("application ID bytes", () =>
    rejectDatabaseIdentityMutation(68, applicationId ^ 1));
  await t.test("user version bytes", () =>
    rejectDatabaseIdentityMutation(60, userVersion + 1));

  await t.test("a correctly re-signed manifest cannot lie about the header", async () => {
    const manifest = structuredClone(parts.manifest);
    manifest.database.applicationId = applicationId ^ 1;
    await resignManifest(manifest);
    await expectCode(
      () =>
        parseCareerBackupBlob(
          assembleContainer(manifest, parts.databaseBytes),
          hashBlob,
        ),
      "DATABASE_IDENTITY_MISMATCH",
    );
  });
});

test("container length must exactly match the manifest", async () => {
  const backup = await baseBackup([
    await attachment({ index: 4, name: "resume.pdf", content: "resume" }),
  ]);
  await expectCode(
    () => parseCareerBackupBlob(backup.slice(0, backup.size - 1), hashBlob),
    "SIZE_MISMATCH",
  );
  await expectCode(
    () => parseCareerBackupBlob(new Blob([backup, new Uint8Array([0])]), hashBlob),
    "SIZE_MISMATCH",
  );
});

test("SQLite header, database hash, and attachment hashes are all enforced", async (t) => {
  const sources = [
    await attachment({ index: 5, name: "a.txt", type: "text/plain", content: "alpha" }),
    await attachment({ index: 6, name: "b.txt", type: "text/plain", content: "bravo" }),
  ];
  const backup = await baseBackup(sources);
  const parts = await inspectContainer(backup);

  await t.test("SQLite header", async () => {
    const bytes = parts.bytes.slice();
    bytes[parts.databaseStart] ^= 0x01;
    await expectCode(() => parseCareerBackupBlob(new Blob([bytes]), hashBlob), "INVALID_SQLITE");
  });

  await t.test("database payload", async () => {
    const bytes = parts.bytes.slice();
    bytes[parts.databaseStart + 32] ^= 0x01;
    await expectCode(
      () => parseCareerBackupBlob(new Blob([bytes]), hashBlob),
      "DATABASE_HASH_MISMATCH",
    );
  });

  await t.test("last attachment after every segment was checked", async () => {
    const bytes = parts.bytes.slice();
    bytes[bytes.length - 1] ^= 0x01;
    let calls = 0;
    const trackingHash = async (blob) => {
      calls += 1;
      return hashBlob(blob);
    };
    await expectCode(
      () => parseCareerBackupBlob(new Blob([bytes]), trackingHash),
      "ATTACHMENT_HASH_MISMATCH",
    );
    assert.equal(
      calls,
      4,
      "manifest, database, and both ordered attachments were hashed",
    );
  });
});

test("duplicate UUIDs and malformed attachment fields are rejected", async (t) => {
  const source = await attachment({
    index: 7,
    name: "portfolio.pdf",
    type: "application/pdf",
    content: "portfolio",
  });
  const backup = await baseBackup([source]);
  const parts = await inspectContainer(backup);

  async function rejectMutation(mutator, code = "INVALID_MANIFEST") {
    const manifest = structuredClone(parts.manifest);
    const attachmentBytes = parts.attachmentBytes.map((bytes) => bytes.slice());
    mutator(manifest, attachmentBytes);
    await expectCode(
      () =>
        parseCareerBackupBlob(
          assembleContainer(manifest, parts.databaseBytes, attachmentBytes),
          hashBlob,
        ),
      code,
    );
  }

  await t.test("duplicate key", () =>
    rejectMutation((manifest, payloads) => {
      manifest.attachments.push(structuredClone(manifest.attachments[0]));
      payloads.push(payloads[0].slice());
    }, "DUPLICATE_ATTACHMENT_KEY"));
  await t.test("invalid UUID", () =>
    rejectMutation((manifest) => {
      manifest.attachments[0].key = "not-a-uuid";
    }));
  await t.test("wrong field type", () =>
    rejectMutation((manifest) => {
      manifest.attachments[0].originalName = 42;
    }));
  await t.test("overlong file name", () =>
    rejectMutation((manifest) => {
      manifest.attachments[0].originalName = "a".repeat(
        CAREER_BACKUP_LIMITS.originalNameCharacters + 1,
      );
    }));
  await t.test("unsafe file name", () =>
    rejectMutation((manifest) => {
      manifest.attachments[0].originalName = "../resume.pdf";
    }));
  await t.test("invalid MIME type", () =>
    rejectMutation((manifest) => {
      manifest.attachments[0].mimeType = "application/pdf; charset=utf-8";
    }));
  await t.test("invalid category type", () =>
    rejectMutation((manifest) => {
      manifest.attachments[0].category = false;
    }));
  await t.test("invalid SHA-256", () =>
    rejectMutation((manifest) => {
      manifest.attachments[0].sha256 = "ABC";
    }));
  await t.test("invalid timestamp", () =>
    rejectMutation((manifest) => {
      manifest.attachments[0].updatedAt = "yesterday";
    }));
  await t.test("extra field", () =>
    rejectMutation((manifest) => {
      manifest.attachments[0].path = "/tmp/secret";
    }));
  await t.test("missing manifest digest", () =>
    rejectMutation((manifest) => {
      delete manifest.manifestSha256;
    }));
  await t.test("invalid manifest digest", () =>
    rejectMutation((manifest) => {
      manifest.manifestSha256 = "ABC";
    }));
  await t.test("top-level extra field", () =>
    rejectMutation((manifest) => {
      manifest.comment = "not part of v1";
    }));
  await t.test("database extra field", () =>
    rejectMutation((manifest) => {
      manifest.database.pageSize = 4_096;
    }));
  await t.test("invalid application ID type", () =>
    rejectMutation((manifest) => {
      manifest.database.applicationId = "zhiji";
    }));
  await t.test("invalid user version range", () =>
    rejectMutation((manifest) => {
      manifest.database.userVersion = -1;
    }));
});

test("declared collection, segment, and total size limits fail before hashing", async (t) => {
  const source = await attachment({ index: 8, name: "tiny.txt", content: "x" });
  let calls = 0;
  const trackingHash = async (blob) => {
    calls += 1;
    return hashBlob(blob);
  };

  await t.test("creator attachment count", async () => {
    await expectCode(
      () =>
        createCareerBackupBlob(
          {
            database: sqliteBytes(),
            attachments: Array.from(
              { length: CAREER_BACKUP_LIMITS.attachmentCount + 1 },
              () => source,
            ),
          },
          trackingHash,
        ),
      "TOO_MANY_ATTACHMENTS",
    );
    assert.equal(calls, 0);
  });

  await t.test("creator total payload size", async () => {
    const apparentLargeAttachments = Array.from({ length: 4 }, (_, index) => {
      const blob = new Blob([]);
      Object.defineProperty(blob, "size", {
        value: CAREER_BACKUP_LIMITS.attachmentBytes,
      });
      return {
        metadata: {
          key: uuid(index + 2_000),
          originalName: `large-${index}.bin`,
          mimeType: "application/octet-stream",
          category: null,
          byteSize: CAREER_BACKUP_LIMITS.attachmentBytes,
          sha256: EMPTY_SHA256,
          createdAt: EXPORTED_AT,
          updatedAt: EXPORTED_AT,
        },
        blob,
      };
    });
    await expectCode(
      () =>
        createCareerBackupBlob(
          {
            database: sqliteBytes(),
            attachments: apparentLargeAttachments,
          },
          trackingHash,
        ),
      "BACKUP_TOO_LARGE",
    );
    assert.equal(calls, 0);
  });

  const backup = await baseBackup();
  const parts = await inspectContainer(backup);

  await t.test("parser attachment count", async () => {
    const manifest = structuredClone(parts.manifest);
    manifest.attachments = Array.from(
      { length: CAREER_BACKUP_LIMITS.attachmentCount + 1 },
      (_, index) => ({
        key: uuid(index + 10),
        originalName: `empty-${index}.txt`,
        mimeType: "text/plain",
        category: null,
        byteSize: 0,
        sha256: EMPTY_SHA256,
        createdAt: EXPORTED_AT,
        updatedAt: EXPORTED_AT,
      }),
    );
    await expectCode(
      () =>
        parseCareerBackupBlob(
          assembleContainer(manifest, parts.databaseBytes),
          trackingHash,
        ),
      "TOO_MANY_ATTACHMENTS",
    );
    assert.equal(calls, 0);
  });

  await t.test("declared database size", async () => {
    const manifest = structuredClone(parts.manifest);
    manifest.database.byteSize = CAREER_BACKUP_LIMITS.databaseBytes + 1;
    await expectCode(
      () =>
        parseCareerBackupBlob(
          assembleContainer(manifest, parts.databaseBytes),
          trackingHash,
        ),
      "DATABASE_TOO_LARGE",
    );
    assert.equal(calls, 0);
  });

  await t.test("declared attachment size", async () => {
    const manifest = structuredClone(parts.manifest);
    manifest.attachments = [{
      key: uuid(9999),
      originalName: "huge.bin",
      mimeType: "application/octet-stream",
      category: null,
      byteSize: CAREER_BACKUP_LIMITS.attachmentBytes + 1,
      sha256: EMPTY_SHA256,
      createdAt: EXPORTED_AT,
      updatedAt: EXPORTED_AT,
    }];
    await expectCode(
      () =>
        parseCareerBackupBlob(
          assembleContainer(manifest, parts.databaseBytes),
          trackingHash,
        ),
      "ATTACHMENT_TOO_LARGE",
    );
    assert.equal(calls, 0);
  });

  await t.test("declared total size", async () => {
    const manifest = structuredClone(parts.manifest);
    manifest.attachments = Array.from({ length: 4 }, (_, index) => ({
      key: uuid(index + 4_000),
      originalName: `large-${index}.bin`,
      mimeType: "application/octet-stream",
      category: null,
      byteSize: CAREER_BACKUP_LIMITS.attachmentBytes,
      sha256: EMPTY_SHA256,
      createdAt: EXPORTED_AT,
      updatedAt: EXPORTED_AT,
    }));
    await expectCode(
      () =>
        parseCareerBackupBlob(
          assembleContainer(manifest, parts.databaseBytes),
          trackingHash,
        ),
      "BACKUP_TOO_LARGE",
    );
    assert.equal(calls, 0);
  });

  await t.test("actual container size", async () => {
    const apparentHugeBlob = new Blob([backup]);
    Object.defineProperty(apparentHugeBlob, "size", {
      value: CAREER_BACKUP_LIMITS.totalBytes + 1,
    });
    await expectCode(
      () => parseCareerBackupBlob(apparentHugeBlob, trackingHash),
      "BACKUP_TOO_LARGE",
    );
    assert.equal(calls, 0);
  });
});

test("creator verifies OPFS metadata size and hash against real Blob bytes", async (t) => {
  const source = await attachment({ index: 9, name: "verified.pdf", content: "verified" });

  await t.test("size mismatch", async () => {
    const altered = {
      ...source,
      metadata: { ...source.metadata, byteSize: source.metadata.byteSize + 1 },
    };
    await expectCode(
      () => baseBackup([altered]),
      "ATTACHMENT_SIZE_MISMATCH",
    );
  });

  await t.test("hash mismatch", async () => {
    const altered = {
      ...source,
      metadata: { ...source.metadata, sha256: "0".repeat(64) },
    };
    let calls = 0;
    await expectCode(
      () =>
        createCareerBackupBlob(
          { database: sqliteBytes(), attachments: [altered] },
          async (blob) => {
            calls += 1;
            return hashBlob(blob);
          },
        ),
      "ATTACHMENT_HASH_MISMATCH",
    );
    assert.equal(calls, 2, "database and attachment bytes were independently hashed");
  });

  await t.test("invalid SQLite source", async () => {
    await expectCode(
      () =>
        createCareerBackupBlob(
          { database: encoder.encode("not sqlite at all"), attachments: [] },
          hashBlob,
        ),
      "INVALID_SQLITE",
    );
  });

  await t.test("invalid injected hash", async () => {
    await expectCode(
      () =>
        createCareerBackupBlob(
          { database: sqliteBytes(), attachments: [] },
          async () => "not-a-digest",
        ),
      "HASH_FAILED",
    );
  });
});
