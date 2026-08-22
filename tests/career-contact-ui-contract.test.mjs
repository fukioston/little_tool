import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/career/CareerApp.tsx", import.meta.url), "utf8");
const flow = await readFile(new URL("../app/career/CareerContactImportMaterialWriteFlow.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/career/career.css", import.meta.url), "utf8");

function slice(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `missing source slice ${start}`);
  return source.slice(startIndex, endIndex);
}

test("a failed contact list read never becomes a believable empty archive", () => {
  const contactsView = slice("function ContactsView", "function careerMaterialStatusText");
  assert.match(contactsView, /!loading && !readError && contacts\.length === 0/);
  assert.match(contactsView, /已有资料不会因此变成空记录/);
});

test("every contact mutation routes through the unified durable Flow", () => {
  for (const method of [
    "submitContactCreate", "submitContactUpdate", "submitContactInteraction",
    "submitContactTask", "submitContactArchive", "submitContactRestore",
  ]) assert.match(source, new RegExp(`writes\\.${method}\\b`));
  assert.doesNotMatch(source, /\b(?:createCareerContactSafely|updateCareerContactSafely|archiveCareerContactSafely|restoreCareerContactSafely|recordCareerContactInteractionSafely|createCareerContactTaskSafely)\b/);
  assert.match(flow, /inspectCareerContactImportMaterialWrite/);
  assert.match(flow, /lease\.checkpoint\(prepared\.receipt\)/);
  assert.match(flow, /const finish = useCallback/);
});

test("create, interaction, and task commands keep mount-stable identity", () => {
  const editor = slice("function ContactModal", "function ContactInteractionModal");
  const interaction = slice("function ContactInteractionModal", "function ContactTaskModal");
  const task = slice("function ContactTaskModal", "function MaterialModal");
  assert.match(editor, /useState\(\(\) => newId\("contact"\)\)/);
  assert.match(interaction, /useState\(\(\) => newId\("interaction"\)\)/);
  assert.match(interaction, /useState\(\(\) => new Date\(\)\.toISOString\(\)\)/);
  assert.match(task, /useState\(\(\) => newId\("task"\)\)/);
  assert.match(task, /useState\(\(\) => new Date\(\)\.toISOString\(\)\)/);
});

test("dirty contact forms and failed reads stay explicit", () => {
  for (const modal of [
    slice("function ContactModal", "function ContactInteractionModal"),
    slice("function ContactInteractionModal", "function ContactTaskModal"),
    slice("function ContactTaskModal", "function MaterialModal"),
  ]) {
    assert.match(modal, /function requestClose\(\)[\s\S]*if \(locked\) return;[\s\S]*setDiscardPrompt\(true\)/);
    assert.match(modal, /onClose=\{requestClose\}/);
    assert.match(modal, /onChange=\{\(\) => setDirty\(true\)\}/);
    assert.match(modal, /<ContactDiscardPrompt/);
  }
  const editor = slice("function ContactModal", "function ContactInteractionModal");
  assert.match(editor, /contactId && \(!detail \|\| readError\)/);
  assert.match(editor, /未知内容当成空表单/);
});

test("contact relationships and interaction facts stay explicit", () => {
  const editor = slice("function ContactModal", "function ContactInteractionModal");
  const interaction = slice("function ContactInteractionModal", "function ContactTaskModal");
  assert.match(editor, /job\.archived === 1 \? "已归档" : stage\?\.is_terminal \? "已结束" : "进行中"/);
  assert.match(editor, /defaultChecked=\{linked\.has\(job\.id\)\}/);
  assert.match(interaction, /<select name="direction" required defaultValue="">/);
  assert.match(interaction, /<option value="" disabled>请选择<\/option>/);
  assert.doesNotMatch(interaction, /defaultValue="mutual"/);
});

test("archive and undo keep history while using the same durable writer", () => {
  const drawer = slice("function ContactDrawer", "function JobModal");
  const root = slice("export default function CareerApp", "function CareerLoading");
  assert.match(drawer, /已经安排的待办仍会出现在“今日”和日历，不会被取消/);
  assert.match(drawer, /writes\.submitContactArchive/);
  assert.match(drawer, /writes\.submitContactRestore/);
  assert.match(root, /handleContactUndo/);
  assert.match(root, /contactImportMaterialWrites\.submitContactRestore/);
  assert.match(root, /ticket\.phase === "refresh-only"/);
});

test("cross-tab signals refresh through the root recovery barrier", () => {
  const root = slice("export default function CareerApp", "function CareerLoading");
  assert.match(root, /subscribeToCareerDataChanges/);
  assert.match(root, /careerContactImportMaterialReadApplyDecision/);
  assert.match(root, /reason === "career-job-imported"/);
  assert.match(root, /reason === "career-material-saved"/);
  assert.match(root, /contactImportMaterialDirtyEditorsRef/);
  assert.match(root, /setContactDataHint/);
});

test("contact controls remain operable at 319px", () => {
  assert.match(css, /\.career-contact-modal-phase,[\s\S]*?min-width: 0;[\s\S]*?overflow-wrap: anywhere/);
  assert.match(css, /\.career-contact-modal-phase \.career-field input,[\s\S]*?min-height: 44px/);
  assert.match(css, /\.career-contact-modal-phase \.career-button,[\s\S]*?min-height: 44px/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.career-contact-modal-phase \.career-form-actions \{ display: grid; grid-template-columns: minmax\(0, 1fr\); \}/);
});
