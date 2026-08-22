import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const root = new URL("../", import.meta.url);
const journalUrl = new URL("app/vocab/lexeme-write-journal.ts", root);
const stateUrl = new URL("app/vocab/lexeme-write-state.ts", root);
const flowUrl = new URL("app/vocab/VocabLexemeWriteFlow.tsx", root);
const appUrl = new URL("app/vocab/VocabApp.tsx", root);
const viewsUrl = new URL("app/vocab/views.tsx", root);
const overlaysUrl = new URL("app/vocab/overlays.tsx", root);
const cssUrl = new URL("app/vocab/vocab.css", root);

const [
  journalSource,
  stateSource,
  flowSource,
  appSource,
  viewsSource,
  overlaysSource,
  cssSource,
] = await Promise.all([
  readFile(journalUrl, "utf8"),
  readFile(stateUrl, "utf8"),
  readFile(flowUrl, "utf8"),
  readFile(appUrl, "utf8"),
  readFile(viewsUrl, "utf8"),
  readFile(overlaysUrl, "utf8"),
  readFile(cssUrl, "utf8"),
]);

function transpile(source, fileName) {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  assert.deepEqual(
    (result.diagnostics ?? []).filter(({ category }) =>
      category === ts.DiagnosticCategory.Error
    ),
    [],
  );
  return result.outputText;
}

const executableJournal = transpile(journalSource, journalUrl.pathname).replace(
  /import\s*\{\s*isVocabLexemeWriteReceipt,?\s*\}\s*from\s*"@\/lib\/vocab\/store";/,
  `const isVocabLexemeWriteReceipt = (value) => Boolean(
    value && typeof value === "object" &&
    value.purpose === "vocab-lexeme-write" && value.version === 1 &&
    ["note-save", "star-set", "status-set"].includes(value.kind) &&
    /^vocab-lexeme-operation-[a-z0-9-]+$/.test(value.operationId) &&
    value.before?.lexeme?.id && value.after?.lexeme?.id
  );`,
);
assert.doesNotMatch(executableJournal, /@\/lib\/vocab\/store/);
const journal = await import(
  `data:text/javascript;base64,${Buffer.from(executableJournal).toString("base64")}`
);

const executableState = transpile(stateSource, stateUrl.pathname);
assert.doesNotMatch(executableState, /^import /m);
const state = await import(
  `data:text/javascript;base64,${Buffer.from(executableState).toString("base64")}`
);

const LEXEME_KEYS = [
  "id",
  "headword",
  "normalized_key",
  "pronunciation",
  "gloss_en",
  "explanation_en",
  "explanation_zh",
  "status",
  "starred",
  "notes",
  "lookup_count",
  "created_at",
  "updated_at",
];

const CARD_KEYS = [
  "id",
  "lexeme_id",
  "state",
  "due_at",
  "interval_days",
  "ease",
  "reps",
  "lapses",
  "last_review_at",
  "algorithm_version",
  "suspended_from_state",
  "suspended_reason",
  "updated_at",
];

function storedLexeme(overrides = {}) {
  return {
    id: "lexeme-a",
    headword: "steady",
    normalized_key: "steady",
    pronunciation: "/ˈstɛdi/",
    gloss_en: "firmly fixed",
    explanation_en: "Continuing without unwanted change.",
    explanation_zh: "稳定的",
    status: "learning",
    starred: 0,
    notes: "old note",
    lookup_count: 4,
    created_at: 10,
    updated_at: 20,
    ...overrides,
  };
}

function displayLexeme(overrides = {}) {
  return { ...storedLexeme(), occurrence_count: 7, ...overrides };
}

function storedCard(overrides = {}) {
  return {
    id: "card-a",
    lexeme_id: "lexeme-a",
    state: "review",
    due_at: 100,
    interval_days: 3,
    ease: 2.5,
    reps: 4,
    lapses: 1,
    last_review_at: 80,
    algorithm_version: 2,
    suspended_from_state: null,
    suspended_reason: "",
    updated_at: 20,
    ...overrides,
  };
}

function displayCard(overrides = {}) {
  return {
    ...storedCard(),
    headword: "steady",
    pronunciation: "/ˈstɛdi/",
    gloss_en: "firmly fixed",
    context_sentence: "She kept a steady pace.",
    cloze_sentence: "She kept a ___ pace.",
    ...overrides,
  };
}

function expectedSet({
  lexemes = [storedLexeme()],
  cards = [storedCard()],
  generationId = "generation-a",
  generationSequence = 3,
} = {}) {
  return {
    generationId,
    generationSequence,
    entries: lexemes.map((lexeme, index) => ({
      lexeme,
      reviewCard: cards[index] ?? null,
    })),
  };
}

function receipt(
  operationId = "vocab-lexeme-operation-a",
  overrides = {},
) {
  const beforeLexeme = storedLexeme();
  const afterLexeme = storedLexeme({ notes: "submitted note", updated_at: 21 });
  return {
    purpose: "vocab-lexeme-write",
    version: 1,
    kind: "note-save",
    operationId,
    generationId: "generation-a",
    generationSequence: 3,
    before: {
      generationId: "generation-a",
      generationSequence: 3,
      lexeme: beforeLexeme,
    },
    after: {
      generationId: "generation-a",
      generationSequence: 3,
      lexeme: afterLexeme,
    },
    projectionSha256: "0".repeat(64),
    ...overrides,
  };
}

function ticket(
  kind = "check",
  operationId = "vocab-lexeme-operation-a",
  lexemeId = "lexeme-a",
  recordedAt = "2026-08-22T03:04:05.000Z",
) {
  const value = receipt(operationId);
  value.before.lexeme.id = lexemeId;
  value.after.lexeme.id = lexemeId;
  return { version: 1, kind, receipt: value, recordedAt };
}

function memoryStorage(initial = []) {
  const values = new Map(initial);
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
    values,
  };
}

function lockManager() {
  const tails = new Map();
  return {
    request(name, task) {
      const previous = tails.get(name) ?? Promise.resolve();
      const run = previous.then(task, task);
      tails.set(name, run.then(() => undefined, () => undefined));
      return run;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test("lexeme journal accepts only canonical purpose-bound tickets and verifies persistence", async () => {
  assert.equal(journal.isVocabLexemeWriteTicket(ticket()), true);
  assert.equal(
    journal.isVocabLexemeWriteTicket(ticket("check", undefined, undefined, "2026-08-22 03:04:05Z")),
    false,
  );
  assert.equal(journal.isVocabLexemeWriteTicket({ ...ticket(), extra: true }), false);
  assert.equal(
    journal.isVocabLexemeWriteTicket({
      ...ticket(),
      receipt: { ...ticket().receipt, purpose: "vocab-settings-write" },
    }),
    false,
  );
  const storage = memoryStorage();
  const saved = await journal.persistVocabLexemeWrite(ticket(), {
    storage,
    locks: lockManager(),
  });
  assert.equal(saved.storageKey, `${journal.VOCAB_LEXEME_WRITE_PREFIX}${saved.ticket.receipt.operationId}`);
  assert.equal(storage.getItem(saved.storageKey), saved.raw);
});

test("one full journal lease spans the backend callback and raw CAS transition", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const entry = await journal.persistVocabLexemeWrite(ticket(), { storage, locks });
  const started = deferred();
  const release = deferred();
  let peerSettled = false;
  const running = journal.runWithCurrentVocabLexemeWrite(entry, async (lease) => {
    started.resolve();
    await release.promise;
    lease.committed();
  }, { storage, locks });
  await started.promise;
  const peer = journal.persistVocabLexemeWrite(
    ticket("check", "vocab-lexeme-operation-b", "lexeme-b"),
    { storage, locks },
  ).then((value) => { peerSettled = true; return value; });
  await Promise.resolve();
  assert.equal(peerSettled, false, "a peer cannot enter while backend work owns the journal lease");
  release.resolve();
  const result = await running;
  assert.equal(result.outcome, "ran");
  assert.equal(result.entry.ticket.kind, "committed");
  assert.equal((await peer).ticket.receipt.before.lexeme.id, "lexeme-b");
});

test("a missing held receipt re-checkpoints check before inspect, while same-lexeme Q wins", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const held = journal.createVocabLexemeWriteEntry(ticket());
  let sawCheck = false;
  const result = await journal.runWithMissingVocabLexemeWrite(
    held,
    (lease) => {
      const raw = storage.getItem(held.storageKey);
      sawCheck = JSON.parse(raw).kind === "check";
      lease.committed();
      return "inspected";
    },
    { storage, locks },
  );
  assert.equal(result.outcome, "ran");
  assert.equal(result.value, "inspected");
  assert.equal(sawCheck, true);
  assert.equal(result.entry.ticket.kind, "committed");

  const secondStorage = memoryStorage();
  await journal.persistVocabLexemeWrite(
    ticket("check", "vocab-lexeme-operation-q", "lexeme-a"),
    { storage: secondStorage, locks },
  );
  let calls = 0;
  const blocked = await journal.runWithMissingVocabLexemeWrite(
    held,
    () => { calls += 1; },
    { storage: secondStorage, locks },
  );
  assert.equal(blocked.outcome, "stale");
  assert.equal(calls, 0, "held P never inspects while a durable same-lexeme Q exists");
});

test("unreadable/full-scan/no-lock states call no backend and raw CAS preserves peer advances", async () => {
  const locks = lockManager();
  const held = journal.createVocabLexemeWriteEntry(ticket());
  const unreadableStorage = memoryStorage([
    [`${journal.VOCAB_LEXEME_WRITE_PREFIX}broken`, "{"],
  ]);
  let calls = 0;
  const unreadable = await journal.runWithMissingVocabLexemeWrite(
    held,
    () => { calls += 1; },
    { storage: unreadableStorage, locks },
  );
  assert.deepEqual(unreadable, { outcome: "blocked", reason: "unreadable" });
  assert.equal(calls, 0);

  const brokenStorage = {
    get length() { throw new Error("length unavailable"); },
    key() { return null; },
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  };
  const broken = await journal.runWithMissingVocabLexemeWrite(
    held,
    () => { calls += 1; },
    { storage: brokenStorage, locks },
  );
  assert.deepEqual(broken, { outcome: "blocked", reason: "storage" });
  assert.equal(calls, 0);
  await assert.rejects(
    journal.runWithMissingVocabLexemeWrite(
      held,
      () => { calls += 1; },
      { storage: memoryStorage(), locks: null },
    ),
    /跨页面锁定/,
  );
  assert.equal(calls, 0);

  const storage = memoryStorage();
  const entry = await journal.persistVocabLexemeWrite(ticket(), { storage, locks });
  const peer = journal.createVocabLexemeWriteEntry({
    ...entry.ticket,
    kind: "changed",
  });
  const cas = await journal.runWithCurrentVocabLexemeWrite(entry, (lease) => {
    storage.setItem(entry.storageKey, peer.raw);
    assert.throws(() => lease.remove(), /另一页/);
  }, { storage, locks });
  assert.equal(cas.outcome, "ran");
  assert.equal(storage.getItem(entry.storageKey), peer.raw);
});

test("whole-bundle binding covers all 13 lexeme columns and ignores only derived occurrence count", () => {
  const expected = expectedSet();
  const display = displayLexeme();
  const bindings = state.createVocabLexemeBindings([display], [displayCard()], expected);
  assert.ok(bindings);
  assert.equal(bindings.get(display.id).display, display);
  assert.equal(state.getBoundVocabLexemeExpected(bindings, display), bindings.get(display.id).expected);
  assert.equal(
    state.getBoundVocabLexemeExpected(bindings, { ...display }),
    null,
    "a copied display object cannot borrow the expected state",
  );
  assert.ok(state.createVocabLexemeBindings([
    { ...display, occurrence_count: 999 },
  ], [displayCard()], expected));
  for (const key of LEXEME_KEYS) {
    const changed = { ...display, [key]: key === "id" ? "other" : `changed-${key}` };
    assert.equal(
      state.createVocabLexemeBindings([changed], [displayCard()], expected),
      null,
      `${key} is part of the persisted lexeme binding`,
    );
  }
  assert.equal(state.createVocabLexemeBindings([], [], expected), null);
  assert.equal(state.createVocabLexemeBindings([display, display], [], expected), null);
});

test("visible review cards are uniquely and fully bound, while an eligible-filtered hidden expected card is valid", () => {
  const expected = expectedSet();
  assert.ok(
    state.createVocabLexemeBindings([displayLexeme()], [], expected),
    "the snapshot may intentionally hide an expected card by eligibility/daily limit",
  );
  assert.ok(state.createVocabLexemeBindings([displayLexeme()], [displayCard()], expected));
  assert.equal(
    state.createVocabLexemeBindings([displayLexeme()], [displayCard(), displayCard()], expected),
    null,
  );
  assert.equal(
    state.createVocabLexemeBindings([displayLexeme()], [displayCard({ lexeme_id: "orphan" })], expected),
    null,
  );
  for (const key of CARD_KEYS) {
    const changed = {
      ...displayCard(),
      [key]: key === "id" || key === "lexeme_id" ? `other-${key}` : `changed-${key}`,
    };
    assert.equal(
      state.createVocabLexemeBindings([displayLexeme()], [changed], expected),
      null,
      `${key} is part of a visible review-card binding`,
    );
  }
  assert.equal(
    state.createVocabLexemeBindings(
      [displayLexeme()],
      [],
      expectedSet({ cards: [storedCard({ lexeme_id: "other" })] }),
    ),
    null,
    "an expected card must itself belong to its expected lexeme",
  );
});

test("E1/E2 set equality is order-independent but rejects every stored lexeme/card difference", () => {
  const left = expectedSet({
    lexemes: [storedLexeme(), storedLexeme({ id: "lexeme-b", headword: "calm" })],
    cards: [storedCard(), storedCard({ id: "card-b", lexeme_id: "lexeme-b" })],
  });
  const right = { ...left, entries: [...left.entries].reverse() };
  assert.equal(state.sameVocabLexemeExpectedSet(left, right), true);
  assert.equal(
    state.sameVocabLexemeExpectedSet(left, { ...right, generationSequence: 4 }),
    false,
  );
  const changedLexeme = structuredClone(right);
  changedLexeme.entries[0].lexeme.lookup_count += 1;
  assert.equal(state.sameVocabLexemeExpectedSet(left, changedLexeme), false);
  const changedCard = structuredClone(right);
  changedCard.entries[0].reviewCard.ease += 0.1;
  assert.equal(state.sameVocabLexemeExpectedSet(left, changedCard), false);
});

test("operation-aware note lineage protects every newer revision and rebases it onto E2", () => {
  const display = displayLexeme();
  const initialBindings = state.createVocabLexemeBindings(
    [display],
    [],
    expectedSet(),
  );
  const base = state.createVocabLexemeNoteEditor(initialBindings.get(display.id));
  const submitted = state.updateVocabLexemeNoteEditor(base, "submitted note");
  const token = Symbol("note-prepare");
  const preparing = state.beginVocabLexemeEditorPreparation(
    submitted,
    "note-save",
    token,
  );
  const returnedToE0 = state.updateVocabLexemeNoteEditor(
    preparing,
    base.baselineNote,
  );
  assert.equal(
    state.vocabLexemeNoteEditorDirty(returnedToE0),
    true,
    "a revision newer than the submitted B stays unsaved even when its value returns to E0=A",
  );
  assert.equal(state.vocabLexemeEditorNeedsProtection(returnedToE0), true);
  const writeReceipt = receipt();
  const bound = state.bindVocabLexemeEditorReceipt(
    returnedToE0,
    token,
    writeReceipt,
  );
  assert.equal(bound.operation.receipt.operationId, writeReceipt.operationId);
  assert.equal(bound.preparation, null);
  const afterDisplay = displayLexeme({ notes: "submitted note", updated_at: 21 });
  const afterBindings = state.createVocabLexemeBindings(
    [afterDisplay],
    [],
    expectedSet({
      lexemes: [storedLexeme({ notes: "submitted note", updated_at: 21 })],
    }),
  );
  assert.equal(
    state.vocabLexemeBundleShouldDefer(afterBindings, bound, null),
    false,
    "the receipt's own E2=B may apply while the newer A draft stays attached",
  );
  const rebased = state.settleVocabLexemeEditor(
    bound,
    writeReceipt,
    afterBindings.get(display.id),
  );
  assert.equal(rebased.note, base.baselineNote);
  assert.equal(rebased.baselineNote, "submitted note");
  assert.equal(state.vocabLexemeNoteEditorDirty(rebased), true);
  assert.equal(rebased.display, afterDisplay);
  assert.equal(rebased.operation, null);

  const exactToken = Symbol("exact-note-prepare");
  const exact = state.bindVocabLexemeEditorReceipt(
    state.beginVocabLexemeEditorPreparation(
      state.updateVocabLexemeNoteEditor(base, "submitted note"),
      "note-save",
      exactToken,
    ),
    exactToken,
    writeReceipt,
  );
  const exactSettled = state.settleVocabLexemeEditor(
    exact,
    writeReceipt,
    afterBindings.get(display.id),
  );
  assert.equal(exactSettled.note, "submitted note");
  assert.equal(exactSettled.baselineNote, "submitted note");
  assert.equal(state.vocabLexemeNoteEditorDirty(exactSettled), false);
});

test("note recovery paths retain one receipt lineage without a submission map", () => {
  const display = displayLexeme();
  const beforeBindings = state.createVocabLexemeBindings(
    [display],
    [],
    expectedSet(),
  );
  const afterDisplay = displayLexeme({ notes: "submitted note", updated_at: 21 });
  const afterBindings = state.createVocabLexemeBindings(
    [afterDisplay],
    [],
    expectedSet({
      lexemes: [storedLexeme({ notes: "submitted note", updated_at: 21 })],
    }),
  );
  const peerBindings = state.createVocabLexemeBindings(
    [displayLexeme({ notes: "peer note", updated_at: 22 })],
    [],
    expectedSet({
      lexemes: [storedLexeme({ notes: "peer note", updated_at: 22 })],
    }),
  );
  const paths = [
    "direct",
    "refresh throw",
    "uncertain inspect",
    "missing-held",
    "remove-fail repeat",
    "ambient refresh",
  ];
  for (const path of paths) {
    const base = state.createVocabLexemeNoteEditor(beforeBindings.get(display.id));
    const submitted = state.updateVocabLexemeNoteEditor(base, "submitted note");
    const token = Symbol(path);
    let editor = state.beginVocabLexemeEditorPreparation(
      submitted,
      "note-save",
      token,
    );
    editor = state.bindVocabLexemeEditorReceipt(editor, token, receipt());
    editor = state.updateVocabLexemeNoteEditor(editor, base.baselineNote);
    let appliedBindings = beforeBindings;
    const apply = (candidate) => {
      if (state.vocabLexemeBundleShouldDefer(candidate, editor, null)) {
        return "deferred";
      }
      appliedBindings = candidate;
      if (!state.vocabLexemeEditorNeedsProtection(editor)) {
        editor = state.createVocabLexemeNoteEditor(
          candidate.get(editor.lexemeId),
        );
      }
      return "applied";
    };
    assert.equal(apply(beforeBindings), "applied", `${path}: own E1 may refresh`);
    assert.equal(apply(peerBindings), "deferred", `${path}: peer truth never splices the editor`);
    assert.equal(appliedBindings, beforeBindings, `${path}: a deferred peer bundle is not partially applied`);
    assert.equal(apply(afterBindings), "applied", `${path}: own E2 may refresh`);
    assert.equal(editor.operation.receipt.operationId, receipt().operationId, `${path}: E2 apply retains lineage until raw-CAS removal`);
    const premature = state.settleVocabLexemeEditor(
      editor,
      receipt(),
      beforeBindings.get(display.id),
    );
    assert.equal(premature, editor, `${path}: own-before or a failed removal cannot consume lineage`);
    assert.ok(premature.operation, `${path}: the receipt stays repeatable as refresh-only`);
    const settled = state.settleVocabLexemeEditor(
      editor,
      receipt(),
      appliedBindings.get(display.id),
    );
    assert.equal(settled.baselineNote, "submitted note", path);
    assert.equal(settled.note, base.baselineNote, path);
    assert.equal(state.vocabLexemeNoteEditorDirty(settled), true, path);
    assert.equal(
      state.settleVocabLexemeEditor(settled, receipt(), afterBindings.get(display.id)),
      settled,
      `${path}: a repeat callback cannot consume the newer draft twice`,
    );
  }
  assert.doesNotMatch(appSource, /lexemeSubmissionsRef/);
  assert.match(flowSource, /onReceiptPrepared\?\.\(receipt, trigger\)[\s\S]*?persistVocabLexemeWrite/);
  assert.ok((appSource.match(/!vocabLexemeEditorNeedsProtection\(editor\)/g) ?? []).length >= 2);
});

test("changed and discarded receipts clear only their own operation while retaining late input", () => {
  const display = displayLexeme();
  const beforeBindings = state.createVocabLexemeBindings([display], [], expectedSet());
  const base = state.createVocabLexemeNoteEditor(beforeBindings.get(display.id));
  const token = Symbol("changed-note");
  let editor = state.beginVocabLexemeEditorPreparation(
    state.updateVocabLexemeNoteEditor(base, "submitted note"),
    "note-save",
    token,
  );
  editor = state.bindVocabLexemeEditorReceipt(editor, token, receipt());
  editor = state.updateVocabLexemeNoteEditor(editor, base.baselineNote);
  const discarded = state.discardVocabLexemeEditorOperation(editor, receipt());
  assert.equal(discarded.operation, null);
  assert.equal(state.vocabLexemeNoteEditorDirty(discarded), true);

  const peerDisplay = displayLexeme({ notes: "peer note", updated_at: 22 });
  const peerBindings = state.createVocabLexemeBindings(
    [peerDisplay],
    [],
    expectedSet({
      lexemes: [storedLexeme({ notes: "peer note", updated_at: 22 })],
    }),
  );
  const changed = state.settleChangedVocabLexemeEditor(
    editor,
    receipt(),
    peerBindings.get(display.id),
  );
  assert.equal(changed.display, peerDisplay);
  assert.equal(changed.baselineNote, "peer note");
  assert.equal(changed.note, base.baselineNote);
  assert.equal(changed.operation, null);
  assert.equal(state.vocabLexemeNoteEditorDirty(changed), true);
});

test("status and star receipts rebase their own editor while peer divergence stays deferred", () => {
  const display = displayLexeme();
  const beforeCard = storedCard();
  const beforeBindings = state.createVocabLexemeBindings(
    [display],
    [],
    expectedSet({ cards: [beforeCard] }),
  );
  const cases = [
    {
      kind: "star-set",
      afterLexeme: storedLexeme({ starred: 1, updated_at: 21 }),
      afterCard: storedCard({ ease: 2.7, updated_at: 21 }),
    },
    {
      kind: "status-set",
      afterLexeme: storedLexeme({ status: "known", updated_at: 21 }),
      afterCard: storedCard({
        state: "suspended",
        suspended_from_state: "review",
        suspended_reason: "known",
        updated_at: 21,
      }),
    },
  ];
  for (const entry of cases) {
    const afterDisplay = displayLexeme(entry.afterLexeme);
    const afterBindings = state.createVocabLexemeBindings(
      [afterDisplay],
      [],
      expectedSet({ lexemes: [entry.afterLexeme], cards: [entry.afterCard] }),
    );
    const writeReceipt = receipt(
      `vocab-lexeme-operation-${entry.kind}`,
      {
        kind: entry.kind,
        before: {
          generationId: "generation-a",
          generationSequence: 3,
          lexeme: storedLexeme(),
          ...(entry.kind === "status-set" ? { reviewCard: beforeCard } : {}),
        },
        after: {
          generationId: "generation-a",
          generationSequence: 3,
          lexeme: entry.afterLexeme,
          ...(entry.kind === "status-set" ? { reviewCard: entry.afterCard } : {}),
        },
      },
    );
    const base = state.createVocabLexemeNoteEditor(beforeBindings.get(display.id));
    const token = Symbol(entry.kind);
    let editor = state.beginVocabLexemeEditorPreparation(base, entry.kind, token);
    editor = state.bindVocabLexemeEditorReceipt(editor, token, writeReceipt);
    editor = state.updateVocabLexemeNoteEditor(editor, "late C");
    assert.equal(state.vocabLexemeBundleShouldDefer(beforeBindings, editor, null), false, entry.kind);
    assert.equal(state.vocabLexemeBundleShouldDefer(afterBindings, editor, null), false, entry.kind);
    if (entry.kind === "status-set") {
      const wrongCardBindings = state.createVocabLexemeBindings(
        [afterDisplay],
        [],
        expectedSet({
          lexemes: [entry.afterLexeme],
          cards: [storedCard({ ...entry.afterCard, ease: 3.1 })],
        }),
      );
      assert.equal(
        state.vocabLexemeBundleShouldDefer(wrongCardBindings, editor, null),
        true,
        "status lineage includes the complete review-card CAS state",
      );
    }
    const peerBindings = state.createVocabLexemeBindings(
      [displayLexeme({ headword: "peer", updated_at: 22 })],
      [],
      expectedSet({
        lexemes: [storedLexeme({ headword: "peer", updated_at: 22 })],
      }),
    );
    assert.equal(state.vocabLexemeBundleShouldDefer(peerBindings, editor, null), true, entry.kind);
    const settled = state.settleVocabLexemeEditor(
      editor,
      writeReceipt,
      afterBindings.get(display.id),
    );
    assert.equal(settled.display, afterDisplay, entry.kind);
    assert.equal(settled.expected, afterBindings.get(display.id).expected, entry.kind);
    assert.equal(settled.note, "late C", entry.kind);
    assert.equal(state.vocabLexemeNoteEditorDirty(settled), true, entry.kind);
    const peerReceipt = { ...writeReceipt, operationId: `${writeReceipt.operationId}-peer` };
    assert.equal(
      state.settleVocabLexemeEditor(editor, peerReceipt, afterBindings.get(display.id)),
      editor,
      "an arbitrary peer receipt cannot consume this editor lineage",
    );
  }
});

test("detached durable star and status receipts rebase a drawer opened after the operation", () => {
  const beforeDisplay = displayLexeme();
  const beforeCard = storedCard();
  const beforeBindings = state.createVocabLexemeBindings(
    [beforeDisplay],
    [],
    expectedSet({ cards: [beforeCard] }),
  );
  const cases = [
    {
      kind: "star-set",
      paths: ["direct", "refresh throw", "uncertain", "missing-held"],
      afterLexeme: storedLexeme({ starred: 1, updated_at: 21 }),
      afterCard: storedCard({ ease: 2.8, updated_at: 21 }),
    },
    {
      kind: "status-set",
      paths: ["failed then close/reopen"],
      afterLexeme: storedLexeme({ status: "known", updated_at: 21 }),
      afterCard: storedCard({
        state: "suspended",
        suspended_from_state: "review",
        suspended_reason: "known",
        updated_at: 21,
      }),
    },
  ];
  for (const entry of cases) {
    const writeReceipt = receipt(
      `vocab-lexeme-operation-detached-${entry.kind}`,
      {
        kind: entry.kind,
        before: {
          generationId: "generation-a",
          generationSequence: 3,
          lexeme: storedLexeme(),
          ...(entry.kind === "status-set" ? { reviewCard: beforeCard } : {}),
        },
        after: {
          generationId: "generation-a",
          generationSequence: 3,
          lexeme: entry.afterLexeme,
          ...(entry.kind === "status-set" ? { reviewCard: entry.afterCard } : {}),
        },
      },
    );
    const afterDisplay = displayLexeme(entry.afterLexeme);
    const afterBindings = state.createVocabLexemeBindings(
      [afterDisplay],
      [],
      expectedSet({ lexemes: [entry.afterLexeme], cards: [entry.afterCard] }),
    );
    const peerBindings = state.createVocabLexemeBindings(
      [displayLexeme({ headword: "peer", updated_at: 22 })],
      [],
      expectedSet({
        lexemes: [storedLexeme({ headword: "peer", updated_at: 22 })],
      }),
    );
    for (const path of entry.paths) {
      if (path === "direct") {
        assert.equal(
          state.vocabLexemeBundleShouldDefer(afterBindings, null, {
            receipt: writeReceipt,
            mode: "after-only",
          }),
          false,
        );
        assert.equal(
          state.vocabLexemeBundleShouldDefer(peerBindings, null, {
            receipt: writeReceipt,
            mode: "after-only",
          }),
          true,
          "a direct receipt cannot clear against peer E3 just because no drawer is open",
        );
        const openedAfterSettlement = state.updateVocabLexemeNoteEditor(
          state.createVocabLexemeNoteEditor(afterBindings.get(beforeDisplay.id)),
          "late C",
        );
        assert.equal(openedAfterSettlement.expected, afterBindings.get(beforeDisplay.id).expected);
        assert.equal(state.vocabLexemeNoteEditorDirty(openedAfterSettlement), true);
        continue;
      }
      let reopened = state.createVocabLexemeNoteEditor(
        beforeBindings.get(beforeDisplay.id),
      );
      reopened = state.updateVocabLexemeNoteEditor(reopened, "late C");
      const protection = { receipt: writeReceipt, mode: "after-only" };
      assert.equal(
        state.vocabLexemeBundleShouldDefer(afterBindings, reopened, protection),
        false,
        `${entry.kind}/${path}: exact E2 may apply without an in-memory operation`,
      );
      assert.equal(
        state.vocabLexemeBundleShouldDefer(peerBindings, reopened, protection),
        true,
        `${entry.kind}/${path}: a same-lexeme peer projection still defers`,
      );
      const settled = state.settleVocabLexemeEditor(
        reopened,
        structuredClone(writeReceipt),
        afterBindings.get(beforeDisplay.id),
      );
      assert.equal(settled.display, afterDisplay, path);
      assert.equal(settled.expected, afterBindings.get(beforeDisplay.id).expected, path);
      assert.equal(settled.baselineNote, afterDisplay.notes, path);
      assert.equal(settled.note, "late C", path);
      assert.equal(settled.revision, reopened.revision, path);
      assert.equal(state.vocabLexemeNoteEditorDirty(settled), true, path);
    }
    if (entry.kind === "status-set") {
      assert.equal(
        state.vocabLexemeBundleShouldDefer(
          peerBindings,
          state.createVocabLexemeNoteEditor(beforeBindings.get(beforeDisplay.id)),
          { receipt: writeReceipt, mode: "after-only" },
        ),
        true,
        "a clean detached editor cannot bypass the receipt's exact E2 gate",
      );
      const cleanReopen = state.settleVocabLexemeEditor(
        state.createVocabLexemeNoteEditor(beforeBindings.get(beforeDisplay.id)),
        writeReceipt,
        afterBindings.get(beforeDisplay.id),
      );
      assert.equal(
        state.vocabLexemeNoteEditorDirty(cleanReopen),
        false,
        "a detached status receipt does not invent a note edit",
      );
    }
  }
});

test("page-start peer receipts may exact-rebase but P and Q never consume each other's lineage", () => {
  const display = displayLexeme();
  const beforeBindings = state.createVocabLexemeBindings([display], [], expectedSet());
  const qAfterLexeme = storedLexeme({ starred: 1, updated_at: 21 });
  const qReceipt = receipt("vocab-lexeme-operation-q", {
    kind: "star-set",
    before: {
      generationId: "generation-a",
      generationSequence: 3,
      lexeme: storedLexeme(),
    },
    after: {
      generationId: "generation-a",
      generationSequence: 3,
      lexeme: qAfterLexeme,
    },
  });
  const qAfterBindings = state.createVocabLexemeBindings(
    [displayLexeme(qAfterLexeme)],
    [],
    expectedSet({ lexemes: [qAfterLexeme] }),
  );
  const pageStartEditor = state.updateVocabLexemeNoteEditor(
    state.createVocabLexemeNoteEditor(beforeBindings.get(display.id)),
    "late C",
  );
  const peerSettled = state.settleVocabLexemeEditor(
    pageStartEditor,
    qReceipt,
    qAfterBindings.get(display.id),
  );
  assert.equal(peerSettled.expected, qAfterBindings.get(display.id).expected);
  assert.equal(peerSettled.note, "late C");
  assert.equal(state.vocabLexemeNoteEditorDirty(peerSettled), true);

  const pToken = Symbol("operation-p");
  const pReceipt = receipt("vocab-lexeme-operation-p");
  let pEditor = state.beginVocabLexemeEditorPreparation(
    state.updateVocabLexemeNoteEditor(
      state.createVocabLexemeNoteEditor(beforeBindings.get(display.id)),
      "submitted note",
    ),
    "note-save",
    pToken,
  );
  pEditor = state.bindVocabLexemeEditorReceipt(pEditor, pToken, pReceipt);
  assert.equal(
    state.vocabLexemeBundleShouldDefer(qAfterBindings, pEditor, {
      receipt: qReceipt,
      mode: "after-only",
    }),
    true,
    "Q cannot authorize a bundle through P's editor operation",
  );
  assert.equal(
    state.settleVocabLexemeEditor(pEditor, qReceipt, qAfterBindings.get(display.id)),
    pEditor,
    "Q cannot consume P's operation lineage",
  );
  assert.equal(pEditor.operation.receipt.operationId, pReceipt.operationId);
});

test("dirty bundle protection accepts card-only refresh, defers peer lexeme truth, and exposes volatile exit gates", () => {
  const display = displayLexeme();
  const initial = state.createVocabLexemeBindings([display], [], expectedSet());
  const editor = state.updateVocabLexemeNoteEditor(
    state.createVocabLexemeNoteEditor(initial.get(display.id)),
    "draft",
  );
  const cardOnly = state.createVocabLexemeBindings(
    [displayLexeme()],
    [],
    expectedSet({ cards: [storedCard({ ease: 2.7, updated_at: 22 })] }),
  );
  assert.equal(state.vocabLexemeBundleShouldDefer(cardOnly, editor, null), false);
  const peer = state.createVocabLexemeBindings(
    [displayLexeme({ notes: "peer", updated_at: 23 })],
    [],
    expectedSet({ lexemes: [storedLexeme({ notes: "peer", updated_at: 23 })] }),
  );
  assert.equal(state.vocabLexemeBundleShouldDefer(peer, editor, null), true);
  assert.equal(
    state.vocabLexemeBundleShouldDefer(peer, editor, {
      receipt: receipt(),
      mode: "any",
    }),
    false,
    "changed settlement may apply whole current truth only after explicit user action",
  );
  assert.deepEqual(
    state.vocabLexemeHeldReceiptBarrier("operation-p", ["operation-q"]),
    { blocksWrites: true, volatile: true },
  );
  assert.equal(state.vocabLexemeExitDecision(true, false), "block");
  assert.equal(state.vocabLexemeExitDecision(false, true), "confirm");
  assert.equal(state.vocabLexemeExitDecision(false, false), "leave");
});

test("an authoritative external lock stops rating before its callback and reopens only when safe", () => {
  const journalState = {
    loaded: true,
    storageUnavailable: false,
    lockUnavailable: false,
    unreadableCount: 0,
  };
  let ratingCallbacks = 0;
  const attempt = (externalWriteLocked) => {
    if (!state.vocabLexemeRatingPreflightOpen(
      externalWriteLocked,
      journalState,
      false,
    )) return false;
    ratingCallbacks += 1;
    return true;
  };
  assert.equal(attempt(true), false);
  assert.equal(ratingCallbacks, 0);
  assert.equal(attempt(false), true);
  assert.equal(ratingCallbacks, 1);
  assert.match(flowSource, /vocabLexemeRatingPreflightOpen\(\s*externalWriteLocked,/);
  assert.match(flowSource, /const externalGateOpen = useCallback[\s\S]*?vocabLexemeExternalGateOpen\([\s\S]*?externalWriteInProgress/);
  assert.match(viewsSource, /if \(operationClaim\.current \|\| externalWriteLocked \|\| !claimReviewMutation\(\)\) return false/);
});

test("same-tick and prepare-await external claims stop lexeme persistence and commit", async () => {
  let external = true;
  let prepareCalls = 0;
  let persistCalls = 0;
  let commitCalls = 0;
  const prepareGate = deferred();
  const run = async () => {
    if (!state.vocabLexemeExternalGateOpen(false, () => external)) return;
    prepareCalls += 1;
    await prepareGate.promise;
    if (!state.vocabLexemeExternalGateOpen(false, () => external)) return;
    persistCalls += 1;
    if (!state.vocabLexemeExternalGateOpen(false, () => external)) return;
    commitCalls += 1;
  };
  await run();
  assert.deepEqual(
    { prepareCalls, persistCalls, commitCalls },
    { prepareCalls: 0, persistCalls: 0, commitCalls: 0 },
    "a same-tick external claim is observed before the first prepare await",
  );

  external = false;
  const pending = run();
  assert.equal(prepareCalls, 1);
  external = true;
  prepareGate.resolve();
  await pending;
  assert.deepEqual(
    { prepareCalls, persistCalls, commitCalls },
    { prepareCalls: 1, persistCalls: 0, commitCalls: 0 },
    "a gate that closes during prepare leaves no durable ticket and calls no commit",
  );
  const start = flowSource.slice(
    flowSource.indexOf("const start = useCallback"),
    flowSource.indexOf("const open = useCallback"),
  );
  assert.ok((start.match(/externalGateOpen\(\)/g) ?? []).length >= 2);
  const commit = flowSource.slice(
    flowSource.indexOf("const commitEntry = useCallback"),
    flowSource.indexOf("const start = useCallback"),
  );
  assert.match(commit, /runWithCurrentVocabLexemeWrite[\s\S]*?!externalGateOpen\(\)[\s\S]*?commitVocabLexemeWrite/);
  const continuation = flowSource.slice(
    flowSource.indexOf("const continueExpected = useCallback"),
    flowSource.indexOf("const discardExpected = useCallback"),
  );
  assert.match(continuation, /!externalGateOpen\(\)[\s\S]*?commitEntry/);
  assert.match(
    appSource,
    /useLayoutEffect\(\(\) => \{[\s\S]*?externalDatabaseOperationRef\.current = \(\) =>[\s\S]*?lexemeBlocksExternalWritesNow\(\)[\s\S]*?engagementBlocksExternalWrites\(\)/,
  );
  assert.match(appSource, /snapshotReadStatusRef\.current !== "ready"[\s\S]*?settingsBlocksExternalWritesNow\(\) \|\| itemBlocksExternalWritesNow\(\)/);
  assert.match(appSource, /claimReviewMutation[\s\S]*?externalDatabaseOperationRef\.current\(\)/);
});

test("App performs lexeme E1/S/E2 whole reads and click handlers never reload expected state", () => {
  const loader = appSource.slice(
    appSource.indexOf("async function loadVocabFactsWithLexemeExpected"),
    appSource.indexOf("class VocabSnapshotSupersededError"),
  );
  const firstExpected = loader.indexOf("loadVocabLexemeExpectedStates()");
  const snapshot = loader.indexOf("loadVocabFactsWithSettingsExpected()");
  const secondExpected = loader.indexOf("loadVocabLexemeExpectedStates()", firstExpected + 1);
  const binding = loader.indexOf("createVocabLexemeBindings");
  assert.ok(firstExpected >= 0 && firstExpected < snapshot);
  assert.ok(snapshot < secondExpected && secondExpected < binding);
  assert.match(loader, /sameVocabLexemeExpectedSet\(lexemeBefore, lexemeAfter\)/);
  assert.match(loader, /sameGeneration/);

  const handlers = appSource.slice(
    appSource.indexOf("const saveLexemeNoteDurably"),
    appSource.indexOf("const discardLexemeDraftAndRead"),
  );
  assert.doesNotMatch(handlers, /loadVocabLexemeExpectedStates|loadVocabSnapshot/);
  assert.match(handlers, /getBoundVocabLexemeExpected/);
  assert.match(handlers, /prepareVocabLexemeNoteSave\(editor\.note, editor\.expected\)/);
  assert.match(handlers, /prepareVocabLexemeStarSet\(!display\.starred, expected\)/);
  assert.match(handlers, /prepareVocabLexemeStatusSet\(nextStatus, expected\)/);
});

test("Flow is durable-first, uncertainty is inspect-only, and committed recovery refreshes without commit", () => {
  const start = flowSource.slice(
    flowSource.indexOf("const start = useCallback"),
    flowSource.indexOf("const open = useCallback"),
  );
  assert.ok(start.indexOf("receipt = await prepare()") < start.indexOf("await persistVocabLexemeWrite"));
  assert.ok(start.indexOf("await persistVocabLexemeWrite") < start.indexOf("await commitEntry"));
  const inspect = flowSource.slice(
    flowSource.indexOf("const inspect = useCallback"),
    flowSource.indexOf("const continueExpected = useCallback"),
  );
  assert.match(inspect, /inspectEntryWithLease/);
  assert.doesNotMatch(inspect, /commitVocabLexemeWrite/);
  const committed = flowSource.slice(
    flowSource.indexOf("const refreshCommitted = useCallback"),
    flowSource.indexOf("const refreshChanged = useCallback"),
  );
  assert.match(committed, /finishCommitted/);
  assert.doesNotMatch(committed, /commitVocabLexemeWrite/);
  assert.match(flowSource, /inspection === "exact_saved"[\s\S]*?lease\.committed\(\)/);
  assert.match(flowSource, /inspection === "changed"[\s\S]*?lease\.changed\(\)/);
  assert.match(flowSource, /flow\.phase === "expected"[\s\S]*?继续同一张收据/);
  assert.match(flowSource, /flow\.phase === "expected"[\s\S]*?不执行并清除提醒/);
});

test("status/rating, restore, navigation, dirty note, and focus gates are wired globally", () => {
  assert.match(appSource, /claimStatusMutation[\s\S]*?reviewRecoveryLockedRef\.current/);
  assert.match(appSource, /releaseReviewMutation[\s\S]*?scanReviewMutationBarrier\(\)/);
  assert.match(viewsSource, /externalWriteLocked[\s\S]*?claimReviewMutation\(\)/);
  assert.match(viewsSource, /onRecoveryBarrierChange\(localRecoveryBlocksWrites\)/);
  assert.match(appSource, /statusWriteLocked=\{reviewRecoveryLocked \|\| cardMutationOwner === "review"\}/);
  assert.match(appSource, /databaseMutationLocked=\{itemDatabaseMutationLocked \|\| lexemeDatabaseMutationLocked \|\| engagementWrites\.backupBlocked\}/);
  assert.match(appSource, /lexemeWrites\.hasHeldReceipt[\s\S]*?reviewRecoveryLocked[\s\S]*?lexemeWrites\.journal\.entries\.length > 0/);
  assert.match(appSource, /vocabLexemeExitDecision/);
  assert.match(appSource, /settingsHasVolatileWork \|\| lexemeHasVolatileWork \|\|\s*engagementVolatileWorkInProgress\(\)/);
  assert.match(appSource, /settingsWrites\.journal\.entries\.length \+ \(settingsWrites\.hasHeldReceipt \? 1 : 0\)/);
  assert.match(appSource, /settingsWrites\.busy \|\|\s*settingsWrites\.operationInProgress\(\) \|\| settingsWrites\.hasVolatileHeldReceipt/);
  assert.match(appSource, /vocabLexemeNoteEditorDirty\(lexemeEditor\)[\s\S]*?beforeunload/);
  assert.match(appSource, /vocabLexemeNoteEditorDirty\(lexemeEditor\) \? "放弃笔记草稿并读取最新" : "只重新读取"/);
  assert.match(flowSource, /hasVolatileOperation = busy \|\| hasVolatileHeldReceipt/);
  assert.match(flowSource, /if \(onAttention\(receipt\) !== false\)/);
  assert.match(appSource, /currentEditor\.lexemeId === receipt\.before\.lexeme\.id/);
});

test("UI is controlled, nonoptimistic, human-readable, safe-default, and 319px usable", () => {
  assert.doesNotMatch(
    `${appSource}\n${viewsSource}\n${overlaysSource}`,
    /\bsaveLexemeNote\s*\(|\bupdateLexemeStatus\s*\(|\btoggleLexemeStar\s*\(/,
  );
  assert.match(overlaysSource, /value=\{note\}[\s\S]*?onNoteChange\(event\.target\.value\)/);
  const noteTextarea = overlaysSource.slice(
    overlaysSource.indexOf("<textarea\n            value={note}"),
    overlaysSource.indexOf("<button\n            disabled={!noteDirty"),
  );
  assert.doesNotMatch(noteTextarea, /disabled=/, "the note textarea stays editable while a receipt is in flight");
  assert.match(overlaysSource, /disabled=\{!noteDirty \|\| writeLocked \|\| writeBusy\}/);
  assert.match(overlaysSource, /data-lexeme-stay[\s\S]*?继续编辑[\s\S]*?className="danger"/);
  assert.match(viewsSource, /disabled=\{lexemeWriteLocked \|\| lexemeWriteBusy\}/);
  assert.match(viewsSource, /occurrenceCounts\.get\(word\.id\) \?\? 0/);
  assert.doesNotMatch(viewsSource.slice(
    viewsSource.indexOf("export function WordsView"),
    viewsSource.indexOf("type ReviewViewProps"),
  ), /word\.occurrence_count/);
  const receiptCopy = flowSource.slice(
    flowSource.indexOf("function receiptText"),
    flowSource.indexOf("export function VocabLexemeWriteRecovery"),
  );
  assert.doesNotMatch(receiptCopy, /operationId|projectionSha256|generationId|generationSequence/);
  assert.match(cssSource, /\.sc-lexeme-write-banner[\s\S]*?min-height:44px/);
  assert.match(cssSource, /\.sc-lexeme-write-recovery[\s\S]*?min-height:44px/);
  assert.match(cssSource, /@media\(max-width:370px\)[\s\S]*?\.sc-word-drawer\{width:100vw/);
  assert.match(cssSource, /\.sc-word-drawer>footer>div\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
});
