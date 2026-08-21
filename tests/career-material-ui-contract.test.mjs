import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const sourceUrl = new URL("../app/career/CareerApp.tsx", import.meta.url);
const cssUrl = new URL("../app/career/career.css", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const css = await readFile(cssUrl, "utf8");
const materialsStart = source.indexOf("function careerMaterialStatusText");
const analyticsStart = source.indexOf("function AnalyticsView", materialsStart);
const materialsView = source.slice(materialsStart, analyticsStart);
const saveStart = source.indexOf("function MaterialModal");
const deleteStart = source.indexOf("function MaterialDeletionModal", saveStart);
const importStart = source.indexOf("type CareerImportMode", deleteStart);
const saveModal = source.slice(saveStart, deleteStart);
const deleteModal = source.slice(deleteStart, importStart);

async function loadMaterialHelpers() {
  const sourceFile = ts.createSourceFile(sourceUrl.pathname, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const names = new Set(["careerMaterialStatusText", "careerMaterialFileDetails", "materialDeletionPendingMessage", "materialDeletionSuccessMessage"]);
  const declarations = sourceFile.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text),
  );
  assert.equal(declarations.length, names.size);
  const { outputText, diagnostics = [] } = ts.transpileModule(declarations.map((item) => `export ${item.getText(sourceFile)}`).join("\n"), {
    fileName: "career-material-ui-helpers.ts",
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  assert.deepEqual(diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const helpers = await loadMaterialHelpers();

async function loadMaterialRecoveryHelpers() {
  const sourceFile = ts.createSourceFile(sourceUrl.pathname, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const constants = new Set([
    "CAREER_MATERIAL_SAVE_RECOVERY_MAX_BYTES",
    "CAREER_MATERIAL_ATTACHMENT_MAX_BYTES",
    "CAREER_SHA256_PATTERN",
  ]);
  const functions = new Set([
    "hasExactObjectKeys",
    "isRecoveryIdentifier",
    "isRecoveryText",
    "isMaterialSaveExpectedSnapshot",
    "isMaterialCleanupReceipt",
    "isMaterialSaveRecoveryTicket",
  ]);
  const declarations = sourceFile.statements.filter((statement) => {
    if (ts.isFunctionDeclaration(statement) && statement.name) return functions.has(statement.name.text);
    if (!ts.isVariableStatement(statement)) return false;
    return statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && constants.has(declaration.name.text),
    );
  });
  assert.equal(declarations.length, constants.size + functions.size);
  const { outputText, diagnostics = [] } = ts.transpileModule(declarations.map((item) => `export ${item.getText(sourceFile)}`).join("\n"), {
    fileName: "career-material-recovery-helpers.ts",
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  assert.deepEqual(diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const recoveryHelpers = await loadMaterialRecoveryHelpers();

test("material cards only claim states and file sizes that are known", () => {
  assert.equal(helpers.careerMaterialStatusText("ready"), "可使用");
  assert.equal(helpers.careerMaterialStatusText("sent"), "已发送");
  assert.equal(helpers.careerMaterialStatusText("draft"), "编辑中");
  assert.equal(helpers.careerMaterialStatusText("deleting"), "待收尾");
  assert.equal(helpers.careerMaterialStatusText("legacy-unknown"), "状态待确认");
  assert.equal(helpers.careerMaterialFileDetails("resume.pdf", 0), "resume.pdf · 大小未记录");
  assert.equal(helpers.careerMaterialFileDetails("resume.pdf", null), "resume.pdf · 大小未记录");
  assert.equal(helpers.careerMaterialFileDetails("resume.pdf", 512), "resume.pdf · 512 B");
  assert.equal(helpers.careerMaterialFileDetails("resume.pdf", 1536), "resume.pdf · 1.5 KB");
  assert.match(materialsView, /已关联本机原件/);
  assert.doesNotMatch(materialsView, /Math\.max\(1,[\s\S]*?byte_size \?\? 0/);
});

test("material UI writes only through the verifiable save and delete repositories", () => {
  assert.match(saveModal, /saveCareerMaterial\(input, \{/);
  assert.match(saveModal, /onRecoveryPrepared\(prepared\)/);
  assert.match(saveModal, /if \(!rememberRecovery\(ticket\)\) throw new Error/);
  assert.match(saveModal, /inspectCareerMaterialSave\(materialId, expectedRef\.current\)/);
  assert.match(saveModal, /inspectCareerMaterialSaveCleanup\(receiptInput\)/);
  assert.match(saveModal, /retryCareerMaterialSaveCleanup\(cleanupReceipt\)/);
  assert.match(deleteModal, /loadCareerMaterialDeletionState\(material\.id\)/);
  assert.match(deleteModal, /const receipt: CareerMaterialDeletionReceipt/);
  assert.match(deleteModal, /deleteCareerMaterial\(receipt\)/);
  assert.match(deleteModal, /result\.outcome === "changed"/);
  assert.match(deleteModal, /receipt: result\.receipt/);
  for (const forbidden of [/INSERT INTO career_materials/, /DELETE FROM career_materials/, /saveLocalFile\(/, /deleteLocalFile\(/, /window\.confirm/]) {
    assert.doesNotMatch(`${saveModal}\n${deleteModal}`, forbidden);
  }
});

test("one material draft keeps a stable identity and a recovered draft keeps its original time", () => {
  assert.match(saveModal, /const \[materialId\] = useState\(\(\) => initialRecovery\?\.ticket\.kind === "uncertain-save" \? initialRecovery\.ticket\.materialId : newId\("material"\)\)/);
  assert.match(saveModal, /const updatedAtRef = useRef<string \| null>\(initialSnapshot\?\.updatedAt \?\? null\)/);
  assert.match(saveModal, /updatedAtRef\.current \?\?= new Date\(\)\.toISOString\(\)/);
  assert.match(saveModal, /updatedAt: updatedAtRef\.current/);
  assert.doesNotMatch(saveModal, /newId\("material"\)[\s\S]*?async function submit[\s\S]*?newId\("material"\)/);
});

test("an uncertain save can only be inspected and a conflict can only be refreshed", () => {
  const inspectStart = saveModal.indexOf("async function inspectUncertainSave");
  const refreshStart = saveModal.indexOf("async function refreshAfterConflict", inspectStart);
  const inspection = saveModal.slice(inspectStart, refreshStart);
  assert.match(inspection, /inspectCareerMaterialSave/);
  assert.doesNotMatch(inspection, /saveCareerMaterial\(/);
  assert.match(saveModal, /caught instanceof CareerMaterialSaveError && caught\.code === "conflict"/);
  assert.match(saveModal, /const dismissible = phase === "editing" \|\| canPauseRecovery/);
  assert.match(saveModal, /phase === "conflict"[\s\S]*?>重新读取材料列表<\/button>/);
  assert.doesNotMatch(saveModal, /phase === "conflict"\) \{ onClose\(\)/);
  assert.match(saveModal, /phase === "refreshing"[\s\S]*?正在重新读取材料列表/);
});

test("post-write refresh states never expose a silent no-op button", () => {
  assert.match(saveModal, /setPhase\("refreshing"\)[\s\S]*?await onRefresh\(\)/);
  assert.match(saveModal, /catch \{[\s\S]*?setPhase\("refresh-only"\)/);
  assert.match(deleteModal, /setPhase\("refreshing"\)[\s\S]*?await onRefresh\(\)/);
  assert.match(deleteModal, /phase === "refreshing"[\s\S]*?正在重新读取材料状态/);
  assert.match(deleteModal, /phase === "refresh-only"[\s\S]*?>只重新读取<\/button>/);
});

test("closing an uncertain or pending deletion first refreshes the visible list", () => {
  const closeStart = deleteModal.indexOf("async function closeAfterRead");
  const refreshStart = deleteModal.indexOf("async function refreshAfterDeletion", closeStart);
  const close = deleteModal.slice(closeStart, refreshStart);
  assert.ok(close.indexOf("await onRefresh()") < close.indexOf("onClose()"));
  assert.match(close, /setPhase\(returnPhase\)/);
  assert.match(deleteModal, /phase === "loading" \|\| phase === "ready" \? onClose/);
  assert.match(deleteModal, /onClick=\{allowStaleExit \? onStaleClose : \(\) => void closeAfterRead\(\)\}>稍后再核对/);
  assert.match(deleteModal, /onClick=\{allowStaleExit \? onStaleClose : \(\) => void closeAfterRead\(\)\}>回到最新材料列表/);
});

test("deletion copy describes rechecks and final facts without technical blame", () => {
  assert.equal(helpers.materialDeletionSuccessMessage("retained_shared"), "材料记录已移除；同一原件仍被其他版本使用，因此完整保留。");
  assert.equal(helpers.materialDeletionSuccessMessage("removed"), "材料记录与这份本地原件已移除。");
  assert.match(helpers.materialDeletionPendingMessage("file_cleanup_failed"), /等待收尾/);
  assert.doesNotMatch(deleteModal, /材料不会被当作失败|安全清理队列/);
  assert.match(deleteModal, /当前同一原件仍被其他版本使用；移除时会在锁内再次核对/);
  assert.match(deleteModal, /这里只整理你选择的这一份材料，不影响职位、投递或其他版本/);
});

test("deleting rows remain recoverable and never masquerade as usable", () => {
  assert.match(materialsView, /material\.status === "deleting"/);
  assert.match(materialsView, />继续收尾<\/button>/);
  assert.match(materialsView, /原件状态会在继续收尾时核对/);
  assert.doesNotMatch(materialsView, /material\.file_name && cleanupPending/);
  assert.match(source, /item\.status === "deleting" \? " · 等待收尾"/);
  assert.match(source, /请到材料页继续或稍后核对/);
});

test("phase changes, dirty drafts, focus return, and narrow screens remain operable", () => {
  assert.match(source, /function useMaterialPhaseFocus/);
  assert.match(source, /\[data-dialog-initial\]:not\(:disabled\)/);
  assert.match(source, /\[enabled, phase\]/);
  assert.match(source, /window\.addEventListener\("beforeunload", protectMaterialWork\)/);
  assert.match(saveModal, /setCloseConfirm\(true\)/);
  assert.match(saveModal, /closeConfirmReturnRef\.current = document\.activeElement/);
  assert.match(saveModal, /resumeEditingFocusPendingRef\.current = true/);
  assert.match(saveModal, /previous\?\.isConnected[\s\S]*?target\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /\[data-material-recover\][\s\S]*?\[data-material-recovery-clear\][\s\S]*?\[data-material-add\]:not\(:disabled\)/);
  assert.match(source, /opener\?\.isConnected && !opener\.disabled/);
  assert.match(source, /materialStaleFocusPendingRef\.current = true/);
  assert.match(source, /document\.querySelector<HTMLButtonElement>\("\[data-material-refresh\]"\)\?\.focus/);
  assert.match(css, /\.career-material-actions \.career-icon-button \{ width: 44px; height: 44px; \}/);
  assert.match(css, /\.career-material-card h3,[\s\S]*?overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?grid-template-columns: auto minmax\(0, 1fr\)/);
  assert.match(css, /\.career-material-card > \.career-material-actions \{ width: 100%; grid-column: 1 \/ -1/);
});

test("a stale material list has exactly one safe recovery action", () => {
  assert.match(source, /const \[materialListStale, setMaterialListStale\] = useState\(false\)/);
  assert.match(source, /if \(!await refresh\(requestedScope\)\) throw new Error/);
  assert.match(source, /await requireRefresh\(\)[\s\S]*?setMaterialListStale\(false\)/);
  assert.match(materialsView, /stale && <div className="career-material-stale"/);
  assert.match(materialsView, /data-material-refresh/);
  assert.match(materialsView, /disabled=\{stale\}/);
  assert.match(materialsView, /!stale && !recoveryLocked && data\.materials\.length === 0/);
  assert.match(source, /restoreMaterialFocus[\s\S]*?\[data-material-recover\][\s\S]*?\[data-material-add\]:not\(:disabled\)[\s\S]*?\.career-material-actions button:not\(:disabled\)/);
  assert.match(css, /\.career-material-stale \.career-button,[\s\S]*?\.career-material-recovery-banner \.career-button \{ min-height: 44px; \}/);
});

test("material recovery uses independent durable keys and keeps volatile tickets in memory", () => {
  assert.match(source, /const CAREER_MATERIAL_SAVE_RECOVERY_PREFIX = "career\.material-save-recovery\.v1:"/);
  assert.match(source, /const storageKey = `\$\{CAREER_MATERIAL_SAVE_RECOVERY_PREFIX\}\$\{logicalKey\}`/);
  assert.match(source, /window\.localStorage\.setItem\(storageKey, JSON\.stringify\(ticket\)\)/);
  assert.match(source, /key !== `\$\{CAREER_MATERIAL_SAVE_RECOVERY_PREFIX\}\$\{materialSaveRecoveryKey\(parsed\)\}`/);
  assert.match(source, /for \(let index = 0; index < window\.localStorage\.length; index \+= 1\)/);
  assert.match(source, /setVolatileMaterialRecoveries/);
  assert.match(source, /volatileMaterialRecoveries\.length === 0/);
  assert.match(source, /window\.addEventListener\("storage", handleRecoveryStorage\)/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^,]+, JSON\.stringify\([^)]*recoveries/);
});

test("stored recovery tickets require complete snapshots and bounded receipt envelopes", () => {
  const snapshot = {
    name: "产品设计主简历",
    kind: "简历",
    version: "v2",
    updatedAt: "2026-08-21T02:00:00.000Z",
    linkedJobId: null,
    status: "ready",
    notes: "从上次核对线索恢复",
    attachment: null,
  };
  const ticket = {
    version: 1,
    kind: "uncertain-save",
    materialId: "material-stable-id",
    expectedSnapshot: snapshot,
    cleanupReceipt: null,
    recordedAt: "2026-08-21T02:01:00.000Z",
  };
  assert.equal(recoveryHelpers.isMaterialSaveRecoveryTicket(ticket), true);
  assert.equal(recoveryHelpers.isMaterialSaveRecoveryTicket({ ...ticket, expectedSnapshot: {} }), false);
  assert.equal(recoveryHelpers.isMaterialSaveRecoveryTicket({ ...ticket, extra: "unexpected" }), false);
  assert.equal(recoveryHelpers.isMaterialSaveRecoveryTicket({
    version: 1,
    kind: "cleanup-only",
    cleanupReceipt: {
      purpose: "career-material-save-cleanup",
      version: 1,
      opaquePayload: "opaque",
      digest: "broken",
    },
    recordedAt: ticket.recordedAt,
  }), false);
  assert.match(saveModal, /caught instanceof CareerMaterialSaveError && caught\.code === "invalid_cleanup_receipt"[\s\S]*?setPhase\("cleanup-unavailable"\)/);
  assert.match(saveModal, /caught\.code === "invalid_input" \|\| caught\.code === "invalid_cleanup_receipt"[\s\S]*?setPhase\("cleanup-unavailable"\)/);
  assert.match(saveModal, /finishUnavailableRecovery[\s\S]*?forgetRecovery\(ticket\)/);
  assert.match(saveModal, />保留原件并结束提醒<\/button>/);
});

test("a recovered uncertain save restores scalar fields without pretending to restore a File", () => {
  assert.match(saveModal, /const initialSnapshot = initialRecovery\?\.ticket\.kind === "uncertain-save" \? initialRecovery\.ticket\.expectedSnapshot : null/);
  assert.match(saveModal, /useRef<string \| null>\(initialSnapshot\?\.updatedAt \?\? null\)/);
  assert.match(saveModal, /name="name"[\s\S]*?defaultValue=\{initialSnapshot\?\.name \?\? ""\}/);
  assert.match(saveModal, /name="kind" defaultValue=\{initialSnapshot\?\.kind \?\? "简历"\}/);
  assert.match(saveModal, /name="version" defaultValue=\{initialSnapshot\?\.version \?\? "v1\.0"\}/);
  assert.match(saveModal, /name="linked_job_id" defaultValue=\{initialSnapshot\?\.linkedJobId \?\? ""\}/);
  assert.match(saveModal, /name="status" defaultValue=\{initialSnapshot\?\.status \?\? "ready"\}/);
  assert.match(saveModal, /name="notes"[\s\S]*?defaultValue=\{initialSnapshot\?\.notes \?\? ""\}/);
  assert.match(saveModal, /浏览器不会自动重新选取文件/);
  assert.match(saveModal, /setDirty\(true\)[\s\S]*?setPhase\("editing"\)/);
  assert.match(saveModal, /cleanupContinuation === "editing"\) \{[\s\S]*?setDirty\(true\)[\s\S]*?setPhase\("editing"\)/);
});

test("uncertain saves resolve before cleanup and never reopen a conflicting stable id", () => {
  const inspectStart = saveModal.indexOf("async function inspectUncertainSave");
  const inspectEnd = saveModal.indexOf("async function refreshAfterConflict", inspectStart);
  const inspection = saveModal.slice(inspectStart, inspectEnd);
  assert.match(inspection, /inspection === "exact_saved"[\s\S]*?forgetRecovery\(\)[\s\S]*?refreshAfterSave/);
  assert.match(inspection, /inspection === "absent"[\s\S]*?setCleanupContinuation\("editing"\)[\s\S]*?setPhase\("cleanup-review"\)/);
  assert.match(inspection, /inspection === "conflict"[\s\S]*?setCleanupContinuation\("refresh"\)[\s\S]*?setPhase\("cleanup-review"\)/);
  assert.match(saveModal, /cleanupContinuation === "editing"/);
  assert.match(saveModal, /另一份材料还在等待核对；你可以先查看或复制当前内容/);
  assert.match(saveModal, /else \{\s*setDirty\(false\);\s*await refreshAfterRecovery\(\)/);
});

test("recovery banners pause new writes without blocking an existing attachment download", () => {
  assert.match(materialsView, /const actionsLocked = stale \|\| recoveryLocked/);
  assert.match(materialsView, /data-material-add disabled=\{actionsLocked\}/);
  assert.match(materialsView, /data-material-recover/);
  assert.match(materialsView, /className="career-icon-button" disabled=\{stale\}/);
  assert.match(materialsView, /className="career-icon-button danger" disabled=\{actionsLocked\}/);
  assert.match(materialsView, /有材料保存需要继续核对/);
});

test("unknown deletion failures become check-only outcomes instead of reusable confirmations", () => {
  assert.match(source, /CareerMaterialDeletionError/);
  assert.match(deleteModal, /caught instanceof CareerMaterialDeletionError && \(caught\.code === "inspect_failed" \|\| caught\.code === "mark_failed"\)/);
  assert.match(deleteModal, /caught\.code === "invalid_receipt"[\s\S]*?setPhase\("changed"\)/);
  assert.match(deleteModal, /else \{\s*setPhase\("uncertain"\)[\s\S]*?不要复用刚才的确认再次删除/);
});
