import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const recoveryUrl = new URL("app/vocab/review-recovery.ts", projectRoot);
const appUrl = new URL("app/vocab/VocabApp.tsx", projectRoot);
const viewsUrl = new URL("app/vocab/views.tsx", projectRoot);
const cssUrl = new URL("app/vocab/vocab.css", projectRoot);

const [recoverySource, appSource, viewsSource, css] = await Promise.all([
  readFile(recoveryUrl, "utf8"),
  readFile(appUrl, "utf8"),
  readFile(viewsUrl, "utf8"),
  readFile(cssUrl, "utf8"),
]);

const receiptGuardSource = `
const exact = (value, keys) => value && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const base = ["version","kind","operationId","eventId","activityId","cardId",
  "rating","reviewedAt","day","before","after","projectionSha256"];
export function isVocabReviewRatingReceipt(value) {
  return exact(value, base) && value.version === 1 &&
    value.kind === "review-rating" && typeof value.operationId === "string";
}
export function isVocabReviewUndoReceipt(value) {
  return exact(value, [...base,"ratingOperationId","undoneAt"]) &&
    value.version === 1 && value.kind === "review-undo" &&
    typeof value.operationId === "string";
}
`;
const guardUrl = `data:text/javascript;base64,${Buffer.from(receiptGuardSource).toString("base64")}`;
const transpiledRecovery = ts.transpileModule(recoverySource, {
  fileName: recoveryUrl.pathname,
  reportDiagnostics: true,
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
  },
});
assert.deepEqual(
  (transpiledRecovery.diagnostics ?? []).filter(
    ({ category }) => category === ts.DiagnosticCategory.Error,
  ),
  [],
);
const recoveryJs = transpiledRecovery.outputText.replace(
  'from "@/lib/vocab/store"',
  `from "${guardUrl}"`,
);
const recovery = await import(
  `data:text/javascript;base64,${Buffer.from(recoveryJs).toString("base64")}`
);

function projection(updatedAt) {
  return {
    state: "review",
    due_at: updatedAt + 86_400_000,
    interval_days: 1,
    ease: 2.5,
    reps: 2,
    lapses: 0,
    last_review_at: updatedAt,
    algorithm_version: 2,
    suspended_from_state: null,
    suspended_reason: null,
    updated_at: updatedAt,
  };
}

function ratingReceipt(index = 1) {
  const reviewedAt = 1_800_000_000_000 + index;
  return {
    version: 1,
    kind: "review-rating",
    operationId: `operation-${index}`,
    eventId: `review-${index}`,
    activityId: `activity-${index}`,
    cardId: `card-${index}`,
    rating: "good",
    reviewedAt,
    day: "2027-01-15",
    before: projection(reviewedAt - 1),
    after: projection(reviewedAt),
    projectionSha256: "a".repeat(64),
  };
}

function undoReceipt(index = 1) {
  const rating = ratingReceipt(index);
  return {
    ...rating,
    kind: "review-undo",
    operationId: `operation-undo-${index}`,
    ratingOperationId: rating.operationId,
    undoneAt: rating.reviewedAt + 1,
  };
}

function ticket(receipt, mode = "inspect-only", recordedAt = "2027-01-15T08:00:00.000Z") {
  return recovery.createVocabReviewRecoveryTicket(receipt, mode, recordedAt);
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

function journalRuntime(storage) {
  let tail = Promise.resolve();
  return {
    storage,
    withExclusiveLock(task) {
      const run = tail.then(task, task);
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

test("review tickets are exact, bounded, ISO-canonical, receipt-guarded, and operation-keyed", () => {
  const valid = ticket(ratingReceipt());
  assert.equal(recovery.isVocabReviewRecoveryTicket(valid), true);
  assert.equal(
    recovery.vocabReviewRecoveryStorageKey(valid),
    `${recovery.VOCAB_REVIEW_RECOVERY_PREFIX}${valid.operationId}`,
  );
  assert.equal(recovery.isVocabReviewRecoveryTicket({ ...valid, extra: true }), false);
  assert.equal(recovery.isVocabReviewRecoveryTicket({
    ...valid,
    recordedAt: "2027-01-15T08:00:00Z",
  }), false);
  assert.equal(recovery.isVocabReviewRecoveryTicket({
    ...valid,
    operationId: "operation-peer",
  }), false);
  assert.equal(recovery.isVocabReviewRecoveryTicket({
    ...valid,
    receipt: { ...valid.receipt, extra: true },
  }), false);
  assert.match(recoverySource, /isVocabReviewRatingReceipt\(receipt\)/);
  assert.match(recoverySource, /isVocabReviewUndoReceipt\(receipt\)/);
  assert.match(recoverySource, /VOCAB_REVIEW_RECOVERY_MAX_BYTES = 64 \* 1024/);
});

test("multiple operations remain independent and one damaged raw entry cannot hide peers", async () => {
  const first = ticket(ratingReceipt(1));
  const second = ticket(undoReceipt(2), "retry-commit", "2027-01-15T08:00:01.000Z");
  const storage = memoryStorage([
    [recovery.vocabReviewRecoveryStorageKey(second), JSON.stringify(second)],
    [`${recovery.VOCAB_REVIEW_RECOVERY_PREFIX}damaged`, "{not-json"],
    [recovery.vocabReviewRecoveryStorageKey(first), JSON.stringify(first)],
  ]);
  const read = recovery.readVocabReviewRecoveryStorage(storage);
  assert.equal(read.storageUnavailable, false);
  assert.deepEqual(read.entries.map(({ ticket: value }) => value.operationId), [
    first.operationId,
    second.operationId,
  ]);
  assert.equal(read.unreadableEntries.length, 1);
  assert.equal(read.unreadableEntries[0].raw, "{not-json");

  const damaged = read.unreadableEntries[0];
  storage.setItem(damaged.storageKey, "peer-replaced");
  assert.equal(
    (await recovery.removeUnreadableVocabReviewEntry(
      damaged,
      journalRuntime(storage),
    )).outcome,
    "stale",
  );
  assert.equal(storage.getItem(damaged.storageKey), "peer-replaced");
});

test("entry lock spans backend work through transition so stale peer CTA never runs", async () => {
  const storage = memoryStorage();
  const runtime = journalRuntime(storage);
  const initial = ticket(ratingReceipt());
  let releaseBackend;
  const backendGate = new Promise((resolve) => { releaseBackend = resolve; });
  let firstCalls = 0;
  let staleCalls = 0;

  const firstRun = recovery.runNewVocabReviewRecoveryTransaction(
    initial,
    async (locked) => {
      firstCalls += 1;
      await backendGate;
      locked.replace(recovery.transitionVocabReviewRecoveryTicket(
        locked.current().ticket,
        "refresh-only",
      ));
    },
    runtime,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const pending = recovery.readVocabReviewRecoveryStorage(storage).entries[0];
  const staleRun = recovery.runVocabReviewRecoveryEntryTransaction(
    pending,
    async () => { staleCalls += 1; },
    runtime,
  );
  releaseBackend();
  const [firstResult, staleResult] = await Promise.all([firstRun, staleRun]);
  assert.equal(firstResult.outcome, "completed");
  assert.equal(staleResult.outcome, "stale");
  assert.equal(firstCalls, 1);
  assert.equal(staleCalls, 0);
});

test("missing journal lock fails closed before any task body can inspect, commit, or clear", async () => {
  const storage = memoryStorage();
  let tasks = 0;
  const unavailableRuntime = {
    storage,
    async withExclusiveLock() { throw new Error("no lock"); },
  };
  assert.equal(
    await recovery.probeVocabReviewJournalLock(unavailableRuntime),
    "unavailable",
  );
  const result = await recovery.runNewVocabReviewRecoveryTransaction(
    ticket(ratingReceipt(3)),
    async () => { tasks += 1; },
    unavailableRuntime,
  );
  assert.equal(result.outcome, "unavailable");
  assert.equal(tasks, 0);
  assert.equal(storage.length, 0);

  const recentStorage = memoryStorage();
  const recentRuntime = journalRuntime(recentStorage);
  await recovery.runNewVocabReviewRecoveryTransaction(
    ticket(ratingReceipt(31)),
    async (locked) => {
      locked.rememberRecentRating(ratingReceipt(31));
      locked.remove();
    },
    recentRuntime,
  );
  const recent = recovery.readVocabReviewRecentUndoStorage(recentStorage).entry;
  const recentResult = await recovery.runVocabReviewRecentUndoEntryTransaction(
    recent,
    async () => { tasks += 1; },
    { ...unavailableRuntime, storage: recentStorage },
  );
  assert.equal(recentResult.outcome, "unavailable");
  assert.equal(tasks, 0);
  assert.ok(recovery.readVocabReviewRecentUndoStorage(recentStorage).entry);
});

test("lost commit response becomes inspect-only, exact becomes refresh-only, and refresh failure does zero second writes", async () => {
  const storage = memoryStorage();
  const runtime = journalRuntime(storage);
  const initial = ticket(ratingReceipt());
  let commits = 0;
  let inspections = 0;
  let refreshes = 0;

  await recovery.runNewVocabReviewRecoveryTransaction(initial, async () => {
    commits += 1;
    // Simulates a durable commit whose response was lost: keep inspect-only.
  }, runtime);
  let entry = recovery.readVocabReviewRecoveryStorage(storage).entries[0];
  assert.equal(entry.ticket.mode, "inspect-only");

  await recovery.runVocabReviewRecoveryEntryTransaction(entry, async (locked) => {
    inspections += 1;
    const inspectStatus = "exact";
    if (inspectStatus === "exact") locked.replace(
      recovery.transitionVocabReviewRecoveryTicket(
        locked.current().ticket,
        "refresh-only",
      ),
    );
  }, runtime);
  entry = recovery.readVocabReviewRecoveryStorage(storage).entries[0];
  assert.equal(entry.ticket.mode, "refresh-only");

  await recovery.runVocabReviewRecoveryEntryTransaction(entry, async () => {
    refreshes += 1;
    // Failed snapshot reload deliberately leaves the ticket untouched.
  }, runtime);
  assert.equal(
    recovery.readVocabReviewRecoveryStorage(storage).entries[0].ticket.mode,
    "refresh-only",
  );
  entry = recovery.readVocabReviewRecoveryStorage(storage).entries[0];
  await recovery.runVocabReviewRecoveryEntryTransaction(entry, async (locked) => {
    refreshes += 1;
    locked.remove();
  }, runtime);
  assert.equal(commits, 1);
  assert.equal(inspections, 1);
  assert.equal(refreshes, 2);
  assert.equal(recovery.readVocabReviewRecoveryStorage(storage).entries.length, 0);
});

test("definitely absent retries the same receipt and synchronous-style serialization admits one commit", async () => {
  const storage = memoryStorage();
  const runtime = journalRuntime(storage);
  const original = ticket(ratingReceipt(4));
  await recovery.runNewVocabReviewRecoveryTransaction(original, async (locked) => {
    locked.replace(recovery.transitionVocabReviewRecoveryTicket(
      locked.current().ticket,
      "retry-commit",
    ));
  }, runtime);
  const entry = recovery.readVocabReviewRecoveryStorage(storage).entries[0];
  const originalReceiptRaw = JSON.stringify(entry.ticket.receipt);
  let commits = 0;
  const [left, right] = await Promise.all([
    recovery.runVocabReviewRecoveryEntryTransaction(entry, async (locked) => {
      commits += 1;
      locked.replace(recovery.transitionVocabReviewRecoveryTicket(
        locked.current().ticket,
        "refresh-only",
      ));
    }, runtime),
    recovery.runVocabReviewRecoveryEntryTransaction(entry, async () => {
      commits += 1;
    }, runtime),
  ]);
  assert.deepEqual([left.outcome, right.outcome].sort(), ["completed", "stale"]);
  assert.equal(commits, 1);
  const settled = recovery.readVocabReviewRecoveryStorage(storage).entries[0];
  assert.equal(JSON.stringify(settled.ticket.receipt), originalReceiptRaw);
  assert.equal(settled.ticket.operationId, original.operationId);
});

test("undo uncertainty stays inspect-only and exact refresh clears only matching recent undo affordance", async () => {
  const storage = memoryStorage();
  const runtime = journalRuntime(storage);
  const recentRating = ratingReceipt(7);
  const ratingTicket = ticket(recentRating);
  await recovery.runNewVocabReviewRecoveryTransaction(ratingTicket, async (locked) => {
    locked.rememberRecentRating(recentRating);
    locked.remove();
  }, runtime);
  assert.equal(
    recovery.readVocabReviewRecentUndoStorage(storage).entry.ticket.receipt.eventId,
    recentRating.eventId,
  );

  const undo = ticket(undoReceipt(7));
  let undoCommits = 0;
  await recovery.runNewVocabReviewRecoveryTransaction(undo, async () => {
    undoCommits += 1;
    // Response lost; inspect-only remains durable.
  }, runtime);
  let pending = recovery.readVocabReviewRecoveryStorage(storage).entries[0];
  assert.equal(pending.ticket.action, "undo");
  assert.equal(pending.ticket.mode, "inspect-only");
  await recovery.runVocabReviewRecoveryEntryTransaction(pending, async (locked) => {
    locked.replace(recovery.transitionVocabReviewRecoveryTicket(
      locked.current().ticket,
      "refresh-only",
    ));
  }, runtime);
  pending = recovery.readVocabReviewRecoveryStorage(storage).entries[0];
  await recovery.runVocabReviewRecoveryEntryTransaction(pending, async (locked) => {
    locked.clearRecentRating(recentRating.eventId);
    locked.remove();
  }, runtime);
  assert.equal(undoCommits, 1);
  assert.equal(recovery.readVocabReviewRecentUndoStorage(storage).entry, null);
});

test("recent undo survives reload, remains non-blocking, and a later exact rating replaces only the latest", async () => {
  const storage = memoryStorage();
  const runtime = journalRuntime(storage);
  const first = ratingReceipt(8);
  const second = ratingReceipt(9);
  for (const receipt of [first, second]) {
    await recovery.runNewVocabReviewRecoveryTransaction(
      ticket(receipt),
      async (locked) => {
        locked.rememberRecentRating(receipt);
        locked.remove();
      },
      runtime,
    );
  }
  const reloaded = recovery.readVocabReviewRecentUndoStorage(storage);
  assert.equal(reloaded.entry.ticket.receipt.eventId, second.eventId);
  assert.equal(recovery.readVocabReviewRecoveryStorage(storage).entries.length, 0);

  const damaged = memoryStorage([[recovery.VOCAB_REVIEW_RECENT_UNDO_KEY, "bad"]]);
  const unreadable = recovery.readVocabReviewRecentUndoStorage(damaged);
  assert.deepEqual(unreadable, {
    entry: null,
    unreadable: {
      storageKey: recovery.VOCAB_REVIEW_RECENT_UNDO_KEY,
      raw: "bad",
    },
    storageUnavailable: false,
  });
  damaged.setItem(recovery.VOCAB_REVIEW_RECENT_UNDO_KEY, "peer-new-raw");
  assert.equal(
    (await recovery.removeUnreadableVocabReviewRecentUndo(
      unreadable.unreadable,
      journalRuntime(damaged),
    )).outcome,
    "stale",
  );
  assert.equal(
    damaged.getItem(recovery.VOCAB_REVIEW_RECENT_UNDO_KEY),
    "peer-new-raw",
  );
});

test("a definite current-database miss clears only exact recent A, never peer replacement B", async () => {
  const storage = memoryStorage();
  const runtime = journalRuntime(storage);
  const first = ratingReceipt(41);
  await recovery.runNewVocabReviewRecoveryTransaction(
    ticket(first),
    async (locked) => {
      locked.rememberRecentRating(first);
      locked.remove();
    },
    runtime,
  );
  const capturedA = recovery.readVocabReviewRecentUndoStorage(storage).entry;
  let undoWrites = 0;
  const missing = await recovery.runVocabReviewRecentUndoEntryTransaction(
    capturedA,
    async (locked) => {
      const currentDatabaseStatus = "changed";
      if (["absent", "changed", "conflict"].includes(currentDatabaseStatus)) {
        locked.remove();
      } else {
        undoWrites += 1;
      }
    },
    runtime,
  );
  assert.equal(missing.outcome, "completed");
  assert.equal(undoWrites, 0);
  assert.equal(recovery.readVocabReviewRecentUndoStorage(storage).entry, null);

  let peerCapturedA = null;
  for (const receipt of [first, ratingReceipt(42)]) {
    await recovery.runNewVocabReviewRecoveryTransaction(
      ticket(receipt),
      async (locked) => {
        locked.rememberRecentRating(receipt);
        locked.remove();
      },
      runtime,
    );
    if (receipt === first) {
      // Capture A before a lock-respecting peer replaces it with B.
      peerCapturedA = recovery.readVocabReviewRecentUndoStorage(storage).entry;
      assert.equal(peerCapturedA.ticket.receipt.eventId, first.eventId);
    }
  }
  let staleTaskCalls = 0;
  const stale = await recovery.runVocabReviewRecentUndoEntryTransaction(
    peerCapturedA,
    async (locked) => {
      staleTaskCalls += 1;
      locked.remove();
    },
    runtime,
  );
  assert.equal(stale.outcome, "stale");
  assert.equal(staleTaskCalls, 0);
  assert.equal(
    recovery.readVocabReviewRecentUndoStorage(storage).entry.ticket.receipt.eventId,
    "review-42",
  );
});

test("UI uses staged receipt APIs, first-await claims, inspect-only recovery, and no legacy review writes", () => {
  assert.doesNotMatch(appSource, /\brateReview\b|\bundoReview\b/);
  assert.doesNotMatch(viewsSource, /\brateReview\b|\bundoReview\b/);
  for (const call of [
    "prepareVocabReviewRating", "commitVocabReviewRating",
    "inspectVocabReviewRating", "prepareVocabReviewUndo",
    "commitVocabReviewUndo", "inspectVocabReviewUndo",
  ]) assert.match(viewsSource, new RegExp(`\\b${call}\\b`));
  assert.match(viewsSource, /if \(!card \|\| recoveryBlocksWrites \|\| !claim\(\)\) return;/);
  assert.match(viewsSource, /if \(!lastEvent \|\| recoveryBlocksWrites \|\| !claim\(\)\) return;/);
  assert.match(viewsSource, /operationClaim\.current = true;[\s\S]{0,100}setBusy\(true\)/);
  assert.match(viewsSource, /runNewVocabReviewRecoveryTransaction/);
  assert.match(viewsSource, /runVocabReviewRecoveryEntryTransaction/);
  assert.match(viewsSource, /"focus", onFocus/);
  assert.match(viewsSource, /"storage", onStorage/);
  const passiveReloadHandlers =
    viewsSource.match(/const onFocus =[^]*?window\.addEventListener\("storage"/)?.[0] ?? "";
  assert.doesNotMatch(
    passiveReloadHandlers,
    /prepareVocabReview|inspectVocabReview|commitVocabReview|\.focus\(/,
  );
  assert.match(viewsSource, /用同一条凭据再试一次/);
  assert.match(viewsSource, /只重新读取页面/);
  assert.match(viewsSource, /保留数据库现状并清除提醒/);
  assert.match(viewsSource, /刷新页面后仍可撤销/);
  assert.match(viewsSource, /保留复习记录，只清除无法验证的撤销提醒/);
  assert.match(viewsSource, /当前词库没有这次评分，未改动记录/);
  assert.match(viewsSource, /runVocabReviewRecentUndoEntryTransaction/);
  assert.doesNotMatch(
    viewsSource.match(/const settleUnavailableRecentUndo =[^]*?const undoLast =/)?.[0] ?? "",
    /commitVocabReviewUndo/,
  );
  assert.match(viewsSource, /暂时无法取得跨页面保护/);
  assert.match(viewsSource, /journalLockUnavailable \|\| journal\.unreadableEntries/);
  assert.match(recoverySource, /throw new Error\("当前浏览器无法提供跨页面恢复锁。"\)/);
  assert.doesNotMatch(recoverySource, /if \(!manager\) return task\(\)/);
});

test("319px recovery actions stay stacked, touch-sized, and status focus is explicit", () => {
  assert.match(css, /\.sc-review-recovery button\{min-height:44px/);
  assert.match(css, /\.sc-review-recovery\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(css, /@media\(max-width:760px\)[\s\S]*\.sc-review-recovery\{grid-template-columns:1fr/);
  assert.match(css, /\.sc-review-recovery footer\{display:grid;grid-template-columns:1fr/);
  assert.match(
    viewsSource,
    /recoveryFocusTarget\.current === "recent-undo"[\s\S]{0,180}target\.focus\(\{ preventScroll: true \}\)/,
  );
  assert.match(viewsSource, /ref=\{recoveryHeading\} tabIndex=\{-1\}/);
  assert.match(viewsSource, /ref=\{recentUndoHeading\} tabIndex=\{-1\}/);
  assert.match(viewsSource, /focusRecovery\("recent-undo"\)/);
  assert.match(viewsSource, /role=\{tone === "warning" \? "alert" : "status"\}/);
});

test("mobile sidebar close paths restore a connected visible opener after hiding", () => {
  assert.match(appSource, /const sidebarOpener = useRef<HTMLButtonElement>\(null\)/);
  assert.match(appSource, /window\.requestAnimationFrame\(\(\) => \{[\s\S]{0,300}opener\?\.isConnected/);
  assert.match(appSource, /opener\.getClientRects\(\)\.length === 0/);
  assert.match(appSource, /window\.getComputedStyle\(opener\)/);
  assert.match(appSource, /opener\.focus\(\{ preventScroll: true \}\)/);
  assert.match(appSource, /const closeMobileSidebar = useCallback/);
  assert.match(appSource, /useOverlayDialog<HTMLElement>\([\s\S]{0,100}closeMobileSidebar/);
  assert.match(appSource, /data-sidebar-close[^>]*onClick=\{closeMobileSidebar\}/);
  assert.match(appSource, /sc-nav-scrim" onClick=\{closeMobileSidebar\}/);
  assert.match(appSource, /ref=\{sidebarOpener\} className="sc-menu"/);
  assert.match(appSource, /setView\(next\); closeMobileSidebar\(\)/);
});

test("duration fact helper executes zero, unknown, sub-minute, and known-minute truthfully", async () => {
  const match = viewsSource.match(
    /export function formatKnownVocabDuration\([^]*?\n\}/,
  );
  assert.ok(match);
  const compiled = ts.transpileModule(match[0], {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const helper = await import(
    `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
  );
  assert.equal(helper.formatKnownVocabDuration(0), "时长未记录");
  assert.equal(helper.formatKnownVocabDuration(Number.NaN), "时长未记录");
  assert.equal(helper.formatKnownVocabDuration(59_999), "少于 1 分钟");
  assert.equal(helper.formatKnownVocabDuration(60_000), "1 分钟");
  assert.equal(helper.formatKnownVocabDuration(149_999), "2 分钟");
  assert.match(viewsSource, /保存在当前完整网址与浏览器资料中/);
  assert.doesNotMatch(viewsSource, /只属于这台设备/);
  assert.doesNotMatch(viewsSource, /Math\.max\(1,\s*Math\.round\(item\.duration_ms/);
});
