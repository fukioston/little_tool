import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const sourceUrl = new URL("../app/career/CareerApp.tsx", import.meta.url);
const cssUrl = new URL("../app/career/career.css", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const css = await readFile(cssUrl, "utf8");
const settingsStart = source.indexOf("function SettingsView");
const drawerStart = source.indexOf("function Drawer", settingsStart);
const settings = source.slice(settingsStart, drawerStart);

async function loadBackupRecoveryHelpers() {
  const sourceFile = ts.createSourceFile(sourceUrl.pathname, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const constants = new Set([
    "CAREER_SHA256_PATTERN",
    "CAREER_UUID_V4_PATTERN",
    "CAREER_BACKUP_RECOVERY_PREFIX",
    "CAREER_BACKUP_RECOVERY_MAX_BYTES",
  ]);
  const functions = new Set([
    "hasExactObjectKeys",
    "isRecoveryText",
    "isBackupRecord",
    "isBackupIsoDate",
    "isBackupGenerationId",
    "isBackupAttachmentKeys",
    "isCareerRestoreSummary",
    "isCareerRestoreReceipt",
    "isCareerPrepareRecoveryReceipt",
    "isCareerPrepareCleanupReceipt",
    "careerBackupRecoveryIdentity",
    "careerBackupRecoveryStorageKey",
    "isCareerBackupRecoveryTicket",
  ]);
  const declarations = sourceFile.statements.filter((statement) => {
    if (ts.isFunctionDeclaration(statement) && statement.name) return functions.has(statement.name.text);
    if (!ts.isVariableStatement(statement)) return false;
    return statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && constants.has(declaration.name.text),
    );
  });
  assert.equal(declarations.length, constants.size + functions.size);
  const { outputText, diagnostics = [] } = ts.transpileModule(
    declarations.map((item) => `export ${item.getText(sourceFile)}`).join("\n"),
    {
      fileName: "career-backup-recovery-helpers.ts",
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    },
  );
  assert.deepEqual(diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const helpers = await loadBackupRecoveryHelpers();
const generationId = "30000000-0000-4000-8000-000000000001";
const summary = {
  kind: "complete-backup",
  fileName: "career.career-backup",
  byteSize: 2048,
  databaseByteSize: 1024,
  exportedAt: "2026-08-21T02:03:04.000Z",
  sourceUserVersion: 3,
  canonicalUserVersion: 3,
  attachmentCount: 1,
  jobCount: null,
  materialCount: null,
  verification: "container-and-payload-verified",
};
const prepareReceipt = {
  version: 1,
  database: "zhiji",
  operationId: generationId,
  generationId,
  operationToken: "a".repeat(64),
  projectionSha256: "b".repeat(64),
  attachmentKeysSha256: "c".repeat(64),
  preparedAt: "2026-08-21T02:03:05.000Z",
  summary,
  stagedAttachmentKeys: ["20000000-0000-4000-8000-000000000001"],
};
const candidateReceipt = {
  version: 1,
  database: "zhiji",
  generationId,
  activationToken: "d".repeat(64),
  recoveryToken: "e".repeat(64),
  expectedCurrentGenerationId: "10000000-0000-4000-8000-000000000001",
  expectedCurrentSequence: 4,
  canonicalApplicationId: 1514687049,
  canonicalUserVersion: 3,
  projectionSha256: "b".repeat(64),
  preparedAt: "2026-08-21T02:03:05.000Z",
  summary,
  stagedAttachmentKeys: ["20000000-0000-4000-8000-000000000001"],
};

test("restore UI uses the staged APIs and removes the one-shot confirmation path", () => {
  for (const call of [
    "prepareCareerBackupRestore",
    "recoverCareerBackupPrepare",
    "retryCareerPrepareCleanup",
    "activatePreparedCareerRestore",
    "inspectCareerRestoreActivation",
    "discardPreparedCareerRestore",
  ]) assert.match(source, new RegExp(call));
  for (const removed of ["restoreCompleteCareerBackup", "restoreLegacyCareerDatabase", "window.confirm", "isCompleteCareerBackup(file)"]) {
    assert.doesNotMatch(settings, new RegExp(removed.replace(/[.()]/g, "\\$&")));
  }
  assert.match(settings, /正在判断“\{backupFlow\.fileName\}”是什么/);
  assert.match(settings, /summary\.kind === "legacy-career-sqlite"/);
});

test("prepare checkpoints are durably awaited before database staging can begin", () => {
  const prepareStart = settings.indexOf("async function prepareSelectedBackup");
  const activateStart = settings.indexOf("async function activateCandidate", prepareStart);
  const prepare = settings.slice(prepareStart, activateStart);
  assert.match(prepare, /prepareCareerBackupRestore\(file, \{/);
  assert.match(prepare, /onRecoveryPrepared: async \(recoveryReceipt\)/);
  assert.match(prepare, /if \(!persistBackupRecovery\(ticket\)\) \{\s*throw new Error/);
  assert.ok(prepare.indexOf("persistBackupRecovery(ticket)") < prepare.indexOf("const next = candidateTicket(receipt"));
  assert.match(settings, /backupFlow\.phase !== "preparing" && volatileBackupRecoveries\.length === 0/);
  assert.match(settings, /window\.addEventListener\("beforeunload", protectUnfinishedRestore\)/);
});

test("all phases of one restore atomically replace one operation-bound ticket", () => {
  const prepareTicket = { version: 1, kind: "prepare", receipt: prepareReceipt, recordedAt: "2026-08-21T02:03:06.000Z" };
  const candidateTicket = { version: 1, kind: "candidate", mode: "review", receipt: candidateReceipt, recordedAt: "2026-08-21T02:03:07.000Z" };
  const activationTicket = { ...candidateTicket, mode: "activation-check" };
  const refreshTicket = { version: 1, kind: "refresh-only", receipt: candidateReceipt, recordedAt: "2026-08-21T02:03:08.000Z" };
  for (const ticket of [prepareTicket, candidateTicket, activationTicket, refreshTicket]) {
    assert.equal(helpers.isCareerBackupRecoveryTicket(ticket), true);
    assert.equal(helpers.careerBackupRecoveryStorageKey(ticket), `career.backup-recovery.v1:operation:${generationId}`);
  }
  assert.match(source, /return `operation:\$\{ticket\.receipt\.generationId\}`/);
  assert.doesNotMatch(source, /career\.backup-recovery\.v1:(?:prepare|candidate):/);
  assert.match(settings, /window\.localStorage\.setItem\(storageKey, serialized\)/);
  assert.match(source, /storageKey !== careerBackupRecoveryStorageKey\(parsed\)/);
});

test("stored tickets are exact, bounded, and fail closed before UI actions", () => {
  const valid = { version: 1, kind: "candidate", mode: "review", receipt: candidateReceipt, recordedAt: "2026-08-21T02:03:07.000Z" };
  assert.equal(helpers.isCareerBackupRecoveryTicket(valid), true);
  assert.equal(helpers.isCareerBackupRecoveryTicket({ ...valid, extra: "execute me" }), false);
  assert.equal(helpers.isCareerBackupRecoveryTicket({ ...valid, receipt: { ...candidateReceipt, activationToken: "short" } }), false);
  assert.equal(helpers.isCareerBackupRecoveryTicket({ ...valid, receipt: { ...candidateReceipt, summary: { ...summary, jobCount: 7 } } }), false);
  assert.match(source, /raw\.length > CAREER_BACKUP_RECOVERY_MAX_BYTES/);
  assert.match(settings, /markBackupRecoveryUnreadable/);
  assert.match(settings, /保留本机候选，并只清除这条提醒/);
});

test("persisted candidates are inspected before review and uncertain activation never repeats", () => {
  const inspectStart = settings.indexOf("async function inspectCandidate");
  const recoverStart = settings.indexOf("async function recoverPreparation", inspectStart);
  const inspect = settings.slice(inspectStart, recoverStart);
  assert.match(inspect, /inspectCareerRestoreActivation\(receipt\)/);
  assert.doesNotMatch(inspect, /activatePreparedCareerRestore|discardPreparedCareerRestore/);
  assert.match(inspect, /mode === "review" && baselineUnchanged/);
  assert.match(inspect, /candidateTicket\(receipt, "discard-only"\)/);
  assert.match(settings, /await inspectCandidate\(entry\)/);
  const activationStart = settings.indexOf("async function activateCandidate");
  const discardStart = settings.indexOf("async function discardCandidate", activationStart);
  const activation = settings.slice(activationStart, discardStart);
  assert.ok(activation.indexOf('candidateTicket(receipt, "activation-check")') < activation.indexOf("activatePreparedCareerRestore(receipt)"));
  assert.equal((activation.match(/activatePreparedCareerRestore\(/g) ?? []).length, 1);
  assert.match(activation, /CareerActivationUncertainError/);
});

test("discard uncertainty and prepare cleanup expose cleanup-only retries", () => {
  const discardStart = settings.indexOf("async function discardCandidate");
  const cleanupStart = settings.indexOf("async function cleanPreparedAttachments", discardStart);
  const discard = settings.slice(discardStart, cleanupStart);
  assert.ok(discard.indexOf('candidateTicket(receipt, "discard-only")') < discard.indexOf("discardPreparedCareerRestore(receipt)"));
  assert.doesNotMatch(discard, /activatePreparedCareerRestore/);
  assert.match(discard, /attachmentCleanup === "incomplete"/);
  assert.match(settings, /retryCareerPrepareCleanup\(receipt\)/);
  assert.match(settings, /继续时只会重试收尾，不会启用候选/);
});

test("activation success and page refresh remain separate truthful outcomes", () => {
  const refreshStart = settings.indexOf("async function finishBackupRefresh");
  const inspectStart = settings.indexOf("async function inspectCandidate", refreshStart);
  const refresh = settings.slice(refreshStart, inspectStart);
  assert.ok(refresh.indexOf("persistBackupRecovery(refreshTicket(receipt))") < refresh.indexOf("await onRefresh()"));
  assert.match(refresh, /备份已经启用。页面暂时没有重新读到它/);
  assert.doesNotMatch(refresh, /恢复失败|启用失败/);
  assert.match(settings, /phase: "refresh-only"/);
  assert.match(settings, />重新读取页面资料<\/button>/);
});

test("review shows only facts the backend actually knows", () => {
  const summaryStart = settings.indexOf("const renderBackupSummary");
  const flowStart = settings.indexOf("const renderBackupFlow", summaryStart);
  const summaryView = settings.slice(summaryStart, flowStart);
  assert.match(summaryView, /summary\.fileName/);
  assert.match(summaryView, /summary\.attachmentCount/);
  assert.match(summaryView, /summary\.exportedAt/);
  assert.match(summaryView, /summary\.verification/);
  assert.doesNotMatch(summaryView, /summary\.(?:jobCount|materialCount)/);
  assert.match(settings, /旧版数据库不带材料原件/);
  assert.match(settings, /启用后会清空旧附件索引/);
});

test("recovery survives mount and cross-tab changes without allowing a new prepare", () => {
  assert.match(settings, /readCareerBackupRecoveryStorage\(\)/);
  assert.match(settings, /window\.addEventListener\("storage", onStorage\)/);
  assert.match(settings, /window\.addEventListener\("focus", onFocus\)/);
  assert.match(settings, /allowInitialBackupResumeRef\.current = false;\s*reloadBackupRecoveries\(\)/);
  assert.match(settings, /Boolean\(activeBackupRecovery\)/);
  assert.match(settings, /backupRecoveryUnreadableKeys\.length > 0/);
  assert.match(settings, /backupRecoveryEntries\[0\]/);
  assert.match(settings, /还有 \{backupRecoveryEntries\.length\} 次独立恢复需要依次确认/);
  assert.match(settings, />继续这次核对<\/button>/);
});

test("bookmarklet returns to the exact current origin", () => {
  assert.match(settings, /new URL\("\/career", window\.location\.origin\)/);
  assert.match(settings, /encodeURIComponent\(location\.href\)/);
  assert.match(settings, /当前这一个职迹地址/);
  assert.doesNotMatch(settings, /localhost:3000|127\.0\.0\.1:3000/);
});

test("backup controls remain operable on a 319px viewport", () => {
  assert.match(css, /\.career-backup-card \.career-data-actions > button,[\s\S]*?min-height: 62px/);
  assert.match(css, /\.career-backup-warning \.career-button \{ min-height: 44px/);
  assert.match(css, /\.career-backup-flow > footer \.career-button \{ min-height: 44px/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.career-backup-summary \{ grid-template-columns: 1fr/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(settings, /backupFlowHeadingRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(settings, /backupPickerButtonRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(settings, /backupFileInputRef\.current\?\.focus/);
});

test("long prepare work can be stopped without losing a late checkpoint", () => {
  assert.match(settings, /const controller = new AbortController\(\)/);
  assert.match(settings, /signal: controller\.signal/);
  assert.match(settings, /backupPrepareControllerRef\.current\.abort\(\)/);
  assert.match(settings, /backupPrepareStopping \? "正在停止…" : "停止核对"/);
  assert.match(settings, /候选已经开始建立，会保留同一次继续信息/);
  assert.match(settings, /error\.code === "PREPARE_ABORTED"/);
});

test("volatile-only terminal tickets clear in memory even when storage removal is unavailable", () => {
  const removeStart = settings.indexOf("const removeBackupRecoveryKeys");
  const removeEnd = settings.indexOf("function removeBackupRecoveryFor", removeStart);
  const removal = settings.slice(removeStart, removeEnd);
  assert.match(removal, /if \(!durableBackupRecoveryKeysRef\.current\.has\(storageKey\)\) \{\s*cleared\.add\(storageKey\);\s*continue/);
  assert.ok(removal.indexOf("durableBackupRecoveryKeysRef.current.has") < removal.indexOf("window.localStorage.removeItem"));
  assert.match(settings, /if \(removeBackupRecoveryFor\(entry\.ticket\.receipt\)\)/);
  assert.match(settings, /recovered\.status === "cleanup-complete"[\s\S]*?本页暂时没能清除继续提醒/);
});
