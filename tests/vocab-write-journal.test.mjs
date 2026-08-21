import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${crypto.randomUUID()}`;
}

async function loadHelpers(relativePath, start, end, preamble, exports) {
  const source = await readFile(new URL(relativePath, projectRoot), "utf8");
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  const result = ts.transpileModule(
    `${preamble}\n${source.slice(from, to)}\nexport { ${exports.join(", ")} };`,
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      reportDiagnostics: true,
    },
  );
  assert.deepEqual(
    (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  return import(moduleUrl(result.outputText));
}

class MemoryStorage {
  #values = new Map();

  get length() { return this.#values.size; }

  key(index) { return [...this.#values.keys()][index] ?? null; }

  getItem(key) { return this.#values.get(key) ?? null; }

  setItem(key, value) { this.#values.set(String(key), String(value)); }

  removeItem(key) { this.#values.delete(key); }
}

async function withStorage(run) {
  const previous = globalThis.window;
  const localStorage = new MemoryStorage();
  globalThis.window = { localStorage };
  try {
    await run(localStorage);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

test("import recovery journal keeps independent operations and removes by exact CAS", async () => {
  const journal = await loadHelpers(
    "app/vocab/overlays.tsx",
    'const IMPORT_RECOVERY_PREFIX = "vocab.pending-import-write.v1:";',
    "export function WordDetail",
    `
      const isVocabImportWriteReceipt = (value) => Boolean(
        value && typeof value.operationId === "string" &&
        typeof value.createdAt === "number"
      );
      const isVocabPodcastAudioWriteReceipt = (value) => Boolean(
        value && typeof value.operationId === "string" && value.database
      );
    `,
    [
      "importRecoveryKey",
      "readImportRecovery",
      "writeImportRecovery",
      "removeImportRecovery",
    ],
  );

  await withStorage(async (storage) => {
    const first = {
      version: 1,
      type: "database",
      receipt: { operationId: "operation_a", createdAt: 1 },
    };
    const second = {
      version: 1,
      type: "database",
      receipt: { operationId: "operation_b", createdAt: 2 },
    };
    journal.writeImportRecovery(first);
    journal.writeImportRecovery(second);
    assert.notEqual(journal.importRecoveryKey(first), journal.importRecoveryKey(second));
    assert.deepEqual(journal.readImportRecovery(), first);

    journal.removeImportRecovery(first);
    assert.equal(storage.getItem(journal.importRecoveryKey(first)), null);
    assert.deepEqual(journal.readImportRecovery(), second);

    journal.writeImportRecovery(first);
    const replacement = {
      ...first,
      receipt: { ...first.receipt, createdAt: 9 },
    };
    storage.setItem(journal.importRecoveryKey(first), JSON.stringify(replacement));
    journal.removeImportRecovery(first);
    assert.equal(
      storage.getItem(journal.importRecoveryKey(first)),
      JSON.stringify(replacement),
    );

    storage.setItem("vocab.pending-import-write.v1:damaged", "{");
    assert.deepEqual(journal.readImportRecovery(), second);
  });
});

test("occurrence recovery journal stores only its own receipt and cannot erase a peer", async () => {
  const journal = await loadHelpers(
    "app/vocab/VocabApp.tsx",
    'const OCCURRENCE_RECOVERY_PREFIX = "vocab.pending-occurrence-write.v1:";',
    "type WordSavePhase",
    `
      const isVocabOccurrenceWriteReceipt = (value) => Boolean(
        value && value.kind === "occurrence" &&
        typeof value.operationId === "string" &&
        typeof value.createdAt === "number"
      );
    `,
    [
      "occurrenceRecoveryKey",
      "readOccurrenceRecovery",
      "writeOccurrenceRecovery",
      "removeOccurrenceRecovery",
    ],
  );

  await withStorage(async (storage) => {
    const first = {
      version: 1,
      kind: "occurrence",
      operationId: "operation_a",
      createdAt: 1,
      projectionSha256: "a".repeat(64),
    };
    const second = {
      version: 1,
      kind: "occurrence",
      operationId: "operation_b",
      createdAt: 2,
      projectionSha256: "b".repeat(64),
    };
    journal.writeOccurrenceRecovery(first);
    journal.writeOccurrenceRecovery(second);
    journal.removeOccurrenceRecovery(first);

    assert.equal(storage.getItem(journal.occurrenceRecoveryKey(first)), null);
    assert.equal(
      storage.getItem(journal.occurrenceRecoveryKey(second)),
      JSON.stringify(second),
    );
    assert.deepEqual(journal.readOccurrenceRecovery(), second);

    storage.setItem("vocab.pending-occurrence-write.v1:damaged", "not-json");
    assert.deepEqual(journal.readOccurrenceRecovery(), second);
  });
});
