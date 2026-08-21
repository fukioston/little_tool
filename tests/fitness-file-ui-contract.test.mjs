import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [panels, app, css, journal] = await Promise.all([
  readFile(new URL("../app/fitness/data-panels.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/fitness/FitnessApp.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/fitness/fitness.css", import.meta.url), "utf8"),
  readFile(new URL("../app/fitness/file-operation-journal.ts", import.meta.url), "utf8"),
]);

const photos = panels.slice(
  panels.indexOf("export function EquipmentPhotos"),
  panels.indexOf("export function FitnessDataControls"),
);

test("photo mutations use durable receipt APIs and never use the legacy one-shot path", () => {
  assert.match(photos, /prepareFitnessFileSave/);
  assert.match(photos, /saveFitnessFileSafely/);
  assert.match(photos, /prepareFitnessFileDelete/);
  assert.match(photos, /deleteFitnessFileSafely/);
  assert.doesNotMatch(photos, /\bsaveFitnessFile\(/);
  assert.doesNotMatch(photos, /\bdeleteFitnessFile\(/);
  assert.doesNotMatch(photos, /window\.confirm/);

  const saveCheckpoint = photos.indexOf("persistFitnessFileOperation(createFitnessFileSaveTicket(receipt))");
  const safeSave = photos.indexOf("saveFitnessFileSafely(inputValue, receipt)", saveCheckpoint);
  const deleteCheckpoint = photos.indexOf("persistFitnessFileOperation(createFitnessFileDeleteTicket(receipt))");
  const safeDelete = photos.indexOf("deleteFitnessFileSafely(receipt)", deleteCheckpoint);
  assert.ok(saveCheckpoint >= 0 && saveCheckpoint < safeSave);
  assert.ok(deleteCheckpoint >= 0 && deleteCheckpoint < safeDelete);
});

test("response-loss inspection, explicit continuation, discard, and refresh stay separate", () => {
  const inspectStart = photos.indexOf("const inspectRecovery");
  const resumeStart = photos.indexOf("const resumeSave", inspectStart);
  const inspection = photos.slice(inspectStart, resumeStart);
  assert.match(inspection, /inspectFitnessFileSave/);
  assert.match(inspection, /inspectFitnessFileDelete/);
  assert.doesNotMatch(inspection, /saveFitnessFileSafely|resumeFitnessFileSave|discardFitnessFileSave|deleteFitnessFileSafely/);

  const refreshStart = photos.indexOf("const finishCommitted");
  const refreshEnd = photos.indexOf("const refreshVisible", refreshStart);
  const refresh = photos.slice(refreshStart, refreshEnd);
  assert.match(refresh, /await load\(\)/);
  assert.match(refresh, /await onChanged\(\)/);
  assert.match(refresh, /removeFitnessFileOperation/);
  assert.doesNotMatch(refresh, /saveFitnessFileSafely|resumeFitnessFileSave|discardFitnessFileSave|deleteFitnessFileSafely/);
  assert.match(photos, />只重新读取<\/button>/);
});

test("journal keeps independent exact keys and cross-tab events only reload tickets", () => {
  assert.match(journal, /fitness\.file-operation\.v1:/);
  assert.match(journal, /manager\.request\(`fitness-file-journal:/);
  assert.match(journal, /storage\.getItem\(entry\.storageKey\) !== entry\.raw/);
  assert.match(journal, /isFitnessFileSaveReceipt/);
  assert.match(journal, /isFitnessFileDeleteReceipt/);
  assert.match(journal, /FITNESS_FILE_OPERATION_MAX_BYTES/);
  const storageStart = photos.indexOf("const onStorage");
  const storageEnd = photos.indexOf("window.addEventListener", storageStart);
  const storageHandler = photos.slice(storageStart, storageEnd);
  assert.match(storageHandler, /reloadJournal/);
  assert.doesNotMatch(storageHandler, /inspectFitness|saveFitness|deleteFitness|resumeFitness|discardFitness/);
  assert.match(photos, /暂时无法安全协调附件操作/);
  assert.match(photos, /保留内容并清除提醒/);
});

test("durable success and stale rendering do not masquerade as write failure", () => {
  assert.match(photos, /照片已经保存并关联到这件器材/);
  assert.match(photos, /页面暂时没有重新读到最新状态；只需重新读取/);
  assert.match(photos, /actionsLocked = loading \|\| stale/);
  assert.match(photos, /旧列表仍保留，没有据此重复改动/);
  assert.match(photos, /preview\.url \? <a className="sl-file-preview"/);
  assert.match(panels, /preview\.url\) return "原件已核对"/);
  const finishStart = photos.indexOf("const finishCommitted");
  const finishEnd = photos.indexOf("const refreshVisible", finishStart);
  const finish = photos.slice(finishStart, finishEnd);
  assert.match(finish, /phase: "refresh-only"/);
  assert.match(finish, /phase: "reminder-only"/);
  assert.match(finish, /setStale\(false\)[\s\S]*?phase: "reminder-only"/);
  assert.match(photos, />只收起核对提醒<\/button>/);
});

test("same-tab entry points claim synchronously and cross-tab mutation runs inside exact ticket lock", () => {
  assert.match(photos, /const operationRef = useRef<FitnessFileOperationToken \| null>\(null\)/);
  for (const name of ["add", "remove", "inspectRecovery", "resumeSave", "discardSave", "continueDelete"]) {
    const start = photos.indexOf(`const ${name}`);
    const end = photos.indexOf("\n  const ", start + 8);
    const handler = photos.slice(start, end);
    assert.match(handler, /claimOperation\(/, `${name} must synchronously claim the local operation slot`);
  }
  const runnerStart = journal.indexOf("export async function runWithCurrentFitnessFileOperation");
  const runner = journal.slice(runnerStart);
  assert.match(runner, /storage\.getItem\(entry\.storageKey\) !== entry\.raw[\s\S]*?const value = await operation\(lease\)/);
  assert.match(runner, /committed\(\)[\s\S]*?replaceFitnessFileOperationInStorage/);
  assert.match(runner, /remove\(\)[\s\S]*?removeFitnessFileOperationFromStorage/);
});

test("missing Web Locks disables mutations instead of silently weakening CAS", () => {
  assert.match(journal, /if \(!locks\) \{[\s\S]*?throw new Error\("当前浏览器无法跨页面锁定附件核对线索；没有继续改动。"\)/);
  assert.doesNotMatch(journal, /if \(manager\)[\s\S]*?return manager\.request[\s\S]*?return operation\(\)/);
  assert.match(photos, /暂时无法安全协调附件操作/);
  assert.match(photos, /新保存与移除先停用；已核对的现有照片仍可打开/);
});

test("the equipment form remains mounted while its photo subpanel is open", () => {
  assert.doesNotMatch(app, /"equipment-photos"/);
  assert.match(app, /<div hidden=\{equipmentPanel !== "details"\}>[\s\S]*?<EquipmentForm/);
  assert.match(app, /equipmentPanel === "photos" && equipmentPhotoTarget && <EquipmentPhotos/);
  assert.match(app, /busy=\{dialogMutationBusy \|\| equipmentPhotoBusy\}/);
  assert.match(app, /requestEquipmentDialogClose/);
  assert.match(app, /equipmentPanelRef\.current === "photos"/);
  assert.match(app, /equipmentPhotoBusyRef\.current/);
  assert.match(app, /equipmentPhotoOpener\.current\?\.focus/);
  assert.match(photos, /window\.addEventListener\("beforeunload"/);
});

test("all valid and damaged tickets have a global user-triggered recovery route", () => {
  assert.match(app, /readFitnessFileOperationJournal\(\)/);
  assert.match(app, /有 \$\{fileJournal\.entries\.length\} 条照片操作待核对/);
  assert.match(app, /openFitnessFileRecovery\(fileJournal\.entries\[0\]\)/);
  assert.match(app, /entry\?\.ticket\.receipt\.expectedRow\.entity_id/);
  assert.match(app, /knownEquipment\?\.name \?\? \(entry \? "已不在当前器材清单的记录"/);
  assert.match(app, /recoveryOnly: true/);
  assert.match(app, /fileJournal\.unreadable\.length > 0[\s\S]*?openFitnessFileRecovery\(\)/);
  assert.match(app, /!equipmentPhotoTarget\?\.recoveryOnly && \(venue/);
  assert.match(app, /equipmentPanel === "photos" && equipmentPhotoTarget && <EquipmentPhotos/);
  assert.match(photos, /这里只处理已留下的核对线索，不会新增照片/);
  assert.match(photos, /!recoveryOnly && <div className=\{`sl-file-actions/);
  assert.match(app, /ref=\{globalFileRecoveryAction\}/);
  assert.match(app, /shouldReturnToFileRecovery[\s\S]*?globalFileRecoveryAction\.current[\s\S]*?recoveryAction\.focus/);

  const globalStorageStart = app.indexOf("const onStorage = (event: StorageEvent)");
  const globalStorageEnd = app.indexOf("window.addEventListener", globalStorageStart);
  const globalStorage = app.slice(globalStorageStart, globalStorageEnd);
  assert.match(globalStorage, /reloadFileJournal/);
  assert.doesNotMatch(globalStorage, /inspectFitness|saveFitness|deleteFitness|resumeFitness|discardFitness|\.focus/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.sl-global-file-recovery \{[\s\S]*?grid-template-columns: 1fr/);
});

test("origin, byte size, byte verification, long names, and 319px controls remain truthful", () => {
  assert.match(photos, /当前完整网址[\s\S]*?当前浏览器资料（profile）/);
  assert.match(photos, /两者任一不同，看到的就不是同一套照片/);
  assert.match(photos, /formatFitnessFileByteSize\(preview\.record\.byte_size\)/);
  assert.doesNotMatch(photos, /Math\.max\(1,[\s\S]*?byte_size/);
  assert.match(photos, /getFitnessFileBlob/);
  assert.match(panels, /原件已核对/);
  assert.match(css, /\.sl-file-grid footer b,[\s\S]*?overflow-wrap: anywhere/);
  assert.match(css, /\.sl-file-actions[\s\S]*?min-height: 52px/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.sl-file-recovery,[\s\S]*?grid-template-columns: 1fr/);
  assert.match(css, /\.shilian button \{[\s\S]*?min-height: 44px/);
  assert.match(css, /\.sl-dialog > header h2 \{[\s\S]*?overflow-wrap: anywhere/);
});

test("focus follows user actions without cross-tab focus theft", () => {
  assert.match(photos, /activeRecovery \|\| journal\.unavailable \|\| journal\.unreadable\.length > 0 \|\| stale[\s\S]*?recoveryAction\.current[\s\S]*?input\.current/);
  assert.match(photos, /keepPhoto\.current\?\.focus/);
  assert.match(photos, /deleteOpener\.current\?\.focus/);
  assert.match(photos, /statusHeading\.current\?\.focus/);
  assert.match(photos, /workingWasActive\.current && !working/);
  const storageStart = photos.indexOf("const onStorage");
  const storageEnd = photos.indexOf("window.addEventListener", storageStart);
  assert.doesNotMatch(photos.slice(storageStart, storageEnd), /\.focus/);
});
