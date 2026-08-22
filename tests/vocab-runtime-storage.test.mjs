import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

function stringValue(expression) {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  return null;
}

function arraySql(source, variableName) {
  const file = ts.createSourceFile(
    "store.ts",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  let values = null;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      values = node.initializer.elements.flatMap((element) => {
        if (!ts.isObjectLiteralExpression(element)) return [];
        const property = element.properties.find(
          (candidate) =>
            ts.isPropertyAssignment(candidate) &&
            ((ts.isIdentifier(candidate.name) && candidate.name.text === "sql") ||
              (ts.isStringLiteral(candidate.name) && candidate.name.text === "sql")),
        );
        if (!property || !ts.isPropertyAssignment(property)) return [];
        const value = stringValue(property.initializer);
        return value === null ? [] : [value];
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(values, `missing ${variableName}`);
  return values;
}

function executeRun(database, sql, params = []) {
  const statement = database.prepare(sql);
  try {
    if (params.length) statement.bind(params);
    while (statement.step()) {
      // Consume rows returned by PRAGMA and RETURNING statements.
    }
  } finally {
    statement.finalize();
  }
  return {
    changes: Number(database.changes()),
    lastInsertRowId: database.selectValue("SELECT last_insert_rowid()") ?? null,
  };
}

function adapterFor(database) {
  return {
    async init() {
      return {
        database: "shici",
        filename: "shici.sqlite3",
        persistent: true,
        sqliteVersion: "test",
        schemaVersion: Number(database.selectValue("PRAGMA user_version") ?? 0),
        seeded: false,
      };
    },
    async query(_name, sql, params = []) {
      const rows = database.selectObjects(sql, params);
      return { columns: [], rows, rowCount: rows.length };
    },
    async run(_name, sql, params = []) {
      return executeRun(database, sql, params);
    },
    async batch(_name, statements, options = {}) {
      if (globalThis.__vocabBatchFault === "before_commit") {
        globalThis.__vocabBatchFault = null;
        throw new Error("injected batch failure before commit");
      }
      const operation = () => statements.map(({ sql, params = [] }) =>
        executeRun(database, sql, params)
      );
      const results = options.transaction === false
        ? operation()
        : database.transaction("IMMEDIATE", operation);
      if (globalThis.__vocabBatchFault === "after_commit") {
        globalThis.__vocabBatchFault = null;
        throw new Error("injected worker response loss after commit");
      }
      return {
        results,
        changes: results.reduce((sum, result) => sum + result.changes, 0),
      };
    },
    async export() {
      throw new Error("not needed in this test");
    },
    async import() {
      throw new Error("not needed in this test");
    },
  };
}

globalThis.__vocabLocalDbProxy = {
  init(...args) {
    return globalThis.__vocabLocalDbAdapter.init(...args);
  },
  query(...args) {
    return globalThis.__vocabLocalDbAdapter.query(...args);
  },
  run(...args) {
    return globalThis.__vocabLocalDbAdapter.run(...args);
  },
  batch(...args) {
    return globalThis.__vocabLocalDbAdapter.batch(...args);
  },
  export(...args) {
    return globalThis.__vocabLocalDbAdapter.export(...args);
  },
  import(...args) {
    return globalThis.__vocabLocalDbAdapter.import(...args);
  },
};

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function transpile(relativePath) {
  const source = await readFile(new URL(relativePath, projectRoot), "utf8");
  const result = ts.transpileModule(source, {
    fileName: relativePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  assert.deepEqual(
    (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  return result.outputText;
}

const [lockJavaScript, srsJavaScript, rawStoreJavaScript] = await Promise.all([
  transpile("lib/vocab/lock.ts"),
  transpile("lib/vocab/srs.ts"),
  transpile("lib/vocab/store.ts"),
]);
const dependencyUrls = {
  "@/lib/local-db/client": moduleUrl(
    "export const localDb = globalThis.__vocabLocalDbProxy;",
  ),
  "./content": moduleUrl(
    "export function uid(prefix){ return `${prefix}_${crypto.randomUUID()}`; }",
  ),
  "./lock": moduleUrl(lockJavaScript),
  "./srs": moduleUrl(srsJavaScript),
};
let storeJavaScript = rawStoreJavaScript;
for (const [specifier, url] of Object.entries(dependencyUrls)) {
  storeJavaScript = storeJavaScript.replaceAll(`"${specifier}"`, `"${url}"`);
}
const store = await import(moduleUrl(storeJavaScript));
const storeSource = await readFile(
  new URL("lib/vocab/store.ts", projectRoot),
  "utf8",
);
const legacySql = arraySql(storeSource, "legacySchemaStatements");

async function databaseFixture() {
  const sqlite3 = await sqlite3InitModule();
  const database = new sqlite3.oo1.DB(":memory:", "c");
  database.exec("PRAGMA foreign_keys=ON");
  globalThis.__vocabBatchFault = null;
  globalThis.__vocabLocalDbAdapter = adapterFor(database);
  return database;
}

function installLegacy(database) {
  database.transaction("IMMEDIATE", () => {
    for (const sql of legacySql) database.exec(sql);
  });
}

function usefulExplanation(canonical, gloss) {
  return {
    target: { canonical },
    sense: {
      glosses_en: [gloss],
      explanation_en: `${gloss}.`,
    },
  };
}

function installLegacySeedSubset(
  database,
  withUserOccurrence = false,
  withUserReview = withUserOccurrence,
) {
  installLegacy(database);
  database.exec(`INSERT INTO vocab_items(
    id,kind,title,description,source,source_url,author,published_at,
    duration_ms,audio_url,status,progress,created_at,updated_at
  ) VALUES (
    'seed_article_deliberate','article','Seed title','','',NULL,'','',
    0,NULL,'in_progress',0.4,1,1
  )`);
  database.exec(`INSERT INTO vocab_blocks(id,item_id,ordinal,kind,text)
    VALUES('seed_block_4','seed_article_deliberate',3,'paragraph','A deliberate choice.')`);
  database.exec(`INSERT INTO vocab_lexemes(
    id,headword,normalized_key,pronunciation,gloss_en,explanation_en,
    explanation_zh,status,starred,notes,lookup_count,created_at,updated_at
  ) VALUES(
    'seed_lexeme_deliberate','deliberate','deliberate','','intentional',
    'chosen with care','','learning',0,'',1,1,1
  )`);
  database.exec(`INSERT INTO vocab_occurrences(
    id,lexeme_id,item_id,block_id,segment_id,surface,context_before,
    context_sentence,context_after,start_utf16,end_utf16,start_ms,note,
    explanation_json,created_at
  ) VALUES(
    'seed_occ_deliberate','seed_lexeme_deliberate','seed_article_deliberate',
    'seed_block_4',NULL,'deliberate','','A deliberate choice.','',2,12,NULL,'','',1
  )`);
  database.exec(`INSERT INTO vocab_review_cards(
    id,lexeme_id,state,due_at,interval_days,ease,reps,lapses,last_review_at
  ) VALUES(
    'seed_card_deliberate','seed_lexeme_deliberate','review',1,3,2.5,4,0,1
  )`);
  database.exec(`INSERT INTO vocab_activity(
    id,day,read_seconds,listen_seconds,review_count,lookups,created_at
  ) VALUES('seed_activity_today','2026-08-20',1320,780,7,4,1)`);
  if (withUserOccurrence) {
    database.exec(`INSERT INTO vocab_occurrences(
      id,lexeme_id,item_id,block_id,segment_id,surface,context_before,
      context_sentence,context_after,start_utf16,end_utf16,start_ms,note,
      explanation_json,created_at
    ) VALUES(
      'user_occurrence','seed_lexeme_deliberate','seed_article_deliberate',
      'seed_block_4',NULL,'deliberate','','My deliberate choice.','',3,13,NULL,
      'personal note','',2
    )`);
  }
  if (withUserReview) {
    database.exec(`INSERT INTO vocab_review_events(
      id,card_id,rating,reviewed_at,before_json,after_json,undone_at
    ) VALUES(
      'user_review','seed_card_deliberate','good',2,
      '{"state":"review"}','{"state":"review"}',NULL
    )`);
  }
}

test("fresh install writes a versioned empty runtime without fictional learning data", async () => {
  const database = await databaseFixture();
  try {
    await store.initializeVocabDatabase();
    await store.initializeVocabDatabase();
    assert.equal(
      Number(database.selectValue("PRAGMA application_id")),
      store.VOCAB_APPLICATION_ID,
    );
    assert.equal(
      Number(database.selectValue("PRAGMA user_version")),
      store.VOCAB_RUNTIME_VERSION,
    );
    assert.deepEqual(
      database.selectObjects(
        "SELECT version,name FROM vocab_schema_migrations ORDER BY version",
      ).map((row) => ({ ...row })),
      [
        { version: 1, name: "formalize-runtime-schema" },
        { version: 2, name: "srs-v2" },
      ],
    );
    for (const table of [
      "vocab_items",
      "vocab_lexemes",
      "vocab_occurrences",
      "vocab_review_cards",
      "vocab_review_events",
      "vocab_activity",
      "vocab_settings",
    ]) {
      assert.equal(Number(database.selectValue(`SELECT COUNT(*) FROM ${table}`)), 0);
    }
    assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("exact app_id=0 legacy runtime is adopted without changing user rows", async () => {
  const database = await databaseFixture();
  try {
    installLegacy(database);
    database.exec(`INSERT INTO vocab_items(
      id,kind,title,description,source,source_url,author,published_at,
      duration_ms,audio_url,status,progress,created_at,updated_at
    ) VALUES ('kept','article','Kept','','',NULL,'','',0,NULL,'unread',0,1,1)`);

    await store.initializeVocabDatabase();
    assert.equal(database.selectValue(
      "SELECT title FROM vocab_items WHERE id='kept'",
    ), "Kept");
    assert.equal(
      Number(database.selectValue("PRAGMA application_id")),
      store.VOCAB_APPLICATION_ID,
    );
    assert.equal(Number(database.selectValue("PRAGMA user_version")), 2);
    assert.deepEqual(
      database.selectObjects(
        "SELECT version,name FROM vocab_schema_migrations ORDER BY version",
      ).map((row) => ({ ...row })),
      [
        { version: 1, name: "adopt-exact-legacy-runtime" },
        { version: 2, name: "srs-v2" },
      ],
    );
  } finally {
    database.close();
  }
});

test("canonical v1 runtime migrates through its ledger to v2", async () => {
  const database = await databaseFixture();
  try {
    installLegacy(database);
    database.exec(`CREATE TABLE vocab_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`);
    database.exec(
      "INSERT INTO vocab_schema_migrations(version,name,applied_at) VALUES(1,'formalize-runtime-schema',1)",
    );
    database.exec(`PRAGMA application_id=${store.VOCAB_APPLICATION_ID}`);
    database.exec("PRAGMA user_version=1");

    await store.initializeVocabDatabase();

    assert.equal(Number(database.selectValue("PRAGMA user_version")), 2);
    assert.deepEqual(
      database.selectObjects(
        "SELECT version,name FROM vocab_schema_migrations ORDER BY version",
      ).map((row) => ({ ...row })),
      [
        { version: 1, name: "formalize-runtime-schema" },
        { version: 2, name: "srs-v2" },
      ],
    );
    assert.deepEqual(
      database.selectObjects("PRAGMA table_info(vocab_review_cards)")
        .map((column) => column.name)
        .slice(-4),
      [
        "algorithm_version",
        "suspended_from_state",
        "suspended_reason",
        "updated_at",
      ],
    );
    assert.equal(
      database.selectObjects("PRAGMA table_info(vocab_review_events)").at(-1).name,
      "activity_id",
    );
  } finally {
    database.close();
  }
});

test("legacy product seeds are removed once by exact IDs", async () => {
  const database = await databaseFixture();
  try {
    installLegacySeedSubset(database);
    await store.initializeVocabDatabase();

    for (const [table, id] of [
      ["vocab_items", "seed_article_deliberate"],
      ["vocab_blocks", "seed_block_4"],
      ["vocab_occurrences", "seed_occ_deliberate"],
      ["vocab_review_cards", "seed_card_deliberate"],
      ["vocab_lexemes", "seed_lexeme_deliberate"],
      ["vocab_activity", "seed_activity_today"],
    ]) {
      assert.equal(
        Number(database.selectValue(`SELECT COUNT(*) FROM ${table} WHERE id=?`, [id])),
        0,
      );
    }
    const marker = database.selectObjects(
      "SELECT value,updated_at FROM vocab_settings WHERE key='__shici_system_legacy_seed_cleanup_v1'",
    ).at(0);
    assert.equal(marker.value, "complete");
    await store.initializeVocabDatabase();
    assert.equal(
      database.selectValue(
        "SELECT updated_at FROM vocab_settings WHERE key='__shici_system_legacy_seed_cleanup_v1'",
      ),
      marker.updated_at,
    );
    assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("seed cleanup preserves user occurrences and review history with safe FKs", async () => {
  const database = await databaseFixture();
  try {
    installLegacySeedSubset(database, true);
    await store.initializeVocabDatabase();

    assert.equal(database.selectValue(
      "SELECT COUNT(*) FROM vocab_items WHERE id='seed_article_deliberate'",
    ), 0);
    assert.equal(database.selectValue(
      "SELECT COUNT(*) FROM vocab_occurrences WHERE id='seed_occ_deliberate'",
    ), 0);
    assert.deepEqual(
      database.selectObjects(
        `SELECT lexeme_id,item_id,block_id,note
         FROM vocab_occurrences WHERE id='user_occurrence'`,
      ).map((row) => ({ ...row })),
      [{
        lexeme_id: "seed_lexeme_deliberate",
        item_id: null,
        block_id: null,
        note: "personal note",
      }],
    );
    assert.equal(database.selectValue(
      "SELECT COUNT(*) FROM vocab_review_events WHERE id='user_review'",
    ), 1);
    assert.equal(database.selectValue(
      "SELECT COUNT(*) FROM vocab_review_cards WHERE id='seed_card_deliberate'",
    ), 1);
    assert.equal(database.selectValue(
      "SELECT COUNT(*) FROM vocab_activity WHERE id='seed_activity_today'",
    ), 0);
    assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);

    const preserved = (await store.loadVocabSnapshot()).reviewCards.find(
      ({ id }) => id === "seed_card_deliberate",
    );
    assert.ok(preserved);
    const rating = await store.prepareVocabReviewRating(preserved, "good");
    globalThis.__vocabBatchFault = "after_commit";
    assert.equal((await store.commitVocabReviewRating(rating)).status, "exact");
    assert.equal(await store.inspectVocabReviewRating(rating), "exact");
    const undo = await store.prepareVocabReviewUndo(rating.eventId);
    globalThis.__vocabBatchFault = "after_commit";
    assert.equal((await store.commitVocabReviewUndo(undo)).status, "exact");
    assert.equal(await store.inspectVocabReviewUndo(undo), "exact");
    assert.equal(database.selectValue(
      "SELECT COUNT(*) FROM vocab_review_events WHERE id='user_review'",
    ), 1);
  } finally {
    database.close();
  }
});

test("a user occurrence alone gets a clean replacement card after seed removal", async () => {
  const database = await databaseFixture();
  try {
    installLegacySeedSubset(database, true, false);
    await store.initializeVocabDatabase();

    assert.equal(database.selectValue(
      "SELECT COUNT(*) FROM vocab_occurrences WHERE id='user_occurrence'",
    ), 1);
    assert.equal(database.selectValue(
      "SELECT COUNT(*) FROM vocab_review_cards WHERE id='seed_card_deliberate'",
    ), 0);
    const replacement = database.selectObjects(
      `SELECT id,state,reps,lapses FROM vocab_review_cards
       WHERE lexeme_id='seed_lexeme_deliberate'`,
    ).at(0);
    assert.ok(replacement);
    assert.notEqual(replacement.id, "seed_card_deliberate");
    assert.deepEqual(
      { state: replacement.state, reps: replacement.reps, lapses: replacement.lapses },
      { state: "new", reps: 0, lapses: 0 },
    );
    assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("legacy detection rejects an app_id=0 database with any unknown table", async () => {
  const database = await databaseFixture();
  try {
    installLegacy(database);
    database.exec("CREATE TABLE unrelated_private_data(id TEXT PRIMARY KEY)");
    await assert.rejects(
      store.initializeVocabDatabase(),
      /不是可识别的旧版拾词数据库/,
    );
    assert.equal(Number(database.selectValue("PRAGMA application_id")), 0);
    assert.equal(Number(database.selectValue("PRAGMA user_version")), 0);
    assert.equal(
      database.selectValue(
        "SELECT COUNT(*) FROM sqlite_schema WHERE name='vocab_schema_migrations'",
      ),
      0,
    );
  } finally {
    database.close();
  }
});

test("review undo restores both the card and its activity row", async () => {
  const database = await databaseFixture();
  try {
    await store.initializeVocabDatabase();
    const itemId = await store.saveArticle({
      title: "A real article",
      description: "",
      author: "",
      source: "local",
      blocks: [{ kind: "paragraph", text: "C++ remains useful." }],
    }, "paste");
    const saved = await store.saveOccurrence({
      surface: "C++",
      sentence: "C++ remains useful.",
      before: "",
      after: "",
      itemId,
      startUtf16: 0,
      endUtf16: 3,
    }, usefulExplanation("C++", "a systems programming language"));
    await store.updateLexemeStatus(saved.lexemeId, "learning");
    const before = await store.loadVocabSnapshot();
    const card = before.reviewCards.find(
      (candidate) => candidate.lexeme_id === saved.lexemeId,
    );
    assert.ok(card);
    assert.equal(card.cloze_sentence, "____ remains useful.");

    const eventId = await store.rateReview(card, "good");
    assert.ok(
      Number(database.selectValue(
        "SELECT updated_at FROM vocab_review_cards WHERE id=?",
        [card.id],
      )) > card.updated_at,
    );
    await assert.rejects(
      store.rateReview(card, "easy"),
      /已发生变化/,
    );
    assert.equal(
      Number(database.selectValue("SELECT SUM(review_count) FROM vocab_activity")),
      1,
    );
    assert.equal(
      Number(database.selectValue(
        "SELECT reps FROM vocab_review_cards WHERE id=?",
        [card.id],
      )),
      1,
    );

    await store.undoReview(eventId);
    assert.equal(
      Number(database.selectValue("SELECT SUM(review_count) FROM vocab_activity")),
      0,
    );
    assert.deepEqual(
      database.selectObjects(
        `SELECT state,reps,lapses,algorithm_version
         FROM vocab_review_cards WHERE id=?`,
        [card.id],
      ).map((row) => ({ ...row })),
      [{ state: "new", reps: 0, lapses: 0, algorithm_version: 2 }],
    );
    assert.equal(
      Number(database.selectValue(
        "SELECT undone_at IS NOT NULL FROM vocab_review_events WHERE id=?",
        [eventId],
      )),
      1,
    );
  } finally {
    database.close();
  }
});

test("only learning resumes a managed card while saved, known, and ignored stay suspended", async () => {
  const database = await databaseFixture();
  try {
    await store.initializeVocabDatabase();
    const itemId = await store.saveArticle({
      title: "Status article",
      description: "",
      author: "",
      source: "local",
      blocks: [{ kind: "paragraph", text: "Steady work helps." }],
    }, "paste");
    const { lexemeId } = await store.saveOccurrence({
      surface: "Steady",
      sentence: "Steady work helps.",
      before: "",
      after: "",
      itemId,
      startUtf16: 0,
      endUtf16: 6,
    }, usefulExplanation("steady", "stable and consistent"));

    await store.updateLexemeStatus(lexemeId, "known");
    assert.deepEqual(
      database.selectObjects(
        `SELECT state,suspended_from_state,suspended_reason
         FROM vocab_review_cards WHERE lexeme_id=?`,
        [lexemeId],
      ).map((row) => ({ ...row })),
      [{
        state: "suspended",
        suspended_from_state: "new",
        suspended_reason: "lexeme_known",
      }],
    );

    await store.updateLexemeStatus(lexemeId, "saved");
    assert.deepEqual(
      database.selectObjects(
        `SELECT state,suspended_from_state,suspended_reason
         FROM vocab_review_cards WHERE lexeme_id=?`,
        [lexemeId],
      ).map((row) => ({ ...row })),
      [{
        state: "suspended",
        suspended_from_state: "new",
        suspended_reason: "lexeme_saved",
      }],
    );
    await store.updateLexemeStatus(lexemeId, "learning");
    assert.deepEqual(
      database.selectObjects(
        `SELECT state,suspended_from_state,suspended_reason
         FROM vocab_review_cards WHERE lexeme_id=?`,
        [lexemeId],
      ).map((row) => ({ ...row })),
      [{ state: "new", suspended_from_state: null, suspended_reason: null }],
    );
  } finally {
    database.close();
  }
});

test("snapshot reading excludes a legacy active saved card and initialization converges it", async () => {
  const database = await databaseFixture();
  try {
    await store.initializeVocabDatabase();
    const itemId = await store.saveArticle({
      title: "Legacy saved card",
      description: "",
      author: "",
      source: "local",
      blocks: [{ kind: "paragraph", text: "Steady work helps." }],
    }, "paste");
    const { lexemeId } = await store.saveOccurrence({
      surface: "Steady",
      sentence: "Steady work helps.",
      before: "",
      after: "",
      itemId,
      startUtf16: 0,
      endUtf16: 6,
    }, usefulExplanation("steady", "stable and consistent"));
    executeRun(
      database,
      `UPDATE vocab_review_cards SET state='review',suspended_from_state=NULL,
        suspended_reason=NULL WHERE lexeme_id=?`,
      [lexemeId],
    );
    assert.equal(
      (await store.loadVocabSnapshot()).reviewCards.some((card) =>
        card.lexeme_id === lexemeId
      ),
      false,
      "read path never exposes an active card for a saved lexeme",
    );
    await store.initializeVocabDatabase();
    assert.deepEqual(
      database.selectObjects(
        `SELECT state,suspended_from_state,suspended_reason
         FROM vocab_review_cards WHERE lexeme_id=?`,
        [lexemeId],
      ).map((row) => ({ ...row })),
      [{
        state: "suspended",
        suspended_from_state: "review",
        suspended_reason: "lexeme_saved",
      }],
    );
  } finally {
    database.close();
  }
});

test("a word without a useful English explanation stays out of review until enriched", async () => {
  const database = await databaseFixture();
  try {
    await store.initializeVocabDatabase();
    const itemId = await store.saveArticle({
      title: "Explanation article",
      description: "",
      author: "",
      source: "local",
      blocks: [{ kind: "paragraph", text: "Opaque terms need context." }],
    }, "paste");
    const first = await store.saveOccurrence({
      surface: "Opaque",
      sentence: "Opaque terms need context.",
      before: "",
      after: "",
      itemId,
      startUtf16: 0,
      endUtf16: 6,
    }, null);
    await store.updateLexemeStatus(first.lexemeId, "learning");
    assert.deepEqual(
      database.selectObjects(
        `SELECT state,suspended_from_state,suspended_reason
         FROM vocab_review_cards WHERE lexeme_id=?`,
        [first.lexemeId],
      ).map((row) => ({ ...row })),
      [{
        state: "suspended",
        suspended_from_state: "new",
        suspended_reason: "missing_explanation",
      }],
    );
    assert.equal(
      (await store.loadVocabSnapshot()).reviewCards.some(
        (card) => card.lexeme_id === first.lexemeId,
      ),
      false,
    );

    await store.saveOccurrence({
      surface: "Opaque",
      sentence: "Opaque terms need context.",
      before: "",
      after: "",
      itemId,
      startUtf16: 0,
      endUtf16: 6,
    }, usefulExplanation("opaque", "not transparent or difficult to understand"));
    assert.deepEqual(
      database.selectObjects(
        `SELECT state,suspended_from_state,suspended_reason
         FROM vocab_review_cards WHERE lexeme_id=?`,
        [first.lexemeId],
      ).map((row) => ({ ...row })),
      [{ state: "new", suspended_from_state: null, suspended_reason: null }],
    );
    const restored = (await store.loadVocabSnapshot()).reviewCards.find(
      (card) => card.lexeme_id === first.lexemeId,
    );
    assert.ok(restored);
    assert.match(restored.gloss_en, /not transparent/i);
  } finally {
    database.close();
  }
});

test("bookmark creation is idempotent for an item and locator", async () => {
  const database = await databaseFixture();
  try {
    await store.initializeVocabDatabase();
    const itemId = await store.saveArticle({
      title: "Bookmark article",
      description: "",
      author: "",
      source: "local",
      blocks: [{ kind: "paragraph", text: "Keep this place." }],
    }, "paste");
    await store.createBookmark(itemId, "block:0", "Paragraph one");
    await store.createBookmark(itemId, "block:0", "Paragraph one");
    assert.equal(
      Number(database.selectValue(
        "SELECT COUNT(*) FROM vocab_bookmarks WHERE item_id=? AND locator=?",
        [itemId, "block:0"],
      )),
      1,
    );
  } finally {
    database.close();
  }
});

test("article and podcast receipts recover response loss and reject changed projections", async () => {
  const database = await databaseFixture();
  try {
    await store.initializeVocabDatabase();
    const article = {
      title: "Receipt article",
      description: "saved once",
      author: "",
      source: "local",
      blocks: [
        { kind: "heading", text: "One" },
        { kind: "paragraph", text: "The durable paragraph." },
      ],
    };
    const articleReceipt = await store.prepareVocabArticleWrite(article, "paste");
    globalThis.__vocabBatchFault = "after_commit";
    assert.equal(
      await store.saveArticle(article, "paste", articleReceipt),
      articleReceipt.itemId,
    );
    assert.equal(
      await store.inspectVocabImportWrite(articleReceipt),
      "exact_saved",
    );
    assert.equal(
      await store.saveArticle(article, "paste", articleReceipt),
      articleReceipt.itemId,
    );
    assert.equal(Number(database.selectValue(
      "SELECT COUNT(*) FROM vocab_items WHERE id=?",
      [articleReceipt.itemId],
    )), 1);
    assert.equal(Number(database.selectValue(
      "SELECT COUNT(*) FROM vocab_blocks WHERE item_id=?",
      [articleReceipt.itemId],
    )), 2);
    assert.equal(Number(database.selectValue(
      "SELECT COUNT(*) FROM vocab_imports WHERE id=?",
      [articleReceipt.importId],
    )), 1);
    await store.updateItemProgress(articleReceipt.itemId, 0.5);
    assert.equal(
      await store.inspectVocabImportWrite(articleReceipt),
      "exact_saved",
    );
    assert.equal(
      await store.saveArticle(article, "paste", articleReceipt),
      articleReceipt.itemId,
    );
    assert.equal(Number(database.selectValue(
      "SELECT progress FROM vocab_items WHERE id=?",
      [articleReceipt.itemId],
    )), 0.5);
    await assert.rejects(
      store.saveArticle(
        { ...article, title: "Changed after checkpoint" },
        "paste",
        articleReceipt,
      ),
      (error) => error?.code === "VOCAB_WRITE_CONFLICT",
    );

    const podcast = {
      title: "Receipt podcast",
      description: "saved once",
      source: "local",
      durationMs: 2_000,
      segments: [
        { start_ms: 0, end_ms: 2_000, text: "Only one segment." },
      ],
    };
    const podcastReceipt = await store.prepareVocabPodcastWrite(podcast, "rss");
    globalThis.__vocabBatchFault = "after_commit";
    assert.equal(
      await store.savePodcast(podcast, "rss", podcastReceipt),
      podcastReceipt.itemId,
    );
    assert.equal(
      await store.savePodcast(podcast, "rss", podcastReceipt),
      podcastReceipt.itemId,
    );
    assert.equal(Number(database.selectValue(
      "SELECT COUNT(*) FROM vocab_items WHERE id=?",
      [podcastReceipt.itemId],
    )), 1);
    assert.equal(Number(database.selectValue(
      "SELECT COUNT(*) FROM vocab_transcript_segments WHERE item_id=?",
      [podcastReceipt.itemId],
    )), 1);
    await assert.rejects(
      store.savePodcast(
        { ...podcast, segments: [{ ...podcast.segments[0], text: "Changed" }] },
        "rss",
        podcastReceipt,
      ),
      (error) => error?.code === "VOCAB_WRITE_CONFLICT",
    );
    assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
  } finally {
    globalThis.__vocabBatchFault = null;
    database.close();
  }
});

test("one occurrence receipt atomically saves its note and lookup activity exactly once", async () => {
  const database = await databaseFixture();
  try {
    await store.initializeVocabDatabase();
    const itemId = await store.saveArticle({
      title: "Atomic occurrence",
      description: "",
      author: "",
      source: "local",
      blocks: [{ kind: "paragraph", text: "Steady practice compounds." }],
    }, "paste");
    const target = {
      surface: "Steady",
      sentence: "Steady practice compounds.",
      before: "",
      after: "",
      itemId,
      startUtf16: 0,
      endUtf16: 6,
    };
    const explanation = usefulExplanation("steady", "consistent and reliable");
    const receipt = await store.prepareVocabOccurrenceWrite(
      target,
      explanation,
      "Remember the calm rhythm.",
    );
    globalThis.__vocabBatchFault = "after_commit";
    const first = await store.saveOccurrence(target, explanation, {
      note: "Remember the calm rhythm.",
      receipt,
    });
    assert.equal(first.occurrenceId, receipt.occurrenceId);
    assert.equal(
      await store.inspectVocabOccurrenceWrite(receipt),
      "exact_saved",
    );
    const repeated = await store.saveOccurrence(target, explanation, {
      note: "Remember the calm rhythm.",
      receipt,
    });
    assert.deepEqual(repeated, first);
    assert.deepEqual(
      database.selectObjects(
        "SELECT note,created_at FROM vocab_occurrences WHERE id=?",
        [receipt.occurrenceId],
      ).map((row) => ({ ...row })),
      [{ note: "Remember the calm rhythm.", created_at: receipt.createdAt }],
    );
    assert.equal(Number(database.selectValue(
      "SELECT lookup_count FROM vocab_lexemes WHERE id=?",
      [first.lexemeId],
    )), 1);
    assert.equal(Number(database.selectValue(
      "SELECT COUNT(*) FROM vocab_activity WHERE id=? AND lookups=1",
      [receipt.activityId],
    )), 1);
    await assert.rejects(
      store.saveOccurrence(target, explanation, {
        note: "A changed note must not reuse the old operation.",
        receipt,
      }),
      (error) => error?.code === "VOCAB_WRITE_CONFLICT",
    );
    assert.equal(Number(database.selectValue(
      "SELECT lookup_count FROM vocab_lexemes WHERE id=?",
      [first.lexemeId],
    )), 1);

    const failingTarget = {
      ...target,
      surface: "Rollbackonly",
      sentence: "Rollbackonly must not leave partial rows.",
      itemId: "missing-item",
      endUtf16: 12,
    };
    const failingReceipt = await store.prepareVocabOccurrenceWrite(
      failingTarget,
      null,
      "This note must roll back too.",
    );
    await assert.rejects(
      store.saveOccurrence(failingTarget, null, {
        note: "This note must roll back too.",
        receipt: failingReceipt,
      }),
      (error) => error?.code === "VOCAB_WRITE_NOT_SAVED",
    );
    assert.equal(Number(database.selectValue(
      "SELECT COUNT(*) FROM vocab_lexemes WHERE normalized_key='rollbackonly'",
    )), 0);
    assert.equal(Number(database.selectValue(
      "SELECT COUNT(*) FROM vocab_occurrences WHERE id=?",
      [failingReceipt.occurrenceId],
    )), 0);
    assert.equal(Number(database.selectValue(
      "SELECT COUNT(*) FROM vocab_activity WHERE id=?",
      [failingReceipt.activityId],
    )), 0);
    assert.equal(Number(database.selectValue(
      "SELECT COUNT(*) FROM vocab_review_cards WHERE id=?",
      [failingReceipt.cardId],
    )), 0);
    assert.deepEqual(database.selectObjects("PRAGMA foreign_key_check"), []);
  } finally {
    globalThis.__vocabBatchFault = null;
    database.close();
  }
});

test("repository exposes shared reads, exclusive writes, and cross-tab changes", async () => {
  const [lockSource, source] = await Promise.all([
    readFile(new URL("lib/vocab/lock.ts", projectRoot), "utf8"),
    readFile(new URL("lib/vocab/store.ts", projectRoot), "utf8"),
  ]);
  assert.match(lockSource, /mode: "shared" \| "exclusive"/);
  assert.match(lockSource, /new BroadcastChannel\(VOCAB_CHANNEL_NAME\)/);
  assert.match(lockSource, /export function subscribeVocabChanges/);
  assert.match(source, /withVocabReadLock/);
  assert.match(source, /withVocabWriteLock/);
  assert.match(source, /broadcastVocabChange/);
  assert.match(source, /await localDb\.init\(DB\)/);
  assert.doesNotMatch(source, /seedStatements|The Quiet Value of Moving Slowly/);
});
