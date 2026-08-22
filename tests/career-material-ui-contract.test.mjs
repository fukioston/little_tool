import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/career/CareerApp.tsx", import.meta.url), "utf8");
const flow = await readFile(new URL("../app/career/CareerContactImportMaterialWriteFlow.tsx", import.meta.url), "utf8");
const journal = await readFile(new URL("../app/career/contact-import-material-write-journal.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../app/career/career.css", import.meta.url), "utf8");

function slice(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `missing source slice ${start}`);
  return source.slice(startIndex, endIndex);
}

const materialsView = slice("function careerMaterialStatusText", "function AnalyticsView");
const saveModal = slice("function MaterialModal", "function MaterialDeletionModal");
const deleteModal = slice("function MaterialDeletionModal", "type CareerImportMode");

test("material cards show only known public attachment facts", () => {
  assert.match(materialsView, /status === "ready"/);
  assert.match(materialsView, /status === "sent"/);
  assert.match(materialsView, /status === "draft"/);
  assert.match(materialsView, /has_attachment/);
  assert.match(materialsView, /已关联本机原件/);
  assert.match(materialsView, /openCareerMaterialAttachmentById\(materialId\)/);
  assert.doesNotMatch(source, /\bfile_key\b|createLocalFileObjectUrl|opaquePayload/);
});

test("material save and delete route only through the unified durable Flow", () => {
  assert.match(saveModal, /writes\.submitMaterialSave\(/);
  assert.match(deleteModal, /writes\.submitMaterialDelete\(/);
  assert.doesNotMatch(source, /\b(?:saveCareerMaterial|deleteCareerMaterial|retryCareerMaterialSaveCleanup)\(/);
  assert.match(flow, /prepareCareerMaterialSaveWrite/);
  assert.match(flow, /prepareCareerMaterialDeleteWriteForUi/);
  assert.match(flow, /inspectCareerContactImportMaterialWrite/);
});

test("attachment cleanup is durable before bytes and promoted in one outer lease", () => {
  assert.match(flow, /prepareCareerMaterialSaveWrite[\s\S]*onCleanupPrepared\(prepared\)[\s\S]*lease\.checkpointCleanup\(prepared\)/);
  assert.match(flow, /if \(prepared\.cleanupCheckpointed\)[\s\S]*lease\.promote\(prepared\.receipt\)/);
  assert.match(journal, /CAREER_CORE_WRITE_JOURNAL_LOCK/);
  assert.match(journal, /checkpointCleanup\(/);
  assert.match(journal, /promote\(/);
  assert.match(journal, /Raw-CAS replace/);
});

test("material drafts and deletion confirmations retain explicit user control", () => {
  assert.match(saveModal, /onDirtyChange\(dirty \|\| writing\)/);
  assert.match(saveModal, /if \(dirty\) \{[\s\S]*setCloseConfirm\(true\)/);
  assert.match(saveModal, /附件超过 512 MB；没有开始保存/);
  assert.match(saveModal, /title="放弃这份材料草稿吗？"/);
  assert.match(deleteModal, /title=\{"移除「" \+ material\.name \+ "」？"\}/);
  assert.match(deleteModal, /材料与附件保持不变/);
});

test("material recovery remains inspectable and never silently replays a write", () => {
  assert.match(flow, /entry\.ticket\.kind === "material-cleanup"/);
  assert.match(flow, /inspectCareerMaterialFileCleanup/);
  assert.match(flow, /retryCareerMaterialFileCleanup/);
  assert.match(flow, /flow\.phase === "refresh-only"/);
  assert.match(source, /继续核对与收尾/);
  assert.match(source, /只重新读取/);
});

test("stale and unreadable material state blocks new writes but keeps recovery visible", () => {
  assert.match(materialsView, /材料列表需要重新读取/);
  assert.match(materialsView, /有一条旧的收尾线索无法验证/);
  assert.match(materialsView, /暂时无法读取附件收尾记录/);
  assert.match(materialsView, /disabled=\{newActionsLocked\}/);
  assert.match(materialsView, /data-material-recover/);
  assert.match(materialsView, /data-material-recovery-clear/);
});

test("material controls and recovery layouts remain operable at 319px", () => {
  assert.match(css, /\.career-material-card[\s\S]*?min-width: 0/);
  assert.match(css, /\.career-material-recovery-banner[\s\S]*?overflow-wrap: anywhere/);
  assert.match(css, /\.career-material-recovery-banner \.career-button[\s\S]*?min-height: 44px/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.career-material-recovery-banner/);
});
