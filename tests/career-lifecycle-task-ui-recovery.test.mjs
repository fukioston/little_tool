import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const root = new URL("../", import.meta.url);
const [stateSource, journalSource, flowSource, coreJournalSource, coreFlowSource, appSource, css] =
  await Promise.all([
    readFile(new URL("app/career/core-write-state.ts", root), "utf8"),
    readFile(new URL("app/career/lifecycle-task-write-journal.ts", root), "utf8"),
    readFile(new URL("app/career/CareerLifecycleTaskWriteFlow.tsx", root), "utf8"),
    readFile(new URL("app/career/core-write-journal.ts", root), "utf8"),
    readFile(new URL("app/career/CareerCoreWriteFlow.tsx", root), "utf8"),
    readFile(new URL("app/career/CareerApp.tsx", root), "utf8"),
    readFile(new URL("app/career/career.css", root), "utf8"),
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

const stateJavaScript = transpile(stateSource, "core-write-state.ts");
assert.doesNotMatch(stateJavaScript, /^import /m);
const state = await import(
  `data:text/javascript;base64,${Buffer.from(stateJavaScript).toString("base64")}`
);

let journalJavaScript = transpile(journalSource, "lifecycle-task-write-journal.ts");
journalJavaScript = journalJavaScript
  .replace(
    /import \{ isCareerLifecycleWriteReceipt, \} from "@\/lib\/career\/lifecycle-writes";/,
    'const isCareerLifecycleWriteReceipt = (value) => value?.purpose === "career-lifecycle-write" && typeof value.operationId === "string";',
  )
  .replace(
    /import \{ isCareerTaskWriteReceipt, \} from "@\/lib\/career\/task-writes";/,
    'const isCareerTaskWriteReceipt = (value) => value?.purpose === "career-task-write" && typeof value.operationId === "string";',
  )
  .replace(
    /import \{ CAREER_CORE_WRITE_JOURNAL_LOCK, CAREER_CORE_WRITE_MAX_CHARS, CAREER_CORE_WRITE_PREFIX, CAREER_LIFECYCLE_TASK_WRITE_MAX_BYTES, CAREER_LIFECYCLE_TASK_WRITE_PREFIX, \} from "\.\/core-write-journal";/,
    'const CAREER_CORE_WRITE_JOURNAL_LOCK="private-ai-suite:career:core-write-journal", CAREER_CORE_WRITE_MAX_CHARS=1048576, CAREER_CORE_WRITE_PREFIX="career.core-write.v1:", CAREER_LIFECYCLE_TASK_WRITE_MAX_BYTES=8388608, CAREER_LIFECYCLE_TASK_WRITE_PREFIX="career.lifecycle-task-write.v1:";',
  );
assert.doesNotMatch(journalJavaScript, /^import /m);
const journal = await import(
  `data:text/javascript;base64,${Buffer.from(journalJavaScript).toString("base64")}`
);

function memoryStorage(initial = []) {
  const values = new Map(initial);
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}

function locks() {
  return { request(_name, operation) { return operation(); } };
}

function taskReceipt(operationId = "career-task-write-contract-a") {
  return { purpose: "career-task-write", operationId };
}

test("seven mutation owners are pairwise exclusive and release only exact tokens", () => {
  const owners = [...state.CAREER_DATABASE_MUTATION_OWNERS];
  assert.deepEqual(owners, [
    "core", "lifecycle", "task", "backup", "contact", "import", "material",
  ]);
  for (const first of owners) {
    for (const second of owners) {
      const registry = state.createCareerDatabaseMutationRegistry();
      const token = registry.tryClaim(first);
      assert.ok(token, `${first} should claim an empty registry`);
      assert.equal(registry.tryClaim(second), null, `${first} must exclude ${second}`);
      assert.equal(registry.isActiveExcept(first), false);
      if (second !== first) assert.equal(registry.isActiveExcept(second), true);
      assert.equal(registry.release({ owner: first, nonce: Symbol("stale") }), false);
      assert.equal(registry.isOwned(token), true);
      assert.equal(registry.release(token), true);
      assert.equal(registry.isActive(), false);
    }
  }

  const registry = state.createCareerDatabaseMutationRegistry();
  const old = registry.tryClaim("core");
  assert.ok(old);
  assert.equal(registry.release(old), true);
  const fresh = registry.tryClaim("core");
  assert.ok(fresh);
  assert.equal(registry.release(old), false);
  assert.equal(registry.isOwned(fresh), true);
});

test("all 49 ordered owner pairs block a recovery mutation before its first await", () => {
  const owners = [...state.CAREER_DATABASE_MUTATION_OWNERS];
  let attempts = 0;
  for (const activeOwner of owners) {
    for (const recoveryOwner of owners) {
      const registry = state.createCareerDatabaseMutationRegistry();
      const active = registry.tryClaim(activeOwner);
      assert.ok(active);
      attempts += 1;
      assert.equal(
        registry.tryClaim(recoveryOwner),
        null,
        `${activeOwner} must block ${recoveryOwner} recovery mutation`,
      );
      assert.equal(registry.isOwned(active), true);
      assert.equal(registry.release(active), true);
    }
  }
  assert.equal(attempts, 49);
});

test("pure receipt inspection stays reachable under each active owner", () => {
  const inspections = [];
  for (const owner of state.CAREER_DATABASE_MUTATION_OWNERS) {
    const registry = state.createCareerDatabaseMutationRegistry();
    const active = registry.tryClaim(owner);
    assert.ok(active);
    inspections.push(owner);
    assert.equal(registry.isActive(), true);
    assert.equal(registry.isOwned(active), true);
    assert.equal(registry.release(active), true);
  }
  assert.deepEqual(inspections, [...state.CAREER_DATABASE_MUTATION_OWNERS]);
});

test("lifecycle preview releases its owner and every confirmation claims afresh", async () => {
  const previewBlock = flowSource.slice(
    flowSource.indexOf("const previewLifecycle = useCallback"),
    flowSource.indexOf("const cancelLifecyclePreview = useCallback"),
  );
  const submitBlock = flowSource.slice(
    flowSource.indexOf("const submitLifecycle = useCallback"),
    flowSource.indexOf("const runTaskPrepare = useCallback"),
  );
  assert.match(previewBlock, /finally[\s\S]*?releaseDatabaseMutation\(token\)/);
  assert.doesNotMatch(flowSource, /lifecycleTokenRef/);
  assert.ok(submitBlock.indexOf('claimDatabaseMutation("lifecycle")') <
    submitBlock.indexOf("prepareCareerLifecycleWrite(preview, choice)"));
  assert.match(submitBlock, /prepared\.outcome === "changed"[\s\S]*?keepPreview = true/);

  const registry = state.createCareerDatabaseMutationRegistry();
  let authorizedPreview = "preview-a";
  let prepareCalls = 0;
  let commitCalls = 0;
  const previewOwner = registry.tryClaim("lifecycle");
  assert.ok(previewOwner);
  assert.equal(registry.release(previewOwner), true);
  assert.equal(registry.isActive(), false, "reading a preview must not lock the modal wait");

  async function confirm(preview, outcome) {
    if (preview !== authorizedPreview) return "invalid-preview";
    const token = registry.tryClaim("lifecycle");
    if (!token) return "blocked";
    try {
      prepareCalls += 1;
      await Promise.resolve();
      if (outcome === "changed") {
        authorizedPreview = "preview-b";
        return "changed";
      }
      commitCalls += 1;
      return "saved";
    } finally {
      registry.release(token);
    }
  }

  const peer = registry.tryClaim("contact");
  assert.ok(peer);
  assert.equal(await confirm("preview-a", "changed"), "blocked");
  assert.equal(prepareCalls, 0, "a peer owner must block before the backend call");
  assert.equal(commitCalls, 0);
  assert.equal(registry.release(peer), true);
  assert.equal(await confirm("preview-a", "changed"), "changed");
  assert.equal(registry.isActive(), false);
  assert.equal(await confirm("preview-b", "saved"), "saved");
  assert.equal(prepareCalls, 2);
  assert.equal(commitCalls, 1);
  assert.equal(registry.isActive(), false);
});

test("closing a lifecycle decision cannot hide durable recovery truth", () => {
  const empty = {
    heldReceiptCount: 0,
    journalEntryCount: 0,
    peerEntryCount: 0,
    unreadableCount: 0,
    storageUnavailable: false,
    lockUnavailable: false,
  };
  assert.equal(state.careerLifecycleTaskRecoveryAttention(empty), false);
  for (const scenario of [
    { ...empty, heldReceiptCount: 1 },
    { ...empty, peerEntryCount: 1 },
    { ...empty, journalEntryCount: 1 },
    { ...empty, unreadableCount: 1 },
    { ...empty, storageUnavailable: true },
    { ...empty, lockUnavailable: true },
  ]) {
    assert.equal(state.careerLifecycleTaskRecoveryAttention(scenario), true);
  }

  const cancelBlock = flowSource.slice(
    flowSource.indexOf("const cancelLifecyclePreview = useCallback"),
    flowSource.indexOf("const submitLifecycle = useCallback"),
  );
  assert.doesNotMatch(cancelBlock, /setFlow\(/);
  assert.match(cancelBlock, /if \(!hasDurableTruth\) setError\(""\)/);
  assert.match(appSource, /lifecycleTaskWrites\.hasRecoveryAttention\) && <div/);
  assert.match(appSource, /const focusRecovery = lifecycleTaskWrites\.hasRecoveryAttention/);
  assert.match(appSource, /lifecycleTaskWrites\.attentionRef\.current\?\.focus/);
  assert.match(flowSource, /pendingAttentionFocusRef[\s\S]*?new MutationObserver\(focusWhenClear\)/);
});

test("both durable journals share one lock and scan both prefixes before callbacks", () => {
  assert.match(journalSource, /CAREER_CORE_WRITE_JOURNAL_LOCK/);
  assert.match(journalSource, /CAREER_CORE_WRITE_PREFIX/);
  assert.match(journalSource, /CAREER_LIFECYCLE_TASK_WRITE_PREFIX/);
  assert.match(coreJournalSource, /8 \* 1024 \* 1024/);
  assert.match(journalSource, /UTF8_ENCODER\.encode\(value\)\.byteLength/);
  assert.match(journalSource, /exact\.raw !== entry\.raw \|\| rawNow !== entry\.raw/);
  assert.match(journalSource, /journal\.entries\.length !== 1 \|\| journal\.peerEntries\.length > 0/);
  assert.match(journalSource, /if \(!locks\)[\s\S]*?没有继续写入/);

  assert.match(coreJournalSource, /CAREER_LIFECYCLE_TASK_WRITE_PREFIX/);
  assert.match(coreJournalSource, /journal\.peerEntries\.length > 0/);
  assert.match(coreFlowSource, /event\.key\.startsWith\(CAREER_LIFECYCLE_TASK_WRITE_PREFIX\)/);
});

test("new journal runs callbacks only for the exact sole raw target", async () => {
  const ticket = journal.createCareerLifecycleTaskWriteTicket(
    taskReceipt(),
    "2026-08-22T03:04:05.000Z",
  );
  const entry = journal.createCareerLifecycleTaskWriteEntry(ticket);
  const storage = memoryStorage();
  const lockManager = locks();
  await journal.persistCareerLifecycleTaskWrite(ticket, { storage, locks: lockManager });
  let callbacks = 0;
  const ran = await journal.runWithCurrentCareerLifecycleTaskWrite(
    entry,
    (lease) => { callbacks += 1; lease.committed(); return "ok"; },
    { storage, locks: lockManager },
  );
  assert.equal(ran.outcome, "ran");
  assert.equal(callbacks, 1);

  const current = journal.readCareerLifecycleTaskWriteJournal(storage, lockManager).entries[0];
  const stale = await journal.runWithCurrentCareerLifecycleTaskWrite(
    entry,
    () => { callbacks += 1; },
    { storage, locks: lockManager },
  );
  assert.equal(stale.outcome, "stale");
  assert.equal(callbacks, 1);
  assert.equal(current.ticket.kind, "committed");

  const peerStorage = memoryStorage([["career.core-write.v1:peer", "{}"]]);
  await assert.rejects(
    journal.persistCareerLifecycleTaskWrite(ticket, { storage: peerStorage, locks: lockManager }),
    /上一条职迹核对线索/,
  );
  await assert.rejects(
    journal.persistCareerLifecycleTaskWrite(ticket, { storage: memoryStorage(), locks: null }),
    /无法跨页面锁定/,
  );
});

test("lifecycle preview and task writes bind displayed full facts before prepare", () => {
  assert.match(flowSource, /previewCareerLifecycleWrite\(intent, displayed\)/);
  assert.match(flowSource, /prepareCareerLifecycleWrite\(preview, choice\)/);
  assert.match(flowSource, /createCareerLifecycleTaskWriteEntry[\s\S]*?persistCareerLifecycleTaskWrite[\s\S]*?commitEntry/);
  assert.match(flowSource, /prepareCareerTaskCreate\(input, expected\)/);
  assert.match(flowSource, /prepareCareerTaskComplete\(expected\)/);
  assert.match(appSource, /task: displayed/);
  assert.match(appSource, /job: bound\.job,[\s\S]*?stage,/);
  assert.match(appSource, /currentStage,[\s\S]*?nextStage,/);
  assert.doesNotMatch(appSource, /prepareCareerLifecycleChange\(|commitPreparedCareerLifecycleChange\(/);
  assert.doesNotMatch(appSource, /careerTaskActions\.create\(/);
  assert.doesNotMatch(appSource, /careerTaskActions\.complete\(/);
});

test("quota failures stay held and recovery actions separate inspect from commit", () => {
  assert.ok(flowSource.indexOf("hold(held)") <
    flowSource.indexOf("await persistCareerLifecycleTaskWrite(held.ticket)"));
  assert.match(flowSource, /message: "收据暂时只保留在本页/);
  assert.match(flowSource, /heldBarrier\.volatile|barrier\.volatile/);
  assert.match(flowSource, /inspectCareerLifecycleWrite/);
  assert.match(flowSource, /inspectCareerTaskWrite/);
  const inspect = flowSource.slice(
    flowSource.indexOf("const inspectEntry = useCallback"),
    flowSource.indexOf("const commitEntry = useCallback"),
  );
  assert.doesNotMatch(inspect, /commitCareerLifecycleWrite|commitCareerTaskWrite/);
  assert.match(flowSource, /flow\.phase !== "expected"[\s\S]*?claimDatabaseMutation\(owner\)/);
});

test("owner claims cover legacy recovery mutations while pure inspections stay reachable", () => {
  for (const mutation of [
    "exportBackup", "recoverPreparation", "prepareSelectedBackup",
    "activateCandidate", "discardCandidate", "cleanPreparedAttachments",
    "finishMutation",
  ]) {
    const start = appSource.indexOf(`function ${mutation}`) >= 0
      ? appSource.indexOf(`function ${mutation}`)
      : appSource.indexOf(`async function ${mutation}`);
    assert.notEqual(start, -1, mutation);
    const next = appSource.indexOf("\n  async function ", start + 1);
    const block = appSource.slice(start, next < 0 ? start + 12_000 : next);
    assert.match(block, /claimDatabaseMutation\(|onExternalMutationChange\(true\)/, mutation);
  }
  for (const mutation of [
    "performDeletion", "commitPreview", "handleContactUndo", "changeArchive",
  ]) {
    const start = appSource.indexOf(`function ${mutation}`) >= 0
      ? appSource.indexOf(`function ${mutation}`)
      : appSource.indexOf(`async function ${mutation}`);
    assert.notEqual(start, -1, mutation);
    const next = appSource.indexOf("\n  async function ", start + 1);
    const block = appSource.slice(start, next < 0 ? start + 12_000 : next);
    assert.match(block, /submit(?:Contact|Import|Material)/, mutation);
    assert.doesNotMatch(block, /onExternalMutationChange\(true\)/, mutation);
  }
  const inspectCandidate = appSource.slice(
    appSource.indexOf("async function inspectCandidate"),
    appSource.indexOf("async function recoverPreparation"),
  );
  assert.doesNotMatch(inspectCandidate, /onExternalMutationChange\(true\)|claimDatabaseMutation\(/);
  assert.match(appSource, /contactImportMaterialWrites\.inspectActive\(\)/);
});

test("broadcast, focus, exit guards, recovery focus and 319px controls close the loop", () => {
  assert.match(appSource, /job-\(\?:stage-transitioned\|archived\|restored\)/);
  assert.match(appSource, /task-\(\?:created\|completed\)/);
  assert.match(appSource, /recheckCareerTruthOnFocus/);
  assert.match(appSource, /hasCareerVolatileWork/);
  assert.match(appSource, /className="career-lifecycle-task-recovery"/);
  assert.match(css, /\.career-lifecycle-task-recovery,[\s\S]*?overflow: hidden/);
  assert.match(css, /\.career-lifecycle-task-recovery \.career-button,[\s\S]*?min-height: 44px/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.career-lifecycle-task-recovery > footer \.career-button,[\s\S]*?width: 100%/);
});
