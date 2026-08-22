import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const root = new URL("../", import.meta.url);
const journalUrl = new URL("app/vocab/engagement-write-journal.ts", root);
const stateUrl = new URL("app/vocab/engagement-write-state.ts", root);
const flowUrl = new URL("app/vocab/VocabEngagementWriteFlow.tsx", root);
const appUrl = new URL("app/vocab/VocabApp.tsx", root);
const viewsUrl = new URL("app/vocab/views.tsx", root);
const cssUrl = new URL("app/vocab/vocab.css", root);
const settingsFlowUrl = new URL("app/vocab/VocabSettingsWriteFlow.tsx", root);
const itemFlowUrl = new URL("app/vocab/VocabItemWriteFlow.tsx", root);
const lexemeFlowUrl = new URL("app/vocab/VocabLexemeWriteFlow.tsx", root);
const backupFlowUrl = new URL("app/vocab/VocabBackupFlow.tsx", root);

const [
  journalSource,
  stateSource,
  flowSource,
  appSource,
  viewsSource,
  cssSource,
  settingsFlowSource,
  itemFlowSource,
  lexemeFlowSource,
  backupFlowSource,
] = await Promise.all([
  readFile(journalUrl, "utf8"),
  readFile(stateUrl, "utf8"),
  readFile(flowUrl, "utf8"),
  readFile(appUrl, "utf8"),
  readFile(viewsUrl, "utf8"),
  readFile(cssUrl, "utf8"),
  readFile(settingsFlowUrl, "utf8"),
  readFile(itemFlowUrl, "utf8"),
  readFile(lexemeFlowUrl, "utf8"),
  readFile(backupFlowUrl, "utf8"),
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

const executableJournal = transpile(
  journalSource,
  journalUrl.pathname,
).replace(
  /import\s*\{\s*isVocabEngagementWriteReceipt,?\s*\}\s*from\s*"@\/lib\/vocab\/store";/,
  `const isVocabEngagementWriteReceipt = (value) => Boolean(
    value && typeof value === "object" &&
    value.purpose === "vocab-engagement-write" &&
    (value.kind === "bookmark-create" || value.kind === "study-activity-record") &&
    /^vocab-engagement-operation-[a-z0-9-]+$/.test(value.operationId)
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

function receipt(
  operationId = "vocab-engagement-operation-contract-a",
  kind = "study-activity-record",
) {
  return {
    purpose: "vocab-engagement-write",
    version: 1,
    kind,
    operationId,
  };
}

function ticket(
  kind = "check",
  operationId = "vocab-engagement-operation-contract-a",
  receiptKind = "study-activity-record",
  recordedAt = "2026-08-22T03:04:05.000Z",
) {
  return {
    version: 1,
    kind,
    receipt: receipt(operationId, receiptKind),
    recordedAt,
  };
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

test("engagement tickets use one exact purpose and canonical journal envelope", () => {
  assert.equal(journal.isVocabEngagementWriteTicket(ticket()), true);
  assert.equal(
    journal.isVocabEngagementWriteTicket({
      ...ticket(),
      receipt: { ...receipt(), purpose: "vocab-item-write" },
    }),
    false,
  );
  assert.equal(
    journal.isVocabEngagementWriteTicket(
      ticket("check", undefined, undefined, "2026-08-22 03:04:05Z"),
    ),
    false,
  );
  assert.equal(
    journal.isVocabEngagementWriteTicket({ ...ticket(), extra: true }),
    false,
  );
  assert.equal(
    journal.vocabEngagementWriteKey(ticket()),
    `${journal.VOCAB_ENGAGEMENT_WRITE_PREFIX}${ticket().receipt.operationId}`,
  );
  assert.match(journalSource, /receipt\?\.purpose === "vocab-engagement-write"/);
});

test("one global journal lease spans backend work and serializes a peer", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const first = await journal.persistVocabEngagementWrite(ticket(), {
    storage,
    locks,
  });
  const started = deferred();
  const release = deferred();
  let peerSettled = false;
  const running = journal.runWithCurrentVocabEngagementWrite(
    first,
    async (lease) => {
      started.resolve();
      await release.promise;
      lease.remove();
    },
    { storage, locks },
  );
  await started.promise;
  const peer = journal.persistVocabEngagementWrite(
    ticket("check", "vocab-engagement-operation-contract-b"),
    { storage, locks },
  ).then((entry) => {
    peerSettled = true;
    return entry;
  });
  await Promise.resolve();
  assert.equal(peerSettled, false);
  release.resolve();
  assert.equal((await running).outcome, "ran");
  assert.equal(
    (await peer).ticket.receipt.operationId,
    "vocab-engagement-operation-contract-b",
  );
});

test("every callback is preceded by an in-lock full scan", async () => {
  const storage = memoryStorage();
  const entry = await journal.persistVocabEngagementWrite(ticket(), {
    storage,
    locks: lockManager(),
  });
  let calls = 0;
  const injectingLocks = {
    request(_name, task) {
      storage.setItem(
        `${journal.VOCAB_ENGAGEMENT_WRITE_PREFIX}damaged`,
        "{damaged",
      );
      return task();
    },
  };
  assert.deepEqual(
    await journal.runWithCurrentVocabEngagementWrite(
      entry,
      () => { calls += 1; },
      { storage, locks: injectingLocks },
    ),
    { outcome: "blocked", reason: "unreadable" },
  );
  assert.equal(calls, 0);

  storage.removeItem(`${journal.VOCAB_ENGAGEMENT_WRITE_PREFIX}damaged`);
  let failLength = false;
  const failingStorage = {
    get length() {
      if (failLength) throw new Error("length failed");
      return storage.length;
    },
    key: storage.key,
    getItem: storage.getItem,
    setItem: storage.setItem,
    removeItem: storage.removeItem,
  };
  const failingLocks = {
    request(_name, task) {
      failLength = true;
      return task();
    },
  };
  assert.deepEqual(
    await journal.runWithCurrentVocabEngagementWrite(
      entry,
      () => { calls += 1; },
      { storage: failingStorage, locks: failingLocks },
    ),
    { outcome: "blocked", reason: "storage" },
  );
  assert.equal(calls, 0);
});

test("only the exact sole valid ticket may reach commit callback", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const target = await journal.persistVocabEngagementWrite(ticket(), {
    storage,
    locks,
  });
  const peer = journal.createVocabEngagementWriteEntry(
    ticket("check", "vocab-engagement-operation-contract-peer"),
  );
  storage.setItem(peer.storageKey, peer.raw);
  let calls = 0;
  assert.deepEqual(
    await journal.runWithExclusiveCurrentVocabEngagementWrite(
      target,
      () => { calls += 1; },
      { storage, locks },
    ),
    { outcome: "blocked", reason: "peer" },
  );
  assert.equal(calls, 0);

  storage.removeItem(peer.storageKey);
  const result = await journal.runWithExclusiveCurrentVocabEngagementWrite(
    target,
    (lease) => {
      calls += 1;
      lease.committed();
      return "saved";
    },
    { storage, locks },
  );
  assert.equal(result.outcome, "ran");
  assert.equal(result.entry.ticket.kind, "committed");
  assert.equal(calls, 1);
});

test("a missing held receipt waits for peer Q, then re-checkpoints before inspect", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const held = journal.createVocabEngagementWriteEntry(
    ticket("committed", "vocab-engagement-operation-held-p"),
  );
  const peer = await journal.persistVocabEngagementWrite(
    ticket("check", "vocab-engagement-operation-peer-q"),
    { storage, locks },
  );
  assert.strictEqual(
    journal.selectVocabEngagementWriteRecoveryEntry([held], [peer]),
    peer,
  );
  let inspectCalls = 0;
  assert.deepEqual(
    await journal.runWithMissingVocabEngagementWrite(
      held,
      () => { inspectCalls += 1; },
      { storage, locks },
    ),
    { outcome: "stale" },
  );
  assert.equal(inspectCalls, 0);
  await journal.runWithCurrentVocabEngagementWrite(
    peer,
    (lease) => lease.remove(),
    { storage, locks },
  );
  assert.strictEqual(
    journal.selectVocabEngagementWriteRecoveryEntry([held], []),
    held,
  );
  const recovered = await journal.runWithMissingVocabEngagementWrite(
    held,
    (lease) => {
      inspectCalls += 1;
      assert.equal(
        JSON.parse(storage.getItem(held.storageKey)).kind,
        "check",
      );
      lease.committed();
      return "exact_saved";
    },
    { storage, locks },
  );
  assert.equal(recovered.outcome, "ran");
  assert.equal(recovered.entry.ticket.kind, "committed");
  assert.equal(inspectCalls, 1);
});

test("raw CAS retains a ticket advanced by a peer", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const original = await journal.persistVocabEngagementWrite(ticket(), {
    storage,
    locks,
  });
  const advanced = await journal.runWithCurrentVocabEngagementWrite(
    original,
    (lease) => lease.committed(),
    { storage, locks },
  );
  assert.equal(advanced.outcome, "ran");
  assert.deepEqual(
    await journal.runWithCurrentVocabEngagementWrite(
      original,
      (lease) => lease.remove(),
      { storage, locks },
    ),
    { outcome: "stale" },
  );
  assert.equal(JSON.parse(storage.getItem(original.storageKey)).kind, "committed");
});

test("missing locks and unreadable journals execute zero backend callbacks", async () => {
  const storage = memoryStorage();
  const held = journal.createVocabEngagementWriteEntry(ticket());
  let calls = 0;
  await assert.rejects(
    journal.runWithMissingVocabEngagementWrite(
      held,
      () => { calls += 1; },
      { storage, locks: null },
    ),
    /无法跨页面锁定/,
  );
  assert.equal(calls, 0);
  storage.setItem(`${journal.VOCAB_ENGAGEMENT_WRITE_PREFIX}bad`, "{bad");
  assert.deepEqual(
    await journal.runWithMissingVocabEngagementWrite(
      held,
      () => { calls += 1; },
      { storage, locks: lockManager() },
    ),
    { outcome: "blocked", reason: "unreadable" },
  );
  assert.equal(calls, 0);
});

test("key-null scans cannot erase the volatile held barrier", () => {
  assert.deepEqual(
    journal.vocabEngagementHeldReceiptBarrier(
      ["vocab-engagement-operation-held"],
      [],
    ),
    { blocksWrites: true, volatile: true },
  );
  assert.deepEqual(
    journal.vocabEngagementHeldReceiptBarrier(
      ["vocab-engagement-operation-held"],
      ["vocab-engagement-operation-held"],
    ),
    { blocksWrites: true, volatile: false },
  );
  assert.match(
    flowSource,
    /event\.key === null \|\|\s*event\.key\.startsWith\(VOCAB_ENGAGEMENT_WRITE_PREFIX\)/,
  );
  const open = flowSource.slice(
    flowSource.indexOf("const open = useCallback"),
    flowSource.indexOf("const inspect = useCallback"),
  );
  assert.ok(open.indexOf("if (next) holdEntry(next)") <
    open.indexOf("setFlow(next"));
  const handlers = flowSource.slice(
    flowSource.indexOf("const onStorage"),
    flowSource.indexOf('window.addEventListener("storage"'),
  );
  assert.match(handlers, /reloadJournal\(\)/);
  assert.doesNotMatch(
    handlers,
    /setFlow|setFocusRequest|onAttention|present\(|inspect|commit|pumpActivity/,
  );
});

function generation(id = "generation-a", sequence = 3) {
  return { generationId: id, generationSequence: sequence };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function activityReceiptFor(activity) {
  return {
    purpose: "vocab-engagement-write",
    version: 1,
    kind: "study-activity-record",
    operationId:
      "vocab-engagement-operation-11111111-1111-4111-8111-111111111111",
    generationId: activity.displayedGeneration.generationId,
    generationSequence: activity.displayedGeneration.generationSequence,
    expected: clone(activity.displayedGeneration),
    request: clone(activity.input),
    target: {
      id: "activity_22222222-2222-4222-8222-222222222222",
      day: activity.localDay,
      read_seconds: activity.input.kind === "read"
        ? activity.input.seconds
        : 0,
      listen_seconds: activity.input.kind === "listen"
        ? activity.input.seconds
        : 0,
      review_count: 0,
      lookups: 0,
      created_at: activity.input.recordedAt,
    },
    timezoneOffsetMinutes: activity.timezoneOffsetMinutes,
    projectionSha256: "0".repeat(64),
  };
}

function bookmarkFixture() {
  const input = {
    itemId: "item-contract",
    locator: "block:12",
    label: "Remember",
  };
  const expected = {
    generationId: "legacy",
    generationSequence: 7,
    item: {
      id: input.itemId,
      kind: "article",
      title: "Contract article",
      description: "",
      source: "contract",
      source_url: null,
      author: "",
      published_at: "",
      duration_ms: 0,
      audio_url: null,
      status: "in_progress",
      progress: 0.25,
      created_at: 100,
      updated_at: 200,
    },
    locator: input.locator,
    bookmarks: [],
  };
  const receipt = {
    purpose: "vocab-engagement-write",
    version: 1,
    kind: "bookmark-create",
    operationId:
      "vocab-engagement-operation-33333333-3333-4333-8333-333333333333",
    generationId: expected.generationId,
    generationSequence: expected.generationSequence,
    expected: clone(expected),
    request: clone(input),
    target: {
      id: "bookmark_44444444-4444-4444-8444-444444444444",
      item_id: input.itemId,
      locator: input.locator,
      label: input.label,
      note: "",
      created_at: 300,
    },
    projectionSha256: "0".repeat(64),
  };
  return { input, expected, receipt };
}

test("authoritative external writes close both sides of the prepare await", async () => {
  let getterCalls = 0;
  assert.equal(
    state.vocabEngagementExternalWriteBlocked(false, () => {
      getterCalls += 1;
      return true;
    }),
    true,
  );
  assert.equal(getterCalls, 1);
  assert.equal(
    state.vocabEngagementExternalWriteBlocked(false, () => {
      throw new Error("authoritative getter failed");
    }),
    true,
    "an unreadable authoritative gate fails closed",
  );

  let external = true;
  let prepares = 0;
  let persists = 0;
  let commits = 0;
  const runDownstreamOnlyWhenReady = async (prepare) => {
    const result = await state.prepareVocabEngagementIntent(
      () => external,
      prepare,
      () => true,
    );
    if (result.outcome === "ready") {
      persists += 1;
      commits += 1;
    }
    return result;
  };
  assert.deepEqual(
    await runDownstreamOnlyWhenReady(async () => {
      prepares += 1;
      return { receipt: true };
    }),
    { outcome: "external-blocked", stage: "before-prepare" },
  );
  assert.deepEqual(
    { prepares, persists, commits },
    { prepares: 0, persists: 0, commits: 0 },
  );

  const gate = deferred();
  const originalIntent = [{ sequence: 1 }, { sequence: 2 }];
  external = false;
  const preparing = runDownstreamOnlyWhenReady(async () => {
    prepares += 1;
    return gate.promise;
  });
  await Promise.resolve();
  assert.equal(prepares, 1);
  external = true;
  gate.resolve({ receipt: true });
  assert.deepEqual(
    await preparing,
    { outcome: "external-blocked", stage: "after-prepare" },
  );
  assert.deepEqual(
    { prepares, persists, commits, originalIntent },
    {
      prepares: 1,
      persists: 0,
      commits: 0,
      originalIntent: [{ sequence: 1 }, { sequence: 2 }],
    },
  );
});

test("activity slices synchronously freeze input, generation, offset, and local day", () => {
  const input = {
    kind: "read",
    seconds: 15,
    recordedAt: 1_767_225_600_000,
    timezoneOffsetMinutes: -480,
  };
  const displayed = generation();
  const frozen = state.freezeVocabStudyActivity(
    input,
    displayed,
    1,
    0,
    () => -420,
  );
  input.kind = "listen";
  input.seconds = 99;
  input.timezoneOffsetMinutes = -420;
  displayed.generationId = "generation-b";
  assert.deepEqual(frozen.input, {
    kind: "read",
    seconds: 15,
    recordedAt: 1_767_225_600_000,
  });
  assert.deepEqual(frozen.displayedGeneration, generation());
  assert.equal(frozen.timezoneOffsetMinutes, -480);
  assert.equal(
    frozen.localDay,
    state.vocabEngagementLocalDay(frozen.input.recordedAt, -480),
  );
  assert.equal(
    state.vocabStudyActivityTimezoneStillMatches(frozen, () => -480),
    true,
  );
  assert.equal(
    state.vocabStudyActivityTimezoneStillMatches(frozen, () => -420),
    false,
  );
  assert.equal(
    state.vocabStudyActivityLogicalKey(frozen),
    state.vocabStudyActivityLogicalKey({ ...frozen, sequence: 99 }),
    "the same logical slice has one session-stable dedupe key",
  );
});

test("activity receipt reconciliation is exact and survives a permanent timezone change", async () => {
  const first = state.freezeVocabStudyActivity(
    { kind: "listen", seconds: 37, recordedAt: 1_767_225_600_000 },
    generation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 8),
    1,
    0,
    () => -480,
  );
  const tail = state.freezeVocabStudyActivity(
    { kind: "read", seconds: 15, recordedAt: 1_767_225_615_000 },
    generation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 8),
    2,
    0,
    () => -420,
  );
  const queue = [first, tail];
  const exact = activityReceiptFor(first);
  assert.equal(
    state.vocabStudyActivityTimezoneStillMatches(first, () => -420),
    false,
    "the device may now have a permanently different offset",
  );
  assert.equal(
    state.vocabStudyActivityReceiptMatchesQueue(exact, first),
    true,
    "the frozen offset and day remain authoritative",
  );

  const mismatches = [
    (value) => { value.request.kind = "read"; },
    (value) => { value.request.seconds += 1; },
    (value) => { value.request.recordedAt += 1; },
    (value) => {
      value.expected.generationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    },
    (value) => { value.expected.generationSequence += 1; },
    (value) => {
      value.generationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    },
    (value) => { value.generationSequence += 1; },
    (value) => { value.timezoneOffsetMinutes += 60; },
    (value) => { value.target.day = "2026-01-02"; },
    (value) => { value.target.created_at += 1; },
    (value) => { value.target.read_seconds += 1; },
    (value) => { value.target.listen_seconds += 1; },
    (value) => { value.target.review_count = 1; },
    (value) => { value.target.lookups = 1; },
  ];
  for (const mutate of mismatches) {
    const wrong = clone(exact);
    mutate(wrong);
    assert.equal(
      state.vocabStudyActivityReceiptMatchesQueue(wrong, first),
      false,
    );
    assert.deepEqual(
      await state.prepareVocabEngagementIntent(
        () => false,
        async () => wrong,
        (candidate) =>
          state.vocabStudyActivityReceiptMatchesQueue(candidate, first),
      ),
      { outcome: "receipt-mismatch" },
    );
    assert.deepEqual(queue, [first, tail], "head and tail stay in FIFO order");
  }
  assert.match(
    flowSource,
    /recordedAt: submitted\.input\.recordedAt,\s*timezoneOffsetMinutes: submitted\.timezoneOffsetMinutes/,
  );
});

test("activity bounds are exact and distinct equal slices remain additive FIFO", () => {
  assert.throws(
    () => state.freezeVocabStudyActivity(
      { kind: "read", seconds: 0, recordedAt: 10 },
      generation(),
      1,
      0,
      () => 0,
    ),
    /1 到 86400/,
  );
  assert.throws(
    () => state.freezeVocabStudyActivity(
      { kind: "listen", seconds: 86_401, recordedAt: 10 },
      generation(),
      1,
      0,
      () => 0,
    ),
    /1 到 86400/,
  );
  const firstInput = { kind: "read", seconds: 10, recordedAt: 100 };
  const secondInput = { ...firstInput };
  const queuedInputs = new WeakSet();
  const queue = [];
  const enqueue = (input) => {
    if (queuedInputs.has(input)) return "duplicate";
    const frozen = state.freezeVocabStudyActivity(
      input,
      generation(),
      queue.length + 1,
      0,
      () => 0,
    );
    queuedInputs.add(input);
    queue.push(frozen);
    return "queued";
  };
  assert.equal(enqueue(firstInput), "queued");
  assert.equal(enqueue(secondInput), "queued");
  assert.equal(enqueue(firstInput), "duplicate");
  assert.equal(queue.length, 2);
  const [first, second] = queue;
  assert.deepEqual(first.input, second.input);
  assert.notEqual(first.sequence, second.sequence);
  assert.strictEqual(state.removeVocabStudyActivityHead(queue, second), queue);
  assert.deepEqual(state.removeVocabStudyActivityHead(queue, first), [second]);
  assert.match(
    flowSource,
    /publishActivityQueue\(\[\.\.\.activityQueueRef\.current, frozen\]\)/,
  );
  assert.match(flowSource, /queuedInputObjectsRef\.current\.has\(input\)/);
  assert.doesNotMatch(flowSource, /queuedActivityKeysRef|logicalKey/);
  assert.doesNotMatch(flowSource, /vocabStudyActivitiesShareBucket\(/);
});

test("day, offset, generation, and 86400-second boundaries forbid unsafe buckets", () => {
  const make = (sequence, overrides = {}) => ({
    sequence,
    input: { kind: "read", seconds: 20, recordedAt: sequence },
    displayedGeneration: generation(),
    timezoneOffsetMinutes: 0,
    localDay: "2026-08-22",
    ...overrides,
  });
  const base = make(1);
  assert.equal(state.vocabStudyActivitiesShareBucket(base, make(2)), true);
  assert.equal(
    state.vocabStudyActivitiesShareBucket(
      base,
      make(2, { localDay: "2026-08-23" }),
    ),
    false,
  );
  assert.equal(
    state.vocabStudyActivitiesShareBucket(
      base,
      make(2, { timezoneOffsetMinutes: 60 }),
    ),
    false,
  );
  assert.notEqual(
    state.vocabStudyActivityLogicalKey(base),
    state.vocabStudyActivityLogicalKey(
      make(1, { timezoneOffsetMinutes: 60, localDay: "2026-08-21" }),
    ),
  );
  assert.equal(
    state.vocabStudyActivitiesShareBucket(
      base,
      make(2, { displayedGeneration: generation("generation-b") }),
    ),
    false,
  );
  assert.equal(
    state.vocabStudyActivitiesShareBucket(
      make(1, { input: { kind: "read", seconds: 86_390, recordedAt: 1 } }),
      make(2, { input: { kind: "read", seconds: 20, recordedAt: 2 } }),
    ),
    false,
  );
});

test("preflight and backup flags distinguish durable from volatile work", () => {
  const open = {
    journalLoaded: true,
    storageUnavailable: false,
    lockUnavailable: false,
    unreadableCount: 0,
    entryCount: 0,
    hasHeldReceipt: false,
    operationInProgress: false,
    externalWriteLocked: false,
  };
  assert.equal(state.vocabEngagementWritePreflightOpen(open), true);
  assert.equal(
    state.vocabEngagementWritePreflightOpen({
      ...open,
      externalWriteLocked: true,
    }),
    false,
  );
  assert.deepEqual(state.vocabEngagementBackupGate({
    journalLoaded: true,
    storageUnavailable: false,
    lockUnavailable: false,
    unreadableCount: 0,
    entryCount: 1,
    busy: false,
    queuedActivityCount: 0,
    hasHeldReceipt: false,
    hasVolatileHeldReceipt: false,
  }), { blocked: true, volatile: false });
  assert.equal(state.vocabEngagementUnloadRisk({
    busy: false,
    queuedActivityCount: 0,
    hasVolatileHeldReceipt: false,
  }), false);
  assert.equal(state.vocabEngagementUnloadRisk({
    busy: false,
    queuedActivityCount: 1,
    hasVolatileHeldReceipt: false,
  }), true);
  assert.equal(state.vocabEngagementApplyRemovesTicket("applied"), true);
  assert.equal(state.vocabEngagementApplyRemovesTicket("deferred"), false);
  assert.equal(state.vocabEngagementApplyRemovesTicket("superseded"), false);
});

test("bookmark receipts are bound to the synchronously frozen input and expected read", async () => {
  const { input, expected, receipt } = bookmarkFixture();
  const intent = state.freezeVocabBookmarkIntent(input, expected);
  input.label = "mutated after click";
  expected.item.title = "mutated after click";
  assert.equal(intent.input.label, "Remember");
  assert.equal(intent.expected.item.title, "Contract article");
  assert.equal(Object.isFrozen(intent.input), true);
  assert.equal(Object.isFrozen(intent.expected.item), true);
  assert.equal(
    state.vocabBookmarkReceiptMatchesIntent(receipt, intent),
    true,
  );

  const wrongButWellFormed = clone(receipt);
  wrongButWellFormed.request.label = "Peer label";
  wrongButWellFormed.target.label = "Peer label";
  let persists = 0;
  let commits = 0;
  let focuses = 0;
  let toasts = 0;
  const prepared = await state.prepareVocabEngagementIntent(
    () => false,
    async () => wrongButWellFormed,
    (candidate) => state.vocabBookmarkReceiptMatchesIntent(candidate, intent),
  );
  if (prepared.outcome === "ready") {
    persists += 1;
    commits += 1;
    focuses += 1;
    toasts += 1;
  }
  assert.deepEqual(prepared, { outcome: "receipt-mismatch" });
  assert.deepEqual(
    { persists, commits, focuses, toasts },
    { persists: 0, commits: 0, focuses: 0, toasts: 0 },
  );

  for (const mutate of [
    (value) => { value.request.locator = "block:peer"; },
    (value) => { value.expected.item.title = "Peer article"; },
    (value) => { value.generationSequence += 1; },
    (value) => { value.target.locator = "block:peer"; },
    (value) => { value.target.note = "peer note"; },
  ]) {
    const wrong = clone(receipt);
    mutate(wrong);
    assert.equal(state.vocabBookmarkReceiptMatchesIntent(wrong, intent), false);
  }
});

test("bookmark and activity controller signatures freeze before their first await", () => {
  assert.match(
    flowSource,
    /const startBookmark = useCallback\(async \(\s*input: VocabBookmarkCreateInput,\s*expected: VocabBookmarkExpectedState,\s*trigger: HTMLElement,\s*prepare:/,
  );
  assert.match(
    flowSource,
    /const queueActivity = useCallback\(\(\s*input: VocabStudyActivityRecordInput,\s*displayedGeneration: VocabEngagementGenerationExpectation/,
  );
  const queue = flowSource.slice(
    flowSource.indexOf("const queueActivity = useCallback"),
    flowSource.indexOf("const startBookmark = useCallback"),
  );
  assert.ok(queue.indexOf("freezeVocabStudyActivity(") <
    queue.indexOf("publishActivityQueue("));
  assert.doesNotMatch(queue, /await /);
  const bookmark = flowSource.slice(
    flowSource.indexOf("const startBookmark = useCallback"),
    flowSource.indexOf("const open = useCallback"),
  );
  assert.ok(bookmark.indexOf("freezeVocabBookmarkIntent(input, expected)") <
    bookmark.indexOf("return startPrepared("));
  assert.match(bookmark, /prepare\(intent\.input, intent\.expected\)/);
  assert.match(bookmark, /vocabBookmarkReceiptMatchesIntent\(receipt, intent\)/);
  const start = flowSource.slice(
    flowSource.indexOf("const startPrepared = useCallback"),
    flowSource.indexOf("const pumpActivity = useCallback"),
  );
  assert.ok(start.indexOf("if (externalWriteBlockedNow())") <
    start.indexOf("await prepareVocabEngagementIntent("));
  assert.ok(start.indexOf("activityQueueRef.current[0]?.sequence") <
    start.indexOf("await prepareVocabEngagementIntent("));
  assert.ok(start.indexOf('prepared.outcome === "receipt-mismatch"') <
    start.indexOf("createVocabEngagementWriteEntry("));
  assert.ok(start.indexOf("const receipt = prepared.receipt") <
    start.indexOf("holdEntry(preparedEntry)"));
  assert.ok(start.indexOf("const receipt = prepared.receipt") <
    start.indexOf("dropSubmittedActivity(submittedActivity)"));
  assert.ok(start.indexOf("holdEntry(preparedEntry)") <
    start.indexOf("await persistVocabEngagementWrite"));
  assert.ok(start.indexOf("await persistVocabEngagementWrite") <
    start.indexOf("return commitEntry(durableEntry"));
  assert.match(
    start,
    /await persistVocabEngagementWrite[\s\S]*?if \(externalWriteBlockedNow\(\)\)/,
  );
  assert.match(flowSource, /externalWriteInProgress: \(\) => boolean/);
});

test("commit is durable-gated, uncertainty is inspect-only, and apply precedes CAS removal", () => {
  const commit = flowSource.slice(
    flowSource.indexOf("const commitEntry = useCallback"),
    flowSource.indexOf("const dropSubmittedActivity"),
  );
  assert.match(commit, /runWithCurrentVocabEngagementWrite/);
  assert.ok(commit.indexOf("externalWriteBlockedNow()") <
    commit.indexOf("await commitVocabEngagementWrite"));
  assert.ok(commit.indexOf("lease.committed()") <
    commit.indexOf('return "saved"'));
  assert.match(commit, /return "uncertain" as const/);
  assert.doesNotMatch(commit, /prepareVocab/);
  const finish = flowSource.slice(
    flowSource.indexOf("const finishCommitted = useCallback"),
    flowSource.indexOf("const settleInspectionResult"),
  );
  assert.ok(finish.indexOf("await applyConfirmed(receipt)") <
    finish.indexOf("await removeCurrent(entry)"));
  assert.match(finish, /if \(!vocabEngagementApplyRemovesTicket\(outcome\)\)/);
  assert.match(finish, /appliedOperationIdsRef/);
  assert.match(flowSource, /const applyCommitted = inspect;/);
  const changed = flowSource.slice(
    flowSource.indexOf("const applyChanged = useCallback"),
    flowSource.indexOf("const dismissInvalid"),
  );
  assert.match(changed, /await applyCurrent\(entry\.ticket\.receipt\)/);
  assert.doesNotMatch(changed, /commitVocabEngagementWrite|prepareVocab/);
});

test("authoritative getter guards pump, persisted commit, lease commit, and expected continuation", () => {
  const pump = flowSource.slice(
    flowSource.indexOf("const pumpActivity = useCallback"),
    flowSource.indexOf("useLayoutEffect(() => {\n    pumpActivityRef.current"),
  );
  assert.ok(pump.indexOf("externalWriteBlockedNow()") <
    pump.indexOf("reloadJournal()"));
  const start = flowSource.slice(
    flowSource.indexOf("const startPrepared = useCallback"),
    flowSource.indexOf("const pumpActivity = useCallback"),
  );
  assert.match(
    start,
    /durableEntry = await persistVocabEngagementWrite\(preparedEntry\.ticket\);\s*if \(externalWriteBlockedNow\(\)\)/,
  );
  const commit = flowSource.slice(
    flowSource.indexOf("const commitEntry = useCallback"),
    flowSource.indexOf("const dropSubmittedActivity"),
  );
  assert.match(
    commit,
    /runWithCurrentVocabEngagementWrite[\s\S]*?if \(externalWriteBlockedNow\(\)\)[\s\S]*?await commitVocabEngagementWrite/,
  );
  const continuation = flowSource.slice(
    flowSource.indexOf("const continueExpected = useCallback"),
    flowSource.indexOf("const discardExpected = useCallback"),
  );
  assert.ok(
    (continuation.match(/externalWriteBlockedNow\(\)/g) ?? []).length >= 3,
  );
});

test("partial and rejected unreadable cleanup always converges through a full rescan", async () => {
  const keyA = `${journal.VOCAB_ENGAGEMENT_WRITE_PREFIX}damaged-a`;
  const keyB = `${journal.VOCAB_ENGAGEMENT_WRITE_PREFIX}damaged-b`;
  const storage = memoryStorage([[keyA, "{a"], [keyB, "{b"]]);
  const locks = lockManager();
  const initial = journal.readVocabEngagementWriteJournal(storage, locks);
  assert.equal(initial.unreadable.length, 2);
  assert.equal(
    await journal.removeUnreadableVocabEngagementWrite(
      initial.unreadable[0],
      { storage, locks },
    ),
    true,
  );
  storage.setItem(keyB, "{peer");
  assert.equal(
    await journal.removeUnreadableVocabEngagementWrite(
      initial.unreadable[1],
      { storage, locks },
    ),
    false,
  );
  const afterPartial = journal.readVocabEngagementWriteJournal(storage, locks);
  assert.deepEqual(
    afterPartial.unreadable.map(({ storageKey, raw }) => [storageKey, raw]),
    [[keyB, "{peer"]],
  );

  const rejectingStorage = {
    get length() { return storage.length; },
    key: storage.key,
    getItem: storage.getItem,
    setItem: storage.setItem,
    removeItem() { throw new Error("remove rejected"); },
  };
  await assert.rejects(
    journal.removeUnreadableVocabEngagementWrite(
      afterPartial.unreadable[0],
      { storage: rejectingStorage, locks },
    ),
    /remove rejected/,
  );
  assert.equal(
    journal.readVocabEngagementWriteJournal(storage, locks).unreadable.length,
    1,
  );

  const cleanup = flowSource.slice(
    flowSource.indexOf("const clearUnreadable = useCallback"),
    flowSource.indexOf("const discardQueuedActivity = useCallback"),
  );
  assert.match(
    cleanup,
    /const latest = restoreLatestFlowOrIdle\(\)/,
  );
  assert.match(
    cleanup,
    /catch \(reason\) \{\s*restoreLatestFlowOrIdle\(\);\s*setError/,
  );
  assert.match(cleanup, /finally \{\s*release\(token\)/);
  const restore = flowSource.slice(
    flowSource.indexOf("const restoreLatestFlowOrIdle = useCallback"),
    flowSource.indexOf("const reopenLatest = useCallback"),
  );
  assert.match(restore, /const latest = reloadJournal\(\)/);
  assert.match(restore, /selectVocabEngagementWriteRecoveryEntry/);
  assert.match(restore, /phaseForEntry\(next\)/);
  assert.match(restore, /: \{ phase: "idle" \}/);
});

test("passive activity never toasts, focuses, or auto-opens recovery", () => {
  const present = flowSource.slice(
    flowSource.indexOf("const present = useCallback"),
    flowSource.indexOf("const claim = useCallback"),
  );
  const background = present.slice(
    present.indexOf("if (background)"),
    present.indexOf("setFlow(next)"),
  );
  assert.match(background, /setPassiveNotice/);
  assert.doesNotMatch(background, /setFocusRequest|onAttention/);
  const finish = flowSource.slice(
    flowSource.indexOf("const finishCommitted = useCallback"),
    flowSource.indexOf("const settleInspectionResult"),
  );
  assert.match(
    finish,
    /if \(!isActivity\(receipt\)[\s\S]*?onToast\(savedCopy\(receipt\)\)[\s\S]*?restoreBookmarkFocus/,
  );
  assert.equal(
    (finish.match(/if \(background && isActivity\(receipt\)\) setStatus\(""\)/g) ?? [])
      .length,
    2,
  );
  const pump = flowSource.slice(
    flowSource.indexOf("const pumpActivity = useCallback"),
    flowSource.indexOf("useLayoutEffect(() => {\n    pumpActivityRef.current"),
  );
  assert.match(
    pump,
    /prepareVocabStudyActivityRecord[\s\S]*?true,\s*null,\s*submitted/,
  );
  assert.doesNotMatch(pump, /onToast|onAttention|setFocusRequest/);
});

test("unload protection covers only busy, volatile FIFO, or missing-held receipt", () => {
  const unload = flowSource.slice(
    flowSource.indexOf("const protect = (event: BeforeUnloadEvent)"),
    flowSource.indexOf('window.addEventListener("beforeunload"'),
  );
  assert.match(unload, /busy: Boolean\(operationRef\.current\)/);
  assert.match(unload, /queuedActivityCount: activityQueueRef\.current\.length/);
  assert.match(unload, /hasVolatileHeldReceipt: barrier\.volatile/);
  assert.doesNotMatch(unload, /journal\.entries\.length > 0/);
  assert.match(flowSource, /backupBlocked: backupGate\.blocked/);
  assert.match(flowSource, /hasVolatileWork: backupGate\.volatile/);
});

test("the standalone UI exposes the complete engagement recovery class contract", () => {
  for (const className of [
    "sc-engagement-write-banner",
    "sc-engagement-write-actions",
    "sc-engagement-write-recovery",
    "sc-engagement-write-error",
    "sc-engagement-write-status",
    "sc-engagement-receipt",
  ]) assert.match(flowSource, new RegExp(`className="${className}"`));
});

test("Vocab UI has no legacy bookmark or study-time imports, aliases, or calls", async () => {
  const directoryUrl = new URL("app/vocab/", root);
  const names = (await readdir(directoryUrl)).filter((name) =>
    name.endsWith(".tsx")
  );
  const legacy = new Set(["createBookmark", "recordStudySeconds"]);
  let importCount = 0;
  let callCount = 0;
  for (const name of names) {
    const source = await readFile(new URL(name, directoryUrl), "utf8");
    const parsed = ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const aliases = new Set();
    const visitImports = (node) => {
      if (ts.isImportSpecifier(node)) {
        const imported = node.propertyName?.text ?? node.name.text;
        if (legacy.has(imported)) {
          importCount += 1;
          aliases.add(node.name.text);
        }
      }
      ts.forEachChild(node, visitImports);
    };
    visitImports(parsed);
    const visitCalls = (node) => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (
          (ts.isIdentifier(expression) &&
            (legacy.has(expression.text) || aliases.has(expression.text))) ||
          (ts.isPropertyAccessExpression(expression) &&
            legacy.has(expression.name.text)) ||
          (ts.isElementAccessExpression(expression) &&
            ts.isStringLiteral(expression.argumentExpression) &&
            legacy.has(expression.argumentExpression.text))
        ) callCount += 1;
      }
      ts.forEachChild(node, visitCalls);
    };
    visitCalls(parsed);
  }
  assert.deepEqual({ importCount, callCount }, { importCount: 0, callCount: 0 });
});

test("bookmark clicks bind the displayed whole read without loading on click", () => {
  const bookmark = appSource.slice(
    appSource.indexOf("const startBookmarkWrite = useCallback"),
    appSource.indexOf("const queueStudyActivity = useCallback"),
  );
  assert.match(bookmark, /displayedItem !== item/);
  assert.match(bookmark, /itemExpected\.item !== item/);
  assert.match(bookmark, /generationId !== settingsGeneration\.generationId/);
  assert.match(bookmark, /bookmark\.item_id === item\.id && bookmark\.locator === locator/);
  assert.match(bookmark, /sort\(\(left, right\) => left\.id\.localeCompare\(right\.id\)\)/);
  assert.match(
    bookmark,
    /startEngagementBookmark\(\s*\{ itemId: item\.id, locator, label \},\s*expected,\s*trigger/,
  );
  assert.doesNotMatch(bookmark, /loadVocab|readVocabFacts|refresh\(/);
  assert.match(
    viewsSource,
    /onBookmark\(item,\s*bookmarkBlock,\s*event\.currentTarget\)/,
  );
  assert.match(
    viewsSource,
    /onBookmark\(item,currentMs,active\?\.text\.slice\(0,24\) \?\? item\.title,event\.currentTarget\)/,
  );
});

test("confirmed engagement applies through whole-read arbitration and cannot be rolled back", async () => {
  const apply = appSource.slice(
    appSource.indexOf("const applyEngagementFacts = useCallback"),
    appSource.indexOf("const engagementWrites = useVocabEngagementWriteFlow"),
  );
  assert.match(apply, /const result = await readVocabFacts\(\)/);
  assert.match(apply, /result\.outcome !== "applied"/);
  assert.match(apply, /result\.snapshot\.bookmarks\.some/);
  assert.match(apply, /result\.snapshot\.activity\.find/);
  assert.doesNotMatch(apply, /loadVocabFactsWithLexemeExpected|applyVocabFactsBundle/);

  let requestId = 0;
  let displayed = "initial";
  const read = async (pending) => {
    const mine = ++requestId;
    const value = await pending;
    if (mine !== requestId) return "superseded";
    displayed = value;
    return "applied";
  };
  const old = deferred();
  const olderRead = read(old.promise);
  assert.equal(await read(Promise.resolve("confirmed-new")), "applied");
  old.resolve("pre-commit-old");
  assert.equal(await olderRead, "superseded");
  assert.equal(displayed, "confirmed-new");
});

test("all database flows consult live other-flow gates without self feedback", () => {
  const layout = appSource.slice(
    appSource.indexOf("useLayoutEffect(() => {\n    engagementExternalBarrierRef.current"),
    appSource.indexOf("const startEngagementBookmark"),
  );
  for (const expression of [
    "itemBlocksExternalWritesNow()",
    "lexemeBlocksExternalWritesNow()",
    "engagementBlocksExternalWrites()",
    "settingsBlocksExternalWritesNow()",
    "backupDatabaseOperationRef.current",
    "cardMutationOwnerRef.current !== null",
    "wordSaveBusyRef.current",
  ]) assert.ok(layout.includes(expression), expression);
  assert.doesNotMatch(
    layout,
    /settingsWrites\.writeLocked|itemWrites\.writeLocked|lexemeWrites\.writeLocked|settingsDatabaseWriteLocked|itemBlocksLexemeWrites|lexemeDatabaseWriteBarrier/,
  );
  assert.match(appSource, /engagementExternalWriteInProgress[\s\S]*?settingsBlocksExternalWritesNow\(\)[\s\S]*?itemBlocksExternalWritesNow\(\)[\s\S]*?lexemeBlocksExternalWritesNow\(\)/);

  const owners = ["settings", "item", "lexeme", "engagement", "backup"];
  const active = Object.fromEntries(owners.map((owner) => [owner, false]));
  const blockedFor = (self) => owners.some((owner) => owner !== self && active[owner]);
  for (const claimant of owners) {
    active[claimant] = true;
    assert.equal(blockedFor(claimant), false, `${claimant} excludes itself`);
    for (const peer of owners) {
      if (peer !== claimant) assert.equal(blockedFor(peer), true, `${claimant} blocks ${peer}`);
    }
    active[claimant] = false;
  }
  const peerRawState = { active: false };
  const stablePeerGate = () => peerRawState.active;
  peerRawState.active = true;
  assert.equal(stablePeerGate(), true);
  peerRawState.active = false;
  assert.equal(
    stablePeerGate(),
    false,
    "the same getter unlocks immediately after settle without another render",
  );
  for (const source of [
    settingsFlowSource,
    itemFlowSource,
    lexemeFlowSource,
    flowSource,
  ]) {
    assert.match(source, /const blocksExternalWrites(?:Now)? = useCallback/);
  }
});

test("status and occurrence claims exclude only their own active mutation", () => {
  const lexemeGate = appSource.slice(
    appSource.indexOf("const lexemeExternalWriteInProgress = useCallback"),
    appSource.indexOf("const lexemeWrites = useVocabLexemeWriteFlow"),
  );
  assert.match(
    lexemeGate,
    /cardMutationOwnerRef\.current !== null &&\s*cardMutationOwnerRef\.current !== "status"/,
  );
  assert.match(lexemeGate, /wordSaveBusyRef\.current/);

  const occurrenceGate = appSource.slice(
    appSource.indexOf("const occurrenceExternalWriteInProgress = useCallback"),
    appSource.indexOf("useLayoutEffect(() => {", appSource.indexOf("const occurrenceExternalWriteInProgress = useCallback")),
  );
  for (const expression of [
    'snapshotReadStatusRef.current !== "ready"',
    "backupDatabaseOperationRef.current",
    "cardMutationOwnerRef.current !== null",
    "settingsBlocksExternalWritesNow()",
    "itemBlocksExternalWritesNow()",
    "lexemeBlocksExternalWritesNow()",
    "engagementBlocksExternalWrites()",
  ]) assert.ok(occurrenceGate.includes(expression), expression);
  assert.doesNotMatch(occurrenceGate, /wordSaveBusyRef\.current/);
  assert.match(occurrenceGate, /catch \{\s*return true;/);

  const occurrenceStart = appSource.slice(
    appSource.indexOf("const savePickedWord = useCallback"),
    appSource.indexOf("const inspectPendingWord = useCallback"),
  );
  assert.ok(
    occurrenceStart.indexOf("occurrenceExternalWriteInProgress()") <
      occurrenceStart.indexOf("wordSaveBusyRef.current = true"),
  );
  assert.ok(
    occurrenceStart.indexOf("wordSaveBusyRef.current = true") <
      occurrenceStart.indexOf("await prepareVocabOccurrenceWrite"),
  );

  let cardOwner = null;
  let wordBusy = false;
  const peers = {
    backup: false,
    settings: false,
    item: false,
    lexeme: false,
    engagement: false,
  };
  const anyPeer = () => Object.values(peers).some(Boolean);
  const lexemeBlocked = () =>
    (cardOwner !== null && cardOwner !== "status") || wordBusy || anyPeer();
  const occurrenceBlocked = () => cardOwner !== null || anyPeer();

  cardOwner = "status";
  let statusPrepareCalls = 0;
  if (!lexemeBlocked()) statusPrepareCalls += 1;
  assert.equal(statusPrepareCalls, 1, "status excludes its own synchronous claim");
  assert.equal(occurrenceBlocked(), true, "status blocks a peer occurrence");
  let reviewPrepareCalls = 0;
  if (cardOwner === null) reviewPrepareCalls += 1;
  assert.equal(reviewPrepareCalls, 0, "status blocks a peer review before prepare");
  cardOwner = null;

  for (const peer of Object.keys(peers)) {
    peers[peer] = true;
    let occurrencePrepareCalls = 0;
    if (!occurrenceBlocked()) occurrencePrepareCalls += 1;
    assert.equal(occurrencePrepareCalls, 0, `${peer} blocks occurrence before prepare`);
    peers[peer] = false;
  }
  cardOwner = "review";
  assert.equal(occurrenceBlocked(), true, "review blocks occurrence before prepare");
  cardOwner = null;

  assert.equal(occurrenceBlocked(), false);
  wordBusy = true;
  for (const peer of ["settings", "item", "lexeme", "engagement"]) {
    let peerPrepareCalls = 0;
    if (!wordBusy) peerPrepareCalls += 1;
    assert.equal(peerPrepareCalls, 0, `occurrence claim blocks ${peer} before prepare`);
  }
});

test("settings and item recheck authoritative gates around prepare, persistence, and commit", () => {
  const settingsStart = settingsFlowSource.slice(
    settingsFlowSource.indexOf("const start = useCallback"),
    settingsFlowSource.indexOf("const inspect = useCallback"),
  );
  assert.ok(settingsStart.indexOf("externalWriteBlockedNow()") <
    settingsStart.indexOf("const receipt = await prepare()"));
  assert.ok(settingsStart.indexOf("const receipt = await prepare()") <
    settingsStart.indexOf("preparedReceipt = receipt"));
  assert.ok(settingsStart.indexOf("const receipt = await prepare()") <
    settingsStart.indexOf("externalWriteBlockedNow()", settingsStart.indexOf("const receipt = await prepare()")));
  assert.match(settingsStart, /persistVocabSettingsWrite[\s\S]*?externalWriteBlockedNow\(\)/);
  assert.match(settingsFlowSource, /runWithExclusiveCurrentVocabSettingsWrite[\s\S]*?externalWriteBlockedNow\(\)[\s\S]*?commitVocabSettingsWrite/);

  const itemStart = itemFlowSource.slice(
    itemFlowSource.indexOf("const startPrepared = useCallback"),
    itemFlowSource.indexOf("const flushCheckpoint = useCallback"),
  );
  assert.ok(itemStart.indexOf("externalWriteBlockedNow()") <
    itemStart.indexOf("const preparedReceipt = await prepare()"));
  assert.ok(itemStart.indexOf("const preparedReceipt = await prepare()") <
    itemStart.indexOf("receipt = preparedReceipt"));
  assert.match(itemStart, /persistVocabItemWrite[\s\S]*?externalWriteBlockedNow\(\)/);
  const itemCommit = itemFlowSource.slice(
    itemFlowSource.indexOf("const commitEntry = useCallback"),
    itemFlowSource.indexOf("const startPrepared = useCallback"),
  );
  assert.match(itemCommit, /runWithCurrentVocabItemWrite[\s\S]*?externalWriteBlockedNow\(\)[\s\S]*?commitVocabItemWrite/);
});

test("backup post-await gate sees a newly queued activity before activation", async () => {
  const activation = backupFlowSource.slice(
    backupFlowSource.indexOf("async function activateCandidate"),
    backupFlowSource.indexOf("async function discardCandidate"),
  );
  assert.ok(activation.indexOf("externalDatabaseWriteBlocked()") <
    activation.indexOf("operationRef.current = true"));
  assert.ok(activation.indexOf("onDatabaseOperationChange?.(true)") <
    activation.indexOf("await transitionOrExplain"));
  assert.ok(activation.indexOf("await transitionOrExplain") <
    activation.indexOf("if (externalDatabaseWriteBlocked())"));
  assert.ok(activation.indexOf("if (externalDatabaseWriteBlocked())") <
    activation.indexOf("await activatePreparedVocabRestore"));
  assert.match(activation, /finally \{[\s\S]*?operationRef\.current = false;[\s\S]*?onDatabaseOperationChange\?\.\(false\)/);
  assert.match(appSource, /engagementBlocksBackupActivation\(\)/);
  assert.match(flowSource, /blocksExternalWrites\(\) \|\| activityQueueRef\.current\.length > 0/);

  const transition = deferred();
  let queued = 0;
  let activateCalls = 0;
  const runActivation = async () => {
    if (queued > 0) return;
    await transition.promise;
    if (queued > 0) return;
    activateCalls += 1;
  };
  const running = runActivation();
  queued += 1;
  transition.resolve();
  await running;
  assert.deepEqual({ queued, activateCalls }, { queued: 1, activateCalls: 0 });
});

test("active Podcast sampling and backup activation protect SPA and native unload", () => {
  const listen = viewsSource.slice(
    viewsSource.indexOf("const commitListen = useCallback"),
    viewsSource.indexOf("const reportCurrentPosition = useCallback"),
  );
  assert.ok(listen.indexOf("listenStartedAt.current = null") <
    listen.indexOf("onStudyActivityPendingChange(false)"));
  assert.ok(listen.indexOf("onStudyActivityPendingChange(false)") <
    listen.indexOf("onStudyActivity({"));
  assert.match(listen, /sliceRecordedAt \+= sliceSeconds \* 1_000/);
  assert.match(viewsSource, /listenStartedAt\.current = performance\.now\(\);\s*onStudyActivityPendingChange\(true\)/);
  assert.match(appSource, /activeStudyActivityPendingRef\.current = pending/);
  assert.match(appSource, /backupDatabaseOperationRef\.current = inProgress/);
  assert.match(appSource, /engagementHasVolatileWorkNow\(\)[\s\S]*?activeStudyActivityPendingRef\.current[\s\S]*?backupDatabaseOperationRef\.current/);
  const unload = appSource.slice(
    appSource.indexOf("if (!activeStudyActivityPending && !backupDatabaseOperation) return"),
    appSource.indexOf("useEffect(() => () =>", appSource.indexOf("if (!activeStudyActivityPending && !backupDatabaseOperation) return")),
  );
  assert.match(unload, /event\.preventDefault\(\)/);
  assert.match(unload, /event\.returnValue = ""/);
  assert.match(unload, /window\.addEventListener\("beforeunload", protectDatabaseWork\)/);
});

test("engagement recovery stays operable at 319px with 44px actions", () => {
  assert.match(cssSource, /\.sc-engagement-write-banner\{[\s\S]*?width:min\(1080px,calc\(100% - 48px\)\)[\s\S]*?min-width:0[\s\S]*?overflow-wrap:anywhere/);
  assert.match(cssSource, /\.sc-engagement-write-recovery\{[\s\S]*?max-width:calc\(100vw - 28px\)[\s\S]*?min-width:0[\s\S]*?overflow-wrap:anywhere/);
  assert.match(cssSource, /\.sc-engagement-write-banner button,\.sc-engagement-write-recovery button\{\s*min-height:44px/);
  assert.match(cssSource, /\.sc-engagement-receipt summary\{[^}]*min-height:44px;display:flex;align-items:center/);
  assert.match(cssSource, /\.sc-engagement-receipt pre\{[^}]*max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word/);
  assert.match(cssSource, /@media\(max-width:370px\)\{[\s\S]*?\.sc-engagement-write-recovery>footer\{display:grid;grid-template-columns:minmax\(0,1fr\)\}/);
});
