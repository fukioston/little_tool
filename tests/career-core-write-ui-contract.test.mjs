import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const root = new URL("../", import.meta.url);
const journalUrl = new URL("app/career/core-write-journal.ts", root);
const stateUrl = new URL("app/career/core-write-state.ts", root);
const flowUrl = new URL("app/career/CareerCoreWriteFlow.tsx", root);
const appUrl = new URL("app/career/CareerApp.tsx", root);
const cssUrl = new URL("app/career/career.css", root);

const [journalSource, stateSource, flowSource, appSource, css] =
  await Promise.all([
    readFile(journalUrl, "utf8"),
    readFile(stateUrl, "utf8"),
    readFile(flowUrl, "utf8"),
    readFile(appUrl, "utf8"),
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
      category === ts.DiagnosticCategory.Error),
    [],
  );
  return result.outputText;
}

const executableJournal = transpile(journalSource, journalUrl.pathname).replace(
  /import\s*\{\s*isCareerCoreWriteReceipt,?\s*\}\s*from\s*"@\/lib\/career\/core-writes";/,
  `const isCareerCoreWriteReceipt = (value) => Boolean(
    value && typeof value === "object" &&
    value.purpose === "career-core-write" &&
    ["stage-rename", "job-create", "job-update", "interview-create", "interview-update"].includes(value.kind) &&
    /^career-core-operation-[a-z0-9-]+$/.test(value.operationId)
  );`,
);
assert.doesNotMatch(executableJournal, /@\/lib\/career\/core-writes/);
const journal = await import(
  `data:text/javascript;base64,${Buffer.from(executableJournal).toString("base64")}`
);

const executableState = transpile(stateSource, stateUrl.pathname);
assert.doesNotMatch(executableState, /^import /m);
const state = await import(
  `data:text/javascript;base64,${Buffer.from(executableState).toString("base64")}`
);

function receipt(
  operationId = "career-core-operation-contract-a",
  kind = "job-update",
) {
  return {
    purpose: "career-core-write",
    version: 1,
    kind,
    operationId,
  };
}

function ticket(
  kind = "check",
  operationId = "career-core-operation-contract-a",
  receiptKind = "job-update",
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("core tickets are purpose-bound, exact, canonical, and bounded", () => {
  assert.equal(journal.isCareerCoreWriteTicket(ticket()), true);
  assert.equal(journal.isCareerCoreWriteTicket({ ...ticket(), extra: true }), false);
  assert.equal(
    journal.isCareerCoreWriteTicket({
      ...ticket(),
      receipt: { ...receipt(), purpose: "career-contact-write" },
    }),
    false,
  );
  assert.equal(
    journal.isCareerCoreWriteTicket(
      ticket("check", undefined, undefined, "2026-08-22 03:04:05Z"),
    ),
    false,
  );
  assert.equal(
    journal.careerCoreWriteKey(ticket()),
    `${journal.CAREER_CORE_WRITE_PREFIX}${ticket().receipt.operationId}`,
  );
  assert.match(journalSource, /receipt\?\.purpose === "career-core-write"/);
});

test("full scans fail closed on unreadable, null, duplicate, and moving storage", () => {
  const valid = journal.createCareerCoreWriteEntry(ticket());
  const storage = memoryStorage([["unrelated", "ok"], [valid.storageKey, valid.raw]]);
  const locks = lockManager();
  assert.equal(journal.readCareerCoreWriteJournal(storage, locks).entries.length, 1);

  storage.setItem(`${journal.CAREER_CORE_WRITE_PREFIX}damaged`, "{damaged");
  const damaged = journal.readCareerCoreWriteJournal(storage, locks);
  assert.equal(damaged.storageUnavailable, false);
  assert.equal(damaged.unreadable.length, 1);

  const nullKeyStorage = {
    get length() { return 1; },
    key() { return null; },
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  };
  assert.equal(
    journal.readCareerCoreWriteJournal(nullKeyStorage, locks).storageUnavailable,
    true,
  );

  let reads = 0;
  const movingStorage = {
    get length() { reads += 1; return reads === 1 ? 1 : 2; },
    key() { return "unrelated"; },
    getItem() { return "ok"; },
    setItem() {},
    removeItem() {},
  };
  assert.equal(
    journal.readCareerCoreWriteJournal(movingStorage, locks).storageUnavailable,
    true,
  );

  const duplicateStorage = {
    get length() { return 2; },
    key() { return "same"; },
    getItem() { return "ok"; },
    setItem() {},
    removeItem() {},
  };
  assert.equal(
    journal.readCareerCoreWriteJournal(duplicateStorage, locks).storageUnavailable,
    true,
  );
});

test("one global journal lease serializes peers across backend work", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const first = await journal.persistCareerCoreWrite(ticket(), { storage, locks });
  const started = deferred();
  const release = deferred();
  let peerSettled = false;
  const running = journal.runWithCurrentCareerCoreWrite(
    first,
    async (lease) => {
      started.resolve();
      await release.promise;
      lease.remove();
    },
    { storage, locks },
  );
  await started.promise;
  const peer = journal.persistCareerCoreWrite(
    ticket("check", "career-core-operation-contract-b"),
    { storage, locks },
  ).then((entry) => { peerSettled = true; return entry; });
  await Promise.resolve();
  assert.equal(peerSettled, false);
  release.resolve();
  assert.equal((await running).outcome, "ran");
  assert.equal(
    (await peer).ticket.receipt.operationId,
    "career-core-operation-contract-b",
  );
});

test("only the exact sole raw ticket reaches a leased callback", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const target = await journal.persistCareerCoreWrite(ticket(), { storage, locks });
  const peer = journal.createCareerCoreWriteEntry(
    ticket("check", "career-core-operation-contract-peer"),
  );
  storage.setItem(peer.storageKey, peer.raw);
  let calls = 0;
  assert.deepEqual(
    await journal.runWithCurrentCareerCoreWrite(
      target,
      () => { calls += 1; },
      { storage, locks },
    ),
    { outcome: "blocked", reason: "peer" },
  );
  assert.equal(calls, 0);

  storage.removeItem(peer.storageKey);
  const advanced = await journal.runWithCurrentCareerCoreWrite(
    target,
    (lease) => { calls += 1; lease.committed(); return "saved"; },
    { storage, locks },
  );
  assert.equal(advanced.outcome, "ran");
  assert.equal(advanced.entry.ticket.kind, "committed");
  assert.equal(calls, 1);
  assert.deepEqual(
    await journal.runWithCurrentCareerCoreWrite(
      target,
      (lease) => lease.remove(),
      { storage, locks },
    ),
    { outcome: "stale" },
  );
  assert.equal(JSON.parse(storage.getItem(target.storageKey)).kind, "committed");
});

test("a missing held receipt waits for its peer then checkpoints before inspect", async () => {
  const storage = memoryStorage();
  const locks = lockManager();
  const held = journal.createCareerCoreWriteEntry(
    ticket("changed", "career-core-operation-held-p"),
  );
  const peer = await journal.persistCareerCoreWrite(
    ticket("check", "career-core-operation-peer-q"),
    { storage, locks },
  );
  assert.strictEqual(
    journal.selectCareerCoreWriteRecoveryEntry([held], [peer]),
    peer,
  );
  let inspections = 0;
  assert.deepEqual(
    await journal.runWithMissingCareerCoreWrite(
      held,
      () => { inspections += 1; },
      { storage, locks },
    ),
    { outcome: "stale" },
  );
  assert.equal(inspections, 0);
  await journal.runWithCurrentCareerCoreWrite(
    peer,
    (lease) => lease.remove(),
    { storage, locks },
  );
  const recovered = await journal.runWithMissingCareerCoreWrite(
    held,
    (lease) => {
      inspections += 1;
      assert.equal(JSON.parse(storage.getItem(held.storageKey)).kind, "check");
      lease.changed();
      return "changed";
    },
    { storage, locks },
  );
  assert.equal(recovered.outcome, "ran");
  assert.equal(recovered.entry.ticket.kind, "changed");
  assert.equal(inspections, 1);
});

test("missing locks and unreadable peers run zero callbacks", async () => {
  const storage = memoryStorage();
  const held = journal.createCareerCoreWriteEntry(ticket());
  let calls = 0;
  await assert.rejects(
    journal.runWithMissingCareerCoreWrite(
      held,
      () => { calls += 1; },
      { storage, locks: null },
    ),
    /无法跨页面锁定/,
  );
  storage.setItem(`${journal.CAREER_CORE_WRITE_PREFIX}bad`, "{bad");
  assert.deepEqual(
    await journal.runWithMissingCareerCoreWrite(
      held,
      () => { calls += 1; },
      { storage, locks: lockManager() },
    ),
    { outcome: "blocked", reason: "unreadable" },
  );
  assert.equal(calls, 0);
});

test("held receipts survive key-null rescans and distinguish volatile work", () => {
  assert.deepEqual(
    journal.careerCoreHeldReceiptBarrier(
      ["career-core-operation-held"],
      [],
    ),
    { blocksWrites: true, volatile: true },
  );
  assert.deepEqual(
    journal.careerCoreHeldReceiptBarrier(
      ["career-core-operation-held"],
      ["career-core-operation-held"],
    ),
    { blocksWrites: true, volatile: false },
  );
  assert.match(
    flowSource,
    /event\.key === null \|\| event\.key\.startsWith\(CAREER_CORE_WRITE_PREFIX\)/,
  );
});

const stage = {
  id: "stage_saved",
  name: "Saved",
  color: "#446655",
  position: 1,
  is_terminal: 0,
  hidden: 0,
};
const job = {
  id: "job_contract",
  company: "Company",
  role: "Role",
  location: "Remote",
  source: "Manual",
  source_url: "",
  stage_id: stage.id,
  priority: 1,
  salary: "",
  work_mode: "Remote",
  description: "Description",
  applied_at: null,
  deadline: null,
  contact_name: "",
  note: "",
  tags: "",
  created_at: "2026-08-22T00:00:00.000Z",
  updated_at: "2026-08-22T00:00:00.000Z",
  archived: 0,
  position: 1,
  archived_at: null,
  ended_at: null,
  archived_operation_id: null,
  ended_operation_id: null,
};
const interview = {
  id: "interview_contract",
  job_id: job.id,
  round_name: "Round 1",
  interview_type: "Video",
  scheduled_at: "2026-08-23T00:00:00.000Z",
  duration: 45,
  interviewer: "Interviewer",
  meeting_url: "",
  status: "scheduled",
  summary: "",
  raw_notes: "",
  questions_json: "[]",
  reflection: "",
  created_at: "2026-08-22T00:00:00.000Z",
  updated_at: "2026-08-22T00:00:00.000Z",
  canceled_at: null,
  cancellation_reason: null,
  lifecycle_previous_status: null,
  lifecycle_operation_id: null,
};

function expectedSet(overrides = {}) {
  return {
    generationId: "legacy",
    generationSequence: 7,
    stages: [clone(stage)],
    jobs: [clone(job)],
    interviews: [clone(interview)],
    ...overrides,
  };
}

function stageRenameReceipt(nextName = "Renamed") {
  const beforeStage = clone(stage);
  const afterStage = { ...clone(stage), name: nextName };
  return {
    purpose: "career-core-write",
    version: 1,
    kind: "stage-rename",
    operationId: "career-core-operation-stage-contract",
    generationId: "legacy",
    generationSequence: 7,
    operationAt: "2026-08-22T03:04:05.000Z",
    before: {
      generationId: "legacy",
      generationSequence: 7,
      stage: beforeStage,
    },
    after: {
      generationId: "legacy",
      generationSequence: 7,
      stage: afterStage,
    },
    projectionSha256: "0".repeat(64),
  };
}

function jobUpdateReceipt() {
  const nextJob = {
    ...clone(job),
    role: "Updated role",
    updated_at: "2026-08-22T03:04:05.000Z",
  };
  return {
    purpose: "career-core-write",
    version: 1,
    kind: "job-update",
    operationId: "career-core-operation-job-update-contract",
    generationId: "legacy",
    generationSequence: 7,
    operationAt: "2026-08-22T03:04:05.000Z",
    before: {
      generationId: "legacy",
      generationSequence: 7,
      stage: clone(stage),
      job: clone(job),
    },
    after: {
      generationId: "legacy",
      generationSequence: 7,
      stage: clone(stage),
      job: nextJob,
    },
    projectionSha256: "1".repeat(64),
  };
}

function interviewUpdateReceipt() {
  const nextInterview = {
    ...clone(interview),
    summary: "Canonical summary",
    updated_at: "2026-08-22T03:04:05.000Z",
  };
  return {
    purpose: "career-core-write",
    version: 1,
    kind: "interview-update",
    operationId: "career-core-operation-interview-update-contract",
    generationId: "legacy",
    generationSequence: 7,
    operationAt: "2026-08-22T03:04:05.000Z",
    before: {
      generationId: "legacy",
      generationSequence: 7,
      stage: clone(stage),
      job: clone(job),
      interview: clone(interview),
    },
    after: {
      generationId: "legacy",
      generationSequence: 7,
      stage: clone(stage),
      job: clone(job),
      interview: nextInterview,
    },
    projectionSha256: "2".repeat(64),
  };
}

function snapshots() {
  return {
    base: {
      stages: [clone(stage)],
      jobs: [clone(job)],
      tasks: [],
      interviews: [clone(interview)],
      contacts: [],
      materials: [],
      activities: [],
    },
    all: { jobs: [clone(job)], tasks: [], interviews: [clone(interview)] },
    scoped: { jobs: [clone(job)], tasks: [], interviews: [clone(interview)] },
  };
}

test("E1/S/E2 rejects ABA and returns only E2-bound display objects", () => {
  const view = snapshots();
  const before = expectedSet();
  const after = expectedSet();
  const bundle = state.createCareerCoreReadBundle(
    view.base,
    view.all,
    view.scoped,
    before,
    after,
  );
  assert.ok(bundle);
  assert.strictEqual(bundle.base.stages[0], after.stages[0]);
  assert.strictEqual(bundle.all.jobs[0], after.jobs[0]);
  assert.strictEqual(bundle.scoped.interviews[0], after.interviews[0]);
  assert.ok(state.getBoundCareerStageExpected(bundle.bindings, bundle.base.stages[0]));
  assert.ok(state.getBoundCareerJobExpected(bundle.bindings, bundle.all.jobs[0]));
  assert.ok(state.getBoundCareerInterviewExpected(
    bundle.bindings,
    bundle.scoped.interviews[0],
  ));
  assert.equal(state.getBoundCareerJobExpected(bundle.bindings, clone(job)), null);

  const generationChanged = expectedSet({ generationSequence: 8 });
  assert.equal(
    state.createCareerCoreReadBundle(
      view.base,
      view.all,
      view.scoped,
      before,
      generationChanged,
    ),
    null,
  );
  const rowChanged = expectedSet();
  rowChanged.jobs[0].updated_at = "2026-08-22T01:00:00.000Z";
  assert.equal(
    state.createCareerCoreReadBundle(
      view.base,
      view.all,
      view.scoped,
      before,
      rowChanged,
    ),
    null,
  );
});

test("dirty whole-bundle reads defer peer lineage but accept semantic clones and the exact own receipt", () => {
  const current = expectedSet();
  assert.equal(state.careerCoreBundleApplyDecision({
    current,
    next: clone(current),
    dirtyEditorCount: 1,
  }), "apply");

  const peer = clone(current);
  peer.jobs[0].updated_at = "2026-08-22T03:05:00.000Z";
  assert.equal(state.careerCoreBundleApplyDecision({
    current,
    next: peer,
    dirtyEditorCount: 1,
  }), "defer");

  const ownReceipt = stageRenameReceipt();
  const ownNext = clone(current);
  ownNext.stages[0] = clone(ownReceipt.after.stage);
  assert.equal(state.careerCoreBundleApplyDecision({
    current,
    next: ownNext,
    dirtyEditorCount: 1,
    committedReceipt: ownReceipt,
    committedReceiptOwned: false,
  }), "defer");
  assert.equal(state.careerCoreBundleApplyDecision({
    current,
    next: ownNext,
    dirtyEditorCount: 1,
    committedReceipt: ownReceipt,
    committedReceiptOwned: true,
  }), "apply");
  assert.equal(state.careerCoreBundleApplyDecision({
    current,
    next: peer,
    dirtyEditorCount: 1,
    committedReceipt: ownReceipt,
    committedReceiptOwned: true,
  }), "defer");
});

test("receipt-exact ownership alone authorizes dirty committed rebases", () => {
  const receipts = [
    stageRenameReceipt(),
    jobUpdateReceipt(),
    interviewUpdateReceipt(),
  ];
  const callbackless = state.createCareerCoreEditorSettlementRegistry();
  callbackless.remember(receipts[0]);
  assert.equal(callbackless.ownsExact(receipts[0]), true);
  assert.equal(callbackless.notify(receipts[0], "saved"), true);
  assert.equal(callbackless.ownsExact(receipts[0]), true);
  assert.equal(callbackless.forget(receipts[0]), true);
  for (const receipt of receipts) {
    const current = expectedSet();
    const next = state.careerCoreExpectedSetAfterReceipt(current, receipt);
    assert.ok(next);

    for (const source of ["startup-held", "peer-journal"]) {
      const unowned = state.createCareerCoreEditorSettlementRegistry();
      let callbacks = 0;
      assert.equal(unowned.ownsExact(receipt), false, source);
      assert.equal(unowned.notify(receipt, "saved"), false, source);
      assert.equal(callbacks, 0, source);
      assert.equal(state.careerCoreBundleApplyDecision({
        current,
        next,
        dirtyEditorCount: 1,
        committedReceipt: receipt,
        committedReceiptOwned: unowned.ownsExact(receipt),
      }), "defer", `${source}:${receipt.kind}`);
    }

    for (const path of ["direct", "same-page-uncertain", "missing-held"]) {
      const owned = state.createCareerCoreEditorSettlementRegistry();
      let callbacks = 0;
      owned.remember(receipt, {
        onSettled: () => { callbacks += 1; },
      });
      assert.equal(owned.ownsExact(clone(receipt)), true, `${path}:${receipt.kind}`);
      const authorityBeforeNotify = owned.ownsExact(receipt);
      assert.equal(owned.notify(receipt, "saved"), true);
      assert.equal(callbacks, 1);
      assert.equal(owned.ownsExact(receipt), true, "notify must retain rebase ownership");
      for (const retry of ["refresh-throw", "refresh-defer", "remove-stale", "remove-blocked"]) {
        assert.equal(owned.ownsExact(receipt), true, `${path}:${retry}`);
        assert.equal(state.careerCoreBundleApplyDecision({
          current,
          next,
          dirtyEditorCount: 1,
          committedReceipt: receipt,
          committedReceiptOwned: authorityBeforeNotify && owned.ownsExact(receipt),
        }), "apply", `${path}:${retry}:${receipt.kind}`);
      }
      assert.equal(owned.forget(receipt), true);
      assert.equal(owned.ownsExact(receipt), false, "successful terminal removal forgets ownership");
    }
  }
});

test("same operation id with a different receipt cannot settle or authorize", () => {
  const registry = state.createCareerCoreEditorSettlementRegistry();
  const ownedReceipt = stageRenameReceipt("Owned name");
  const collisions = [
    { ...stageRenameReceipt("Peer name"), operationId: ownedReceipt.operationId },
    { ...jobUpdateReceipt(), operationId: ownedReceipt.operationId },
    {
      ...clone(ownedReceipt),
      before: {
        ...clone(ownedReceipt.before),
        stage: { ...clone(ownedReceipt.before.stage), color: "#000000" },
      },
    },
    {
      ...clone(ownedReceipt),
      after: {
        ...clone(ownedReceipt.after),
        stage: { ...clone(ownedReceipt.after.stage), id: "stage_peer_entity" },
      },
    },
  ];
  let callbacks = 0;
  registry.remember(ownedReceipt, {
    onSettled: () => { callbacks += 1; },
  });
  for (const collision of collisions) {
    assert.equal(registry.ownsExact(collision), false);
    assert.equal(registry.notify(collision, "saved"), false);
    assert.equal(registry.forget(collision), false);
  }
  assert.equal(callbacks, 0);
  assert.equal(registry.ownsExact(ownedReceipt), true);

  const current = expectedSet();
  const collision = collisions[0];
  const collisionNext = state.careerCoreExpectedSetAfterReceipt(current, collision);
  assert.ok(collisionNext);
  assert.equal(state.careerCoreBundleApplyDecision({
    current,
    next: collisionNext,
    dirtyEditorCount: 1,
    committedReceipt: collision,
    committedReceiptOwned: registry.ownsExact(collision),
  }), "defer");
});

test("claimed UI failures always restore a non-working phase and release their claim", async () => {
  for (const source of ["lock", "storage", "inspect"]) {
    const trace = [];
    const result = await state.runCareerCoreClaimedUiAction(
      async () => {
        trace.push(`start:${source}`);
        throw new Error(source);
      },
      (reason) => trace.push(`recover:${reason.message}`),
      () => trace.push("release"),
    );
    assert.equal(result, undefined);
    assert.deepEqual(trace, [
      `start:${source}`,
      `recover:${source}`,
      "release",
    ]);
  }
  assert.match(flowSource, /inspectActive[\s\S]*?runCareerCoreClaimedUiAction[\s\S]*?restoreLatestFlowOrIdle/);
  assert.match(flowSource, /discardTerminal[\s\S]*?runCareerCoreClaimedUiAction[\s\S]*?restoreLatestFlowOrIdle/);
});

test("operation-bound settlement closes one recovered create and rebases one recovered update", () => {
  const registry = state.createCareerCoreEditorSettlementRegistry();
  const create = {
    ...stageRenameReceipt(),
    kind: "job-create",
    operationId: "career-core-operation-create-contract",
    after: { job: { id: "job_created_once" } },
  };
  let prepared = 0;
  const createdIds = [];
  let backendCreates = 1;
  registry.remember(create, {
    onPrepared: () => { prepared += 1; },
    onSettled: ({ outcome, receipt: settled }) => {
      if (outcome === "saved") createdIds.push(settled.after.job.id);
    },
  });
  registry.notify(create, "saved");
  registry.notify(create, "saved");
  assert.equal(prepared, 1);
  assert.equal(backendCreates, 1);
  assert.deepEqual(createdIds, ["job_created_once"]);

  const update = {
    ...stageRenameReceipt(),
    kind: "interview-update",
    operationId: "career-core-operation-update-contract",
    after: { interview: { id: "interview_contract", summary: "canonical" } },
  };
  let baseline = "old";
  registry.remember(update, {
    onSettled: ({ outcome, receipt: settled }) => {
      if (outcome === "saved") baseline = settled.after.interview.summary;
    },
  });
  registry.notify(update, "saved");
  assert.equal(baseline, "canonical");
});

test("changed settlement preserves input until explicit abandonment", () => {
  const registry = state.createCareerCoreEditorSettlementRegistry();
  const changed = stageRenameReceipt("Peer name");
  let input = "my old input";
  let changedNotices = 0;
  let abandoned = 0;
  registry.remember(changed, {
    onSettled: ({ outcome }) => {
      if (outcome === "changed") changedNotices += 1;
    },
    onAbandonChanged: () => {
      abandoned += 1;
      input = "peer input";
    },
  });
  registry.notify(changed, "changed");
  registry.notify(changed, "changed");
  assert.equal(input, "my old input");
  assert.equal(changedNotices, 1);
  registry.abandonChanged(changed);
  registry.forget(changed);
  assert.equal(input, "peer input");
  assert.equal(abandoned, 1);
});

test("generation broadcast marks stale before a canceled reload can reach any mutation", () => {
  let stale = false;
  let reloads = 0;
  state.careerCoreGenerationChangeBarrier(
    () => { stale = true; },
    () => { reloads += 1; },
  );
  const calls = {
    core: 0,
    lifecycle: 0,
    task: 0,
    contact: 0,
    material: 0,
    import: 0,
  };
  for (const name of Object.keys(calls)) {
    if (!stale) calls[name] += 1;
  }
  assert.equal(reloads, 1);
  assert.equal(stale, true);
  assert.deepEqual(calls, {
    core: 0,
    lifecycle: 0,
    task: 0,
    contact: 0,
    material: 0,
    import: 0,
  });
  assert.match(appSource, /subscribeToCareerGenerationChanges\(\(\) =>[\s\S]*?coreSnapshotStaleRef\.current = true[\s\S]*?window\.location\.reload\(\)/);
});

test("external mutation claims close the reverse core gate in the same tick", () => {
  const gate = state.createCareerDatabaseMutationRegistry();
  const contact = gate.tryClaim("contact");
  assert.ok(contact);
  assert.equal(gate.isActiveExcept("core"), true);
  assert.equal(gate.tryClaim("task"), null);
  assert.equal(gate.release(contact), true);
  assert.equal(gate.isActive(), false);

  const getter = appSource.slice(
    appSource.indexOf("const coreExternalWriteInProgress"),
    appSource.indexOf("const refreshCoreAfterReceipt"),
  );
  assert.match(getter, /databaseMutationRegistryRef\.current\.isActiveExcept\("core"\)/);
  assert.doesNotMatch(getter, /modal ===|contactEditorId|selectedContactId|taskSheet/);
  for (const functionName of ["TaskDetailSheet"]) {
    const start = appSource.indexOf(`function ${functionName}`);
    const next = appSource.indexOf("\nfunction ", start + 1);
    const component = appSource.slice(start, next < 0 ? appSource.length : next);
    assert.match(component, /onExternalMutationChange\(true\)[\s\S]*?await/);
    assert.match(component, /onExternalMutationChange\(false\)/);
  }
  for (const functionName of [
    "ContactDrawer",
    "ContactModal",
    "ContactInteractionModal",
    "ContactTaskModal",
    "MaterialModal",
    "MaterialDeletionModal",
    "CareerImportModal",
  ]) {
    const start = appSource.indexOf(`function ${functionName}`);
    const next = appSource.indexOf("\nfunction ", start + 1);
    const component = appSource.slice(start, next < 0 ? appSource.length : next);
    assert.match(component, /writes\.submit(?:Contact|Import|Material)/);
    assert.doesNotMatch(component, /onExternalMutationChange\(true\)/);
  }
});

test("history guards distinguish durable tickets, dirty input, volatile work, and resolved risk", () => {
  assert.equal(state.careerCoreHistoryBackDecision(false, 0), "continue");
  assert.equal(state.careerCoreHistoryBackDecision(false, 1), "restore-confirm");
  assert.equal(state.careerCoreHistoryBackDecision(true, 0), "restore-block");
  assert.equal(state.careerCoreHistoryGuardResolution(false, false), "none");
  assert.equal(state.careerCoreHistoryGuardResolution(true, true), "keep");
  assert.equal(state.careerCoreHistoryGuardResolution(false, true), "consume");
  assert.match(appSource, /window\.history\.pushState/);
  assert.match(appSource, /window\.addEventListener\("popstate", onPopState\)/);
  assert.match(appSource, /careerCoreHistoryGuardResolution[\s\S]*?window\.history\.back\(\)/);
  assert.match(appSource, /dismissible=\{false\}[\s\S]*?career-history-exit/);
  assert.match(appSource, /historyExitOpenerRef[\s\S]*?focus\(\{ preventScroll: true \}\)/);
});

test("core editors freeze controls for the full operation and bind recovery to their operation id", () => {
  assert.ok((appSource.match(/<fieldset className="career-core-write-fields" disabled=\{saving \|\| Boolean\(activeCoreOperationId\)\}/g) ?? []).length >= 4);
  assert.match(appSource, /onPrepared:[\s\S]*?onSettled:[\s\S]*?onAbandonChanged:/);
  assert.match(flowSource, /discardChangedAndRefresh/);
  assert.match(flowSource, /settlementRef\.current\.remember/);
  const finish = flowSource.slice(
    flowSource.indexOf("const finishTerminal = useCallback"),
    flowSource.indexOf("const inspectWithLease = useCallback"),
  );
  assert.ok(finish.indexOf("ownsSettlement(receipt)") <
    finish.indexOf('notifySettlement(receipt, "saved")'));
  assert.ok(finish.indexOf('notifySettlement(receipt, "saved")') <
    finish.indexOf("await refresh(receipt, reason, ownedCommittedReceipt)"));
  assert.ok(finish.indexOf("await removeCurrent(entry)") <
    finish.indexOf("forgetSettlement(receipt)"));
  assert.match(appSource, /careerCoreBundleApplyDecision\(\{[\s\S]*?committedReceipt,[\s\S]*?committedReceiptOwned,/);
});

test("all-scope core rows are complete while scoped rows may be subsets", () => {
  const view = snapshots();
  const before = expectedSet();
  const after = expectedSet();
  const subset = state.createCareerCoreReadBundle(
    view.base,
    view.all,
    { ...view.scoped, jobs: [], interviews: [] },
    before,
    after,
  );
  assert.ok(subset);
  assert.deepEqual(subset.scoped.jobs, []);
  assert.equal(
    state.createCareerCoreReadBundle(
      view.base,
      { ...view.all, jobs: [] },
      view.scoped,
      before,
      after,
    ),
    null,
  );
  assert.equal(
    state.createCareerCoreReadBundle(
      { ...view.base, stages: [clone(stage), clone(stage)] },
      view.all,
      view.scoped,
      before,
      after,
    ),
    null,
  );
});

function expectedInterviewState() {
  return {
    generationId: "legacy",
    generationSequence: 7,
    interview: clone(interview),
    job: clone(job),
    stage: clone(stage),
  };
}

function editorSnapshot() {
  return {
    status: "scheduled",
    summary: "Summary",
    rawNotes: "Notes",
    questions: [{ question: "Q", answer: "A", note: "N" }],
    reflection: "Reflection",
  };
}

test("draft v2 strictly parses complete provenance and legacy v1 only migrates", () => {
  const source = expectedInterviewState();
  const draft = {
    version: 2,
    interviewId: interview.id,
    source,
    savedAt: "2026-08-22T03:04:05.000Z",
    snapshot: editorSnapshot(),
  };
  assert.deepEqual(
    state.parseCareerInterviewLocalDraft(clone(draft), interview.id),
    draft,
  );
  assert.equal(state.careerInterviewDraftRestoreMode(draft, source), "auto");
  const current = expectedInterviewState();
  current.job.updated_at = "2026-08-22T02:00:00.000Z";
  assert.equal(state.careerInterviewDraftRestoreMode(draft, current), "confirm");
  const widened = clone(draft);
  widened.source.interview.extra = true;
  assert.equal(
    state.parseCareerInterviewLocalDraft(widened, interview.id),
    null,
  );
  const legacy = {
    version: 1,
    interviewId: interview.id,
    sourceUpdatedAt: interview.updated_at,
    savedAt: draft.savedAt,
    snapshot: editorSnapshot(),
  };
  assert.deepEqual(
    state.parseCareerInterviewLocalDraft(clone(legacy), interview.id),
    legacy,
  );
  assert.equal(
    state.parseCareerInterviewLocalDraft({ ...legacy, source: {} }, interview.id),
    null,
  );
});

test("preflight, unload, and external database gates fail closed independently", () => {
  const open = {
    journalLoaded: true,
    storageUnavailable: false,
    lockUnavailable: false,
    unreadableCount: 0,
    entryCount: 0,
    hasHeldReceipt: false,
    operationInProgress: false,
    snapshotStale: false,
    externalWriteLocked: false,
  };
  assert.equal(state.careerCoreWritePreflightOpen(open), true);
  for (const patch of [
    { journalLoaded: false },
    { storageUnavailable: true },
    { lockUnavailable: true },
    { unreadableCount: 1 },
    { entryCount: 1 },
    { hasHeldReceipt: true },
    { operationInProgress: true },
    { snapshotStale: true },
    { externalWriteLocked: true },
  ]) assert.equal(state.careerCoreWritePreflightOpen({ ...open, ...patch }), false);
  assert.equal(state.careerCoreUnloadRisk({
    operationInProgress: false,
    dirtyEditorCount: 0,
    volatileHeldReceipt: false,
  }), false);
  assert.equal(state.careerCoreUnloadRisk({
    operationInProgress: false,
    dirtyEditorCount: 1,
    volatileHeldReceipt: false,
  }), true);
  assert.equal(state.careerCoreBackupGate({
    busy: false,
    hasHeldReceipt: false,
    journalLoaded: true,
    storageUnavailable: false,
    lockUnavailable: false,
    unreadableCount: 0,
    entryCount: 0,
    snapshotStale: false,
  }), false);
  assert.equal(state.careerCoreBackupGate({
    busy: false,
    hasHeldReceipt: false,
    journalLoaded: true,
    storageUnavailable: false,
    lockUnavailable: false,
    unreadableCount: 0,
    entryCount: 1,
    snapshotStale: false,
  }), true);
});

test("UI read and five writes use authoritative bindings with no raw SQL mutation", () => {
  const read = appSource.slice(
    appSource.indexOf("async function loadCareerUiState"),
    appSource.indexOf("export function resolveCareerTodayFocus"),
  );
  const e1 = read.indexOf("loadCareerCoreWriteExpectedSet()");
  const s = read.indexOf("await Promise.all");
  const e2 = read.lastIndexOf("loadCareerCoreWriteExpectedSet()");
  assert.ok(e1 >= 0 && s > e1 && e2 > s);
  assert.match(read, /createCareerCoreReadBundle/);
  assert.doesNotMatch(appSource, /\brunCareer(?:Sql|Batch)\s*\(/);
  for (const method of [
    "submitStageRename",
    "submitJobCreate",
    "submitJobUpdate",
    "submitInterviewCreate",
    "submitInterviewUpdate",
  ]) assert.match(appSource, new RegExp(`coreWrites\\.${method}\\(`));
  for (const getter of [
    "getBoundCareerStageExpected",
    "getBoundCareerJobExpected",
    "getBoundCareerInterviewExpected",
  ]) assert.match(appSource, new RegExp(`${getter}\\(coreBindings,`));
});

test("prepare is durable before commit and the lease repeats the same-tick gate", () => {
  const start = flowSource.slice(
    flowSource.indexOf("const startPrepared = useCallback"),
    flowSource.indexOf("const submitStageRename"),
  );
  assert.ok(start.indexOf("if (externalBlockedNow()") <
    start.indexOf("const receipt = await prepare()"));
  assert.match(
    start,
    /const receipt = await prepare\(\);[\s\S]*?if \(externalBlockedNow\(\)/,
  );
  assert.ok(start.indexOf("holdEntry(held)") <
    start.indexOf("await persistCareerCoreWrite"));
  assert.ok(start.indexOf("rememberSettlement(receipt, lifecycle)") <
    start.indexOf("holdEntry(held)"));
  assert.ok(start.indexOf("await persistCareerCoreWrite") <
    start.indexOf("commitEntry(durable)"));
  assert.match(
    start,
    /await persistCareerCoreWrite\(held\.ticket\);[\s\S]*?if \(externalBlockedNow\(\)/,
  );

  const commit = flowSource.slice(
    flowSource.indexOf("const commitEntry = useCallback"),
    flowSource.indexOf("const startPrepared = useCallback"),
  );
  assert.match(commit, /runWithCurrentCareerCoreWrite/);
  assert.ok(commit.indexOf("if (externalBlockedNow()") <
    commit.indexOf("await commitCareerCoreWrite(receipt)"));
  assert.ok(commit.indexOf("lease.committed()") < commit.indexOf('return "saved"'));
  assert.ok(commit.indexOf("lease.changed()") < commit.indexOf('return "changed"'));
});

test("uncertainty is inspect-only; terminal refresh precedes raw-CAS removal", () => {
  const inspect = flowSource.slice(
    flowSource.indexOf("const inspectWithLease = useCallback"),
    flowSource.indexOf("const commitEntry = useCallback"),
  );
  assert.match(inspect, /await inspectCareerCoreWrite/);
  assert.doesNotMatch(inspect, /commitCareerCoreWrite|prepareCareer/);
  const finish = flowSource.slice(
    flowSource.indexOf("const finishTerminal = useCallback"),
    flowSource.indexOf("const inspectWithLease = useCallback"),
  );
  assert.ok(finish.indexOf("await refresh(receipt, reason, ownedCommittedReceipt)") <
    finish.indexOf("await removeCurrent(entry)"));
  assert.ok(finish.indexOf("await removeCurrent(entry)") <
    finish.indexOf("onToast(message)"));
  assert.match(flowSource, /资料已在别处变化；旧输入没有覆盖当前内容/);
  const discard = flowSource.slice(
    flowSource.indexOf("const discardTerminal = useCallback"),
    flowSource.indexOf("const retryTerminalRefresh = useCallback"),
  );
  assert.ok(discard.indexOf('removal === "ran"') <
    discard.indexOf('notifySettlement(flow.entry.ticket.receipt, "discarded")'));
  assert.ok(discard.indexOf('notifySettlement(flow.entry.ticket.receipt, "discarded")') <
    discard.indexOf("forgetSettlement(flow.entry.ticket.receipt)"));
  assert.ok((appSource.match(/result\.outcome === "changed"/g) ?? []).length >= 5);
});

test("lifecycle collisions close both ways while recovery-only paths stay reachable", () => {
  const lifecycle = appSource.slice(appSource.indexOf("async function requestLifecycleChange"));
  assert.ok(lifecycle.indexOf("lifecycleWriteRef.current = true") <
    lifecycle.indexOf("await lifecycleTaskWrites.previewLifecycle("));
  assert.match(lifecycle, /finishPreparedLifecycle/);
  assert.match(appSource, /databaseMutationRegistryRef\.current\.isActiveExcept\(owner\)/);

  const prepareBackup = appSource.slice(
    appSource.indexOf("async function prepareSelectedBackup"),
    appSource.indexOf("function stopBackupPreparation"),
  );
  assert.match(prepareBackup, /newDatabaseWritesLockedNow\(\)/);
  const activateBackup = appSource.slice(
    appSource.indexOf("async function activateCandidate"),
    appSource.indexOf("async function discardCandidate"),
  );
  assert.match(activateBackup, /newDatabaseWritesLockedNow\(\)/);
  const discardBackup = appSource.slice(
    appSource.indexOf("async function discardCandidate"),
    appSource.indexOf("async function retryPrepareCleanup"),
  );
  assert.match(discardBackup, /onExternalMutationChange\(true\)/);

  const materialDelete = appSource.slice(
    appSource.indexOf("async function performDeletion"),
    appSource.indexOf("type CareerImportMode"),
  );
  assert.match(materialDelete, /if \(newWritesBlockedNow\(\)\)/);
  assert.match(materialDelete, /writes\.submitMaterialDelete/);
  assert.doesNotMatch(materialDelete, /onExternalMutationChange\(true\)/);
});

test("dirty and volatile exit protection plus 319px recovery controls remain operable", () => {
  assert.match(flowSource, /dirtyEditorCount: dirtyEditorCountRef\.current/);
  assert.match(flowSource, /volatileHeldReceipt: barrier\.volatile/);
  assert.doesNotMatch(
    flowSource.slice(
      flowSource.indexOf("function protect(event: BeforeUnloadEvent)"),
      flowSource.indexOf('window.addEventListener("beforeunload", protect)'),
    ),
    /journal\.entries\.length/,
  );
  assert.match(appSource, /setStageDraftDirty\(stage\.id,/);
  assert.match(appSource, /career\.interview-draft\.v2:/);
  assert.match(appSource, /source: expectedInterview/);
  assert.match(css, /\.career-core-stale,[\s\S]*?grid-template-columns: auto minmax\(0, 1fr\) auto/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.career-core-recovery/);
  assert.match(css, /\.career-core-recovery > footer \.career-button[\s\S]*?width: 100%/);
  assert.match(css, /\.career-core-recovery \.career-button \{ min-height: 44px; \}/);
  assert.match(css, /\.career-stage-settings input,[\s\S]*?\.career-settings-card#capture > \.career-button \{[\s\S]*?min-height: 44px;/);
  assert.match(css, /\.career-stage-settings input \{[\s\S]*?width: 100%;[\s\S]*?min-width: 0;/);
});
