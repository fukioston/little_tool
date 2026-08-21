import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function transpile(relativePath) {
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
    diagnostics.filter(({ category }) => category === ts.DiagnosticCategory.Error),
    [],
  );
  return outputText;
}

function executeRun(database, sql, params = []) {
  const statement = database.prepare(sql);
  try {
    if (params.length > 0) statement.bind(params);
    while (statement.step()) {
      // Consume statements that return rows.
    }
  } finally {
    statement.finalize();
  }
  return {
    changes: Number(database.changes()),
    lastInsertRowId: database.selectValue("SELECT last_insert_rowid()") ?? null,
  };
}

function adapterFor(database, state) {
  return {
    async query(name, sql, params = []) {
      assert.equal(name, "career");
      state.queries += 1;
      assert.equal(globalThis.__careerImportLockState.active, 1, "DB reads stay inside the Career lock");
      if (state.queryFailuresRemaining > 0) {
        state.queryFailuresRemaining -= 1;
        throw new Error("sqlite SELECT career_stages exploded");
      }
      const rows = database.selectObjects(sql, params);
      return { columns: [], rows, rowCount: rows.length };
    },
    async batch(name, statements, options = {}) {
      assert.equal(name, "career");
      state.batches += 1;
      state.batchSizes.push(statements.length);
      state.transactional.push(options.transaction === true);
      state.batchWhileLocked.push(globalThis.__careerImportLockState.active === 1);
      const operation = () => statements.map(({ sql, params = [] }, index) => {
        if (state.failAtStatement === index) throw new Error("injected sqlite failure");
        return executeRun(database, sql, params);
      });
      const results = options.transaction === false
        ? operation()
        : database.transaction("IMMEDIATE", operation);
      if (state.throwAfterCommit) {
        state.throwAfterCommit = false;
        if (state.failRecoveryQueriesAfterCommit) state.queryFailuresRemaining = 1;
        throw new Error("response lost after commit");
      }
      return {
        results,
        changes: results.reduce((sum, result) => sum + result.changes, 0),
      };
    },
  };
}

globalThis.__careerImportAdapter = null;
globalThis.__careerImportLockState = {
  writes: 0,
  reads: 0,
  active: 0,
  maxActive: 0,
  tail: Promise.resolve(),
  gate: null,
  onWaiting: null,
};

const rawImportJavaScript = await transpile("lib/career/imports.ts");
const clientUrl = moduleUrl(`
  export const localDb = {
    query(...args) { return globalThis.__careerImportAdapter.query(...args); },
    batch(...args) { return globalThis.__careerImportAdapter.batch(...args); }
  };
`);
const lockUrl = moduleUrl(`
  async function run(task, mode) {
    const state = globalThis.__careerImportLockState;
    if (mode === "exclusive") state.writes += 1;
    else state.reads += 1;
    const previous = state.tail;
    let release;
    state.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    if (mode === "exclusive" && state.gate) {
      state.onWaiting?.();
      await state.gate;
    }
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    try {
      return await task({ token: Symbol(mode), mode });
    } finally {
      state.active -= 1;
      release();
    }
  }
  export function withCareerWriteLock(task) { return run(task, "exclusive"); }
  export function withCareerReadLock(task) { return run(task, "shared"); }
`);
const importJavaScript = rawImportJavaScript
  .replaceAll('"@/lib/local-db/client"', `"${clientUrl}"`)
  .replaceAll('"./lock"', `"${lockUrl}"`);
const imports = await import(moduleUrl(importJavaScript));

const NOW = "2026-08-21T08:00:00.000Z";
const NEXT = "2026-08-21T09:00:00.000Z";
const OP_A = "import_11111111-1111-4111-8111-111111111111";
const OP_B = "import_22222222-2222-4222-8222-222222222222";

async function fixture() {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec(`
    CREATE TABLE career_stages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      is_terminal INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE career_jobs (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '手动记录',
      source_url TEXT NOT NULL DEFAULT '',
      stage_id TEXT NOT NULL REFERENCES career_stages(id),
      priority INTEGER NOT NULL DEFAULT 1,
      salary TEXT NOT NULL DEFAULT '',
      work_mode TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      applied_at TEXT,
      deadline TEXT,
      contact_name TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      ended_at TEXT,
      archived_operation_id TEXT,
      ended_operation_id TEXT
    );
    CREATE TABLE career_activity (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES career_jobs(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO career_stages(id,name,position,is_terminal) VALUES
      ('stage_saved','收藏',0,0),
      ('stage_preparing','准备中',1,0),
      ('stage_applied','已投递',2,0),
      ('stage_assessment','笔试 / 测评',3,0),
      ('stage_interview','面试中',4,0),
      ('stage_offer','Offer',5,0),
      ('stage_accepted','已接受',6,1),
      ('stage_rejected','未通过',7,1),
      ('stage_withdrawn','已撤回',8,1);
  `);
  const state = {
    queries: 0,
    batches: 0,
    batchSizes: [],
    transactional: [],
    batchWhileLocked: [],
    failAtStatement: null,
    throwAfterCommit: false,
    failRecoveryQueriesAfterCommit: false,
    queryFailuresRemaining: 0,
  };
  globalThis.__careerImportAdapter = adapterFor(database, state);
  globalThis.__careerImportLockState = {
    writes: 0,
    active: 0,
    maxActive: 0,
    tail: Promise.resolve(),
    reads: 0,
    gate: null,
    onWaiting: null,
  };
  return {
    database,
    state,
    close() {
      database.close();
      globalThis.__careerImportAdapter = null;
    },
  };
}

function count(database, table) {
  return Number(database.selectValue(`SELECT COUNT(*) FROM ${table}`));
}

async function smartPreview({
  operationId = OP_A,
  sourceText = "https://www.linkedin.com/jobs/view/42",
  company = "苹果",
  role = "产品设计师",
  extra = {},
  now = NOW,
} = {}) {
  return imports.createCareerJobImportPreview({
    sourceText,
    importOperationId: operationId,
    now,
    parsedCandidate: {
      company,
      role,
      location: "新加坡",
      source: "LinkedIn",
      url: sourceText,
      description: "构建清晰、可信的产品体验。",
      keywords: ["设计系统", "协作"],
      ...extra,
    },
  });
}

test("smart preview keeps unknowns truthful and never invents application facts", async () => {
  const preview = await imports.createCareerJobImportPreview({
    sourceText: "一段没有平台标识的分享文本",
    importOperationId: OP_A,
    now: NOW,
    parsedCandidate: {
      company_name: "小宇宙",
      title: "产品经理",
      source: "神秘渠道",
      stage: "正在考虑",
      field_confidence: { company: "high", role: "medium" },
    },
  });
  assert.equal(preview.candidate.company, "小宇宙");
  assert.equal(preview.candidate.role, "产品经理");
  assert.equal(preview.candidate.source, "待确认来源");
  assert.equal(preview.candidate.stageId, "stage_saved");
  assert.equal(preview.candidate.description, "");
  assert.equal(preview.confidence.fields.company, "high");
  assert.equal(preview.confidence.fields.role, "medium");
  assert.equal(preview.confidence.fields.source, "low");
  assert.ok(preview.warnings.some(({ code }) => code === "unknown_source"));
  assert.ok(preview.warnings.some(({ code }) => code === "unknown_stage"));

  const scope = await fixture();
  try {
    const result = await imports.commitCareerJobImport({
      preview,
      currentSourceFingerprint: preview.sourceFingerprint,
    });
    assert.equal(result.committed, true);
    const row = scope.database.selectObject(
      "SELECT applied_at,deadline,contact_name,note FROM career_jobs WHERE id=?",
      [preview.jobId],
    );
    assert.deepEqual(row, {
      applied_at: null,
      deadline: null,
      contact_name: "",
      note: "",
    });
  } finally {
    scope.close();
  }
});

test("a changed source fingerprint rejects before the lock and writes nothing", async () => {
  const scope = await fixture();
  try {
    const preview = await smartPreview();
    const changedFingerprint = await imports.fingerprintCareerImportSource(
      "https://www.linkedin.com/jobs/view/another",
    );
    await assert.rejects(
      imports.commitCareerJobImport({ preview, currentSourceFingerprint: changedFingerprint }),
      (error) => error instanceof imports.CareerImportError && error.code === "source_changed",
    );
    assert.equal(scope.state.batches, 0);
    assert.equal(globalThis.__careerImportLockState.writes, 0);
    assert.equal(count(scope.database, "career_jobs"), 0);
    assert.equal(count(scope.database, "career_activity"), 0);
  } finally {
    scope.close();
  }
});

test("one locked transactional batch commits the job and matching activity, even if its response is lost", async () => {
  const scope = await fixture();
  try {
    const preview = await smartPreview();
    scope.state.throwAfterCommit = true;
    const result = await imports.commitCareerJobImport({
      preview,
      currentSourceFingerprint: preview.sourceFingerprint,
    });
    assert.equal(result.status, "committed");
    assert.equal(result.committed, true);
    assert.equal(result.jobId, preview.jobId);
    assert.equal(count(scope.database, "career_jobs"), 1);
    assert.equal(count(scope.database, "career_activity"), 1);
    assert.equal(scope.state.batches, 1);
    assert.deepEqual(scope.state.batchSizes, [2]);
    assert.deepEqual(scope.state.transactional, [true]);
    assert.deepEqual(scope.state.batchWhileLocked, [true]);
    assert.equal(globalThis.__careerImportLockState.writes, 1);
  } finally {
    scope.close();
  }
});

test("an exact retry is idempotent and every persisted job/activity field participates in conflict detection", async () => {
  const scope = await fixture();
  try {
    const preview = await smartPreview();
    const item = { preview, currentSourceFingerprint: preview.sourceFingerprint };
    assert.equal((await imports.commitCareerJobImport(item)).status, "committed");
    const batchesAfterCommit = scope.state.batches;
    assert.equal((await imports.commitCareerJobImport(item)).status, "already_committed");
    assert.equal(scope.state.batches, batchesAfterCommit);

    const jobChanges = [
      ["company", "另一家公司"],
      ["role", "另一职位"],
      ["location", "上海"],
      ["source", "官网"],
      ["source_url", "https://example.com/job"],
      ["stage_id", "stage_applied"],
      ["priority", 3],
      ["salary", "面议"],
      ["work_mode", "远程"],
      ["description", "另一份描述"],
      ["applied_at", NEXT],
      ["deadline", NEXT],
      ["contact_name", "联系人"],
      ["note", "另一条备注"],
      ["tags", "另一个标签"],
      ["created_at", NEXT],
      ["updated_at", NEXT],
      ["archived", 1],
      ["position", 9],
      ["archived_at", NEXT],
      ["ended_at", NEXT],
      ["archived_operation_id", "archive_x"],
      ["ended_operation_id", "end_x"],
    ];
    for (const [field, replacement] of jobChanges) {
      const original = scope.database.selectValue(
        `SELECT ${field} FROM career_jobs WHERE id=?`,
        [preview.jobId],
      );
      executeRun(scope.database, `UPDATE career_jobs SET ${field}=? WHERE id=?`, [replacement, preview.jobId]);
      await assert.rejects(
        imports.commitCareerJobImport(item),
        (error) => error instanceof imports.CareerImportError && error.code === "operation_conflict",
        `changed job field ${field}`,
      );
      executeRun(scope.database, `UPDATE career_jobs SET ${field}=? WHERE id=?`, [original, preview.jobId]);
    }

    const activityChanges = [
      ["job_id", null],
      ["type", "create"],
      ["detail", "另一条动态"],
      ["created_at", NEXT],
    ];
    for (const [field, replacement] of activityChanges) {
      const original = scope.database.selectValue(
        `SELECT ${field} FROM career_activity WHERE id=?`,
        [preview.activityId],
      );
      executeRun(scope.database, `UPDATE career_activity SET ${field}=? WHERE id=?`, [replacement, preview.activityId]);
      await assert.rejects(
        imports.commitCareerJobImport(item),
        (error) => error instanceof imports.CareerImportError && error.code === "operation_conflict",
        `changed activity field ${field}`,
      );
      executeRun(scope.database, `UPDATE career_activity SET ${field}=? WHERE id=?`, [original, preview.activityId]);
    }
    assert.equal(scope.state.batches, batchesAfterCommit);
  } finally {
    scope.close();
  }
});

test("a partial identity or the same operation with another payload conflicts with zero new writes", async () => {
  const scope = await fixture();
  try {
    const first = await smartPreview();
    executeRun(
      scope.database,
      `INSERT INTO career_jobs(
        id,company,role,location,source,source_url,stage_id,priority,salary,
        work_mode,description,applied_at,deadline,contact_name,note,tags,
        created_at,updated_at,archived,position
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)`,
      [
        first.jobId, "占用者", "不同职位", "", "官网", "", "stage_saved", 1,
        "", "", "", null, null, "", "", "", NOW, NOW,
      ],
    );
    await assert.rejects(
      imports.commitCareerJobImport({
        preview: first,
        currentSourceFingerprint: first.sourceFingerprint,
      }),
      (error) => error instanceof imports.CareerImportError && error.code === "operation_conflict",
    );
    assert.equal(scope.state.batches, 0);
    assert.equal(count(scope.database, "career_jobs"), 1);
    assert.equal(count(scope.database, "career_activity"), 0);

    const different = await smartPreview({ role: "另一职位" });
    await assert.rejects(
      imports.commitCareerJobImports({
        items: [first, different].map((preview) => ({
          preview,
          currentSourceFingerprint: preview.sourceFingerprint,
        })),
      }),
      (error) => error instanceof imports.CareerImportError && error.code === "operation_conflict",
    );
    assert.equal(scope.state.batches, 0);
  } finally {
    scope.close();
  }
});

test("commitMany validates every item first and rolls the whole real SQLite transaction back", async () => {
  const scope = await fixture();
  try {
    const first = await smartPreview();
    const second = await smartPreview({
      operationId: OP_B,
      company: "字节跳动",
      role: "设计工程师",
      sourceText: "https://www.linkedin.com/jobs/view/84",
      now: NEXT,
    });
    const changed = await imports.fingerprintCareerImportSource("changed source");
    await assert.rejects(
      imports.commitCareerJobImports({
        items: [
          { preview: first, currentSourceFingerprint: first.sourceFingerprint },
          { preview: second, currentSourceFingerprint: changed },
        ],
      }),
      (error) => error instanceof imports.CareerImportError && error.code === "source_changed",
    );
    assert.equal(scope.state.batches, 0);
    assert.equal(count(scope.database, "career_jobs"), 0);

    scope.state.failAtStatement = 3;
    await assert.rejects(
      imports.commitCareerJobImports({
        items: [first, second].map((preview) => ({
          preview,
          currentSourceFingerprint: preview.sourceFingerprint,
        })),
      }),
      (error) => error instanceof imports.CareerImportError && error.code === "write_failed",
    );
    assert.equal(scope.state.batches, 1);
    assert.equal(scope.state.transactional[0], true);
    assert.equal(count(scope.database, "career_jobs"), 0);
    assert.equal(count(scope.database, "career_activity"), 0);
  } finally {
    scope.close();
  }
});

test("RFC4180 CSV preview preserves BOM, quoted newlines, escaped quotes, commas, and Unicode", async () => {
  const csv = "\uFEFFCompany,Title,Description,URL,Source\r\n" +
    '"苹果, 中国","设计师","第一行\r\n第二行，含有 ""引号""","https://example.com/jobs/1","官网"\r\n' +
    '宇宙公司,产品经理,"关注 Unicode：你好，世界",https://www.zhipin.com/job/2,BOSS直聘\r\n';
  const preview = await imports.parseCareerCsvImportPreview(csv, { now: NOW });
  assert.equal(preview.rows.length, 2);
  assert.equal(preview.rows[0].rowNumber, 2);
  assert.equal(preview.rows[0].candidate.company, "苹果, 中国");
  assert.equal(preview.rows[0].candidate.role, "设计师");
  assert.equal(preview.rows[0].candidate.description, "第一行\n第二行，含有 \"引号\"");
  assert.equal(preview.rows[1].rowNumber, 4);
  assert.equal(preview.rows[1].candidate.description, "关注 Unicode：你好，世界");
  assert.ok(preview.rows.every((row) => row.sourceFingerprint === preview.sourceFingerprint));
  assert.ok(preview.rows.every((row) => !row.warnings.some(({ severity }) => severity === "blocking")));
});

test("identical CSV rows name both logical lines, commit once, and can be explicitly forked", async () => {
  const csv = "Company,Title,URL\nAcme,Designer,https://example.com/1\nAcme,Designer,https://example.com/1\n";
  const preview = await imports.parseCareerCsvImportPreview(csv, {
    sourceHint: "LinkedIn",
    now: NOW,
  });
  assert.equal(preview.rows.length, 2);
  assert.equal(preview.rows[0].rowNumber, 2);
  assert.equal(preview.rows[1].rowNumber, 3);
  assert.equal(preview.rows[1].duplicateOfRowNumber, 2);
  assert.equal(preview.rows[1].importOperationId, preview.rows[0].importOperationId);
  assert.notEqual(preview.rows[1].previewFingerprint, preview.rows[0].previewFingerprint);
  const warning = preview.rows[1].warnings.find(({ code }) => code === "csv_duplicate_row");
  assert.equal(warning.duplicateOfRowNumber, 2);
  assert.match(warning.message, /第 3 行.*职位字段.*第 2 行.*只保存一次/);

  const scope = await fixture();
  try {
    const result = await imports.commitCareerJobImports({
      items: preview.rows.map((row) => ({
        preview: row,
        currentSourceFingerprint: preview.sourceFingerprint,
      })),
    });
    assert.equal(result.uniqueCount, 1);
    assert.equal(result.writtenCount, 1);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].previewFingerprint, preview.rows[0].previewFingerprint);
    assert.equal(result.results[1].previewFingerprint, preview.rows[1].previewFingerprint);
    assert.equal(count(scope.database, "career_jobs"), 1);
    assert.equal(count(scope.database, "career_activity"), 1);

    const fork = await imports.forkCareerJobImportPreview(preview.rows[1], { now: NEXT });
    assert.notEqual(fork.importOperationId, preview.rows[1].importOperationId);
    assert.equal(fork.duplicateOfRowNumber, undefined);
    await imports.commitCareerJobImport({
      preview: fork,
      currentSourceFingerprint: preview.sourceFingerprint,
    });
    assert.equal(count(scope.database, "career_jobs"), 2);
    assert.equal(count(scope.database, "career_activity"), 2);
  } finally {
    scope.close();
  }
});

test("malformed or incomplete CSV remains a preview and cannot write", async () => {
  const csv = 'Wrong,Title\n"unterminated,Designer\n';
  const preview = await imports.parseCareerCsvImportPreview(csv, {
    sourceHint: "LinkedIn",
    now: NOW,
  });
  assert.ok(preview.warnings.some(({ code, severity }) =>
    code === "csv_missing_header" && severity === "blocking"));
  assert.ok(preview.rows.some((row) => row.warnings.some(({ code, severity }) =>
    code === "csv_malformed" && severity === "blocking")));
  const scope = await fixture();
  try {
    await assert.rejects(
      imports.commitCareerJobImports({
        items: preview.rows.map((row) => ({
          preview: row,
          currentSourceFingerprint: preview.sourceFingerprint,
        })),
      }),
      (error) => error instanceof imports.CareerImportError && error.code === "invalid_preview",
    );
    assert.equal(scope.state.batches, 0);
    assert.equal(count(scope.database, "career_jobs"), 0);
  } finally {
    scope.close();
  }
});

test("concurrent commits are serialized by the single Career exclusive lock", async () => {
  const scope = await fixture();
  try {
    const first = await smartPreview();
    const second = await smartPreview({
      operationId: OP_B,
      company: "微软",
      role: "研究员",
      sourceText: "https://www.linkedin.com/jobs/view/99",
      now: NEXT,
    });
    await Promise.all([first, second].map((preview) => imports.commitCareerJobImport({
      preview,
      currentSourceFingerprint: preview.sourceFingerprint,
    })));
    assert.equal(globalThis.__careerImportLockState.writes, 2);
    assert.equal(globalThis.__careerImportLockState.maxActive, 1);
    assert.equal(scope.state.batches, 2);
    assert.deepEqual(scope.state.transactional, [true, true]);
    assert.deepEqual(scope.state.batchWhileLocked, [true, true]);
    assert.equal(count(scope.database, "career_jobs"), 2);
    assert.equal(count(scope.database, "career_activity"), 2);
  } finally {
    scope.close();
  }
});

test("an incomplete preview can be revised without losing its stable operation", async () => {
  const preview = await imports.createCareerJobImportPreview({
    sourceText: "LinkedIn 分享文本",
    importOperationId: OP_A,
    now: NOW,
    parsedCandidate: { company: "", role: "" },
  });
  assert.ok(preview.warnings.some(({ severity }) => severity === "blocking"));
  const revised = await imports.reviseCareerJobImportPreview(preview, {
    company: "OpenAI",
    role: "Product Designer",
  });
  assert.equal(revised.importOperationId, preview.importOperationId);
  assert.equal(revised.jobId, preview.jobId);
  assert.notEqual(revised.previewFingerprint, preview.previewFingerprint);
  assert.ok(!revised.warnings.some(({ severity }) => severity === "blocking"));
});

test("the full preview signature rejects warning, severity, row, and confidence tampering before locking", async () => {
  const csv = 'Company,Title\n"Acme"oops,Designer\n';
  const parsed = await imports.parseCareerCsvImportPreview(csv, {
    sourceHint: "LinkedIn",
    now: NOW,
  });
  const original = parsed.rows[0];
  assert.ok(original.warnings.some(({ code, severity }) =>
    code === "csv_malformed" && severity === "blocking"));
  const variants = [
    { ...structuredClone(original), warnings: [] },
    {
      ...structuredClone(original),
      warnings: original.warnings.map((warning) =>
        warning.code === "csv_malformed" ? { ...warning, severity: "review" } : warning),
    },
    { ...structuredClone(original), rowNumber: original.rowNumber + 1 },
    {
      ...structuredClone(original),
      confidence: {
        ...original.confidence,
        fields: { ...original.confidence.fields, company: "low" },
      },
    },
  ];
  const scope = await fixture();
  try {
    for (const preview of variants) {
      await assert.rejects(
        imports.commitCareerJobImport({
          preview,
          currentSourceFingerprint: parsed.sourceFingerprint,
        }),
        (error) => error instanceof imports.CareerImportError &&
          error.code === "preview_changed",
      );
    }
    assert.equal(globalThis.__careerImportLockState.writes, 0);
    assert.equal(scope.state.batches, 0);
    assert.equal(count(scope.database, "career_jobs"), 0);
  } finally {
    scope.close();
  }
});

test("commit snapshots caller-owned data before waiting for the cross-tab lock", async () => {
  const scope = await fixture();
  try {
    const preview = await smartPreview({ company: "Reviewed Company" });
    let releaseGate;
    let announceWaiting;
    const waiting = new Promise((resolve) => { announceWaiting = resolve; });
    globalThis.__careerImportLockState.gate = new Promise((resolve) => { releaseGate = resolve; });
    globalThis.__careerImportLockState.onWaiting = announceWaiting;
    const pending = imports.commitCareerJobImport({
      preview,
      currentSourceFingerprint: preview.sourceFingerprint,
    });
    await waiting;
    preview.candidate.company = "NOT REVIEWED";
    preview.warnings.splice(0, preview.warnings.length);
    releaseGate();
    const result = await pending;
    assert.equal(result.committed, true);
    assert.equal(
      scope.database.selectValue("SELECT company FROM career_jobs WHERE id=?", [preview.jobId]),
      "Reviewed Company",
    );
  } finally {
    scope.close();
  }
});

test("revising one field preserves untouched confidence and parser notices", async () => {
  const preview = await imports.createCareerJobImportPreview({
    sourceText: "https://www.linkedin.com/jobs/view/42",
    importOperationId: OP_A,
    now: NOW,
    parsedCandidate: {
      company: "Acme",
      role: "Designer",
      location: "Singapore",
      source: "LinkedIn",
      stage: "saved",
      description: "A parsed description",
      warnings: ["地点由模型整理，请核对"],
      field_confidence: {
        company: "low",
        role: "medium",
        location: "low",
        description: "low",
      },
    },
  });
  const revised = await imports.reviseCareerJobImportPreview(preview, {
    company: "Acme Pte. Ltd.",
  });
  assert.equal(revised.confidence.fields.company, "high");
  assert.equal(revised.confidence.fields.role, "medium");
  assert.equal(revised.confidence.fields.location, "low");
  assert.equal(revised.confidence.fields.description, "low");
  assert.equal(revised.confidence.overall, "low");
  assert.ok(revised.warnings.some(({ code, message }) =>
    code === "parser_notice" && message === "地点由模型整理，请核对"));

  const fork = await imports.forkCareerJobImportPreview(preview, { now: NEXT });
  assert.deepEqual(fork.candidate, preview.candidate);
  assert.deepEqual(fork.confidence, preview.confidence);
  assert.deepEqual(fork.warnings, preview.warnings);
  assert.notEqual(fork.importOperationId, preview.importOperationId);
});

test("a high model claim cannot override known low required-field confidence", async () => {
  const preview = await imports.createCareerJobImportPreview({
    sourceText: "plain JD text",
    importOperationId: OP_A,
    now: NOW,
    parsedCandidate: { company: "", role: "", confidence: "high" },
  });
  assert.equal(preview.confidence.overall, "low");
  assert.equal(preview.confidence.fields.company, "low");
  assert.equal(preview.confidence.fields.role, "low");
});

test("editing a folded duplicate into a distinct job automatically gives it a new operation", async () => {
  const csv = "Company,Title\nAcme,Designer\nAcme,Designer\n";
  const parsed = await imports.parseCareerCsvImportPreview(csv, {
    sourceHint: "LinkedIn",
    now: NOW,
  });
  const changed = await imports.reviseCareerJobImportPreview(parsed.rows[1], {
    role: "Design Engineer",
  });
  assert.notEqual(changed.importOperationId, parsed.rows[1].importOperationId);
  assert.notEqual(changed.jobId, parsed.rows[1].jobId);
  assert.equal(changed.duplicateOfRowNumber, undefined);
  assert.ok(!changed.warnings.some(({ code }) => code === "csv_duplicate_row"));

  const scope = await fixture();
  try {
    const result = await imports.commitCareerJobImports({
      items: [parsed.rows[0], changed].map((preview) => ({
        preview,
        currentSourceFingerprint: parsed.sourceFingerprint,
      })),
    });
    assert.equal(result.writtenCount, 2);
    assert.equal(count(scope.database, "career_jobs"), 2);
  } finally {
    scope.close();
  }
});

test("free-text mentions do not invent a platform, and controls are canonicalized safely", async () => {
  const preview = await imports.createCareerJobImportPreview({
    sourceText: "You will report to your boss and research LinkedIn trends.",
    importOperationId: OP_A,
    now: NOW,
    parsedCandidate: {
      company: "Acme\u0000\n Labs",
      role: "Product\t Designer",
      description: "line one\u0000\r\nline two\tkept",
      confidence: "high",
    },
  });
  assert.equal(preview.candidate.company, "Acme Labs");
  assert.equal(preview.candidate.role, "Product Designer");
  assert.equal(preview.candidate.description, "line one\nline two\tkept");
  assert.equal(preview.candidate.source, "待确认来源");
  assert.equal(preview.candidate.sourceUrl, "");
  assert.equal(preview.confidence.overall, "low");
  assert.ok(preview.warnings.some(({ code }) => code === "unknown_source"));
});

test("CSV structure limits, strict quote boundaries, and column counts fail safely before writes", async () => {
  const oversized = "x".repeat(16 * 1024 * 1024 + 1);
  await assert.rejects(
    imports.fingerprintCareerImportSource(oversized),
    (error) => error instanceof imports.CareerImportError && error.code === "invalid_preview",
  );
  const tooManyRows = `Company,Title\n${Array.from({ length: 2_001 }, (_, index) =>
    `Company ${index},Role`).join("\n")}`;
  await assert.rejects(
    imports.parseCareerCsvImportPreview(tooManyRows),
    (error) => error instanceof imports.CareerImportError && error.code === "invalid_preview",
  );
  const tooManyColumns = `${Array.from({ length: 201 }, (_, index) => `h${index}`).join(",")}\n`;
  await assert.rejects(
    imports.parseCareerCsvImportPreview(tooManyColumns),
    (error) => error instanceof imports.CareerImportError && error.code === "invalid_preview",
  );
  const tooLargeCell = `Company,Title,Description\nAcme,Designer,"${"x".repeat(200_001)}"`;
  await assert.rejects(
    imports.parseCareerCsvImportPreview(tooLargeCell),
    (error) => error instanceof imports.CareerImportError && error.code === "invalid_preview",
  );
  await assert.rejects(
    imports.createCareerJobImportPreview({
      sourceText: "short",
      parsedCandidate: {
        company: "Acme",
        role: "Designer",
        warnings: Array.from({ length: 51 }, (_, index) => `warning ${index}`),
      },
    }),
    (error) => error instanceof imports.CareerImportError && error.code === "invalid_preview",
  );

  const strict = await imports.parseCareerCsvImportPreview(
    'Company,Title\n"Acme" ,Designer\n',
    { sourceHint: "LinkedIn", now: NOW },
  );
  assert.ok(strict.rows[0].warnings.some(({ code, severity }) =>
    code === "csv_malformed" && severity === "blocking"));
  const mismatch = await imports.parseCareerCsvImportPreview(
    "Company,Title,URL\nAcme,Designer,unexpected,https://example.com/right\n",
    { sourceHint: "LinkedIn", now: NOW },
  );
  assert.ok(mismatch.rows[0].warnings.some(({ code, severity }) =>
    code === "csv_column_mismatch" && severity === "blocking"));
});

test("prototype-like CSV headers stay unknown and cannot affect header mapping", async () => {
  const parsed = await imports.parseCareerCsvImportPreview(
    "__proto__,constructor,company,title\nleft,right,Acme,Designer\n",
    { sourceHint: "LinkedIn", now: NOW },
  );
  assert.equal(parsed.rows[0].candidate.company, "Acme");
  assert.equal(parsed.rows[0].candidate.role, "Designer");
  const unknownHeaders = parsed.warnings.filter(({ code }) => code === "csv_unknown_header");
  assert.equal(unknownHeaders.length, 2);
  assert.match(unknownHeaders[0].message, /__proto__/);
  assert.match(unknownHeaders[1].message, /constructor/);
});

test("revising one field cannot clear a blocking CSV column mismatch", async () => {
  const parsed = await imports.parseCareerCsvImportPreview(
    "Company,Title,Location,URL\r\nAcme,Designer,EXTRA,Singapore,https://www.linkedin.com/jobs/view/42",
    { sourceHint: "LinkedIn", now: NOW },
  );
  const original = parsed.rows[0];
  assert.equal(original.candidate.location, "EXTRA");
  assert.equal(original.candidate.sourceUrl, "");
  assert.ok(original.warnings.some(({ code, severity }) =>
    code === "csv_column_mismatch" && severity === "blocking"));

  const revised = await imports.reviseCareerJobImportPreview(original, {
    sourceUrl: "https://www.linkedin.com/jobs/view/42",
  });
  assert.equal(revised.importOperationId, original.importOperationId);
  assert.equal(revised.candidate.location, "EXTRA");
  assert.ok(revised.warnings.some(({ code, severity }) =>
    code === "csv_column_mismatch" && severity === "blocking"));

  const scope = await fixture();
  try {
    await assert.rejects(
      imports.commitCareerJobImport({
        preview: revised,
        currentSourceFingerprint: parsed.sourceFingerprint,
      }),
      (error) => error instanceof imports.CareerImportError &&
        error.code === "invalid_preview",
    );
    assert.equal(globalThis.__careerImportLockState.writes, 0);
    assert.equal(scope.state.queries, 0);
    assert.equal(scope.state.batches, 0);
    assert.equal(count(scope.database, "career_jobs"), 0);
    assert.equal(count(scope.database, "career_activity"), 0);
  } finally {
    scope.close();
  }
});

test("a durable commit with a lost response and failed verification is uncertain, then inspect reconciles read-only", async () => {
  const scope = await fixture();
  try {
    const preview = await smartPreview();
    scope.state.throwAfterCommit = true;
    scope.state.failRecoveryQueriesAfterCommit = true;
    let caught;
    try {
      await imports.commitCareerJobImport({
        preview,
        currentSourceFingerprint: preview.sourceFingerprint,
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof imports.CareerImportCommitUncertainError);
    assert.equal(caught.code, "commit_uncertain");
    assert.equal(caught.identities[0].jobId, preview.jobId);
    assert.doesNotMatch(caught.message, /SELECT|sqlite|career_/i);
    assert.equal(count(scope.database, "career_jobs"), 1);
    assert.equal(count(scope.database, "career_activity"), 1);
    const batches = scope.state.batches;
    const inspection = await imports.inspectCareerImportCommit(preview);
    assert.equal(inspection.status, "exact_committed");
    assert.equal(inspection.previewFingerprint, preview.previewFingerprint);
    assert.equal(scope.state.batches, batches);
    assert.equal(globalThis.__careerImportLockState.reads, 1);
  } finally {
    scope.close();
  }
});

test("preflight query failures are neutralized without leaking SQL or claiming a write started", async () => {
  const scope = await fixture();
  try {
    const preview = await smartPreview();
    scope.state.queryFailuresRemaining = 1;
    await assert.rejects(
      imports.commitCareerJobImport({
        preview,
        currentSourceFingerprint: preview.sourceFingerprint,
      }),
      (error) => error instanceof imports.CareerImportError &&
        error.code === "write_failed" &&
        !/SELECT|sqlite|career_/i.test(error.message),
    );
    assert.equal(scope.state.batches, 0);
    assert.equal(count(scope.database, "career_jobs"), 0);
  } finally {
    scope.close();
  }
});

test("activity-only occupation conflicts before the transactional batch", async () => {
  const scope = await fixture();
  try {
    const preview = await smartPreview();
    executeRun(
      scope.database,
      "INSERT INTO career_activity(id,job_id,type,detail,created_at) VALUES(?,NULL,'import','occupied',?)",
      [preview.activityId, NOW],
    );
    await assert.rejects(
      imports.commitCareerJobImport({
        preview,
        currentSourceFingerprint: preview.sourceFingerprint,
      }),
      (error) => error instanceof imports.CareerImportError && error.code === "operation_conflict",
    );
    assert.equal(scope.state.batches, 0);
    assert.equal(count(scope.database, "career_jobs"), 0);
    assert.equal(count(scope.database, "career_activity"), 1);
  } finally {
    scope.close();
  }
});

test("one thousand unique rows use bounded lock-held reads and one transaction", async () => {
  const csv = `Company,Title\n${Array.from({ length: 1_000 }, (_, index) =>
    `Company ${index},Role ${index}`).join("\n")}`;
  const parsed = await imports.parseCareerCsvImportPreview(csv, {
    sourceHint: "LinkedIn",
    now: NOW,
  });
  assert.equal(parsed.rows.length, 1_000);
  const scope = await fixture();
  try {
    const result = await imports.commitCareerJobImports({
      items: parsed.rows.map((preview) => ({
        preview,
        currentSourceFingerprint: parsed.sourceFingerprint,
      })),
    });
    assert.equal(result.writtenCount, 1_000);
    assert.equal(scope.state.batches, 1);
    assert.equal(scope.state.batchSizes[0], 2_000);
    assert.ok(scope.state.queries <= 7, `expected bounded queries, received ${scope.state.queries}`);
    assert.equal(count(scope.database, "career_jobs"), 1_000);
    assert.equal(count(scope.database, "career_activity"), 1_000);
  } finally {
    scope.close();
  }
});
