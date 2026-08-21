import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/career/CareerApp.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/career/career.css", import.meta.url), "utf8");

function slice(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `missing source slice ${start}`);
  return source.slice(startIndex, endIndex);
}

function loadInspectionDecision() {
  const helper = slice("function careerContactInspectionDecision", "function careerContactExpectedState");
  const compiled = ts.transpileModule(
    `${helper}\nmodule.exports = { careerContactInspectionDecision };`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const sandboxModule = { exports: {} };
  Function("module", "exports", compiled)(sandboxModule, sandboxModule.exports);
  return sandboxModule.exports.careerContactInspectionDecision;
}

test("write inspection decisions never turn unknown or conflict into a retry", () => {
  const decide = loadInspectionDecision();
  assert.equal(decide("exact_saved"), "refresh");
  assert.equal(decide("absent"), "retry-same-command");
  assert.equal(decide("conflict"), "block");
  assert.equal(decide("still_unknown"), "inspect-only");
});

test("a failed contact list read never becomes a believable empty archive", () => {
  const contactsView = slice("function ContactsView", "function careerMaterialStatusText");
  assert.match(contactsView, /!loading && !readError && contacts\.length === 0/);
  assert.match(contactsView, /已有资料不会因此变成空记录/);
});

test("contact UI uses only safe writes and exact CAS state", () => {
  const contactUi = slice("type CareerContactCommandPhase", "type CareerMaterialSavePhase");
  assert.doesNotMatch(source, /\b(?:archiveCareerContact|restoreCareerContact|createCareerContact|updateCareerContact|recordCareerContactInteraction)\b/);
  for (const api of [
    "createCareerContactSafely",
    "recordCareerContactInteractionSafely",
    "createCareerContactTaskSafely",
    "updateCareerContactSafely",
    "archiveCareerContactSafely",
    "restoreCareerContactSafely",
    "loadCareerContactExpectedState",
    "inspectCareerContactWrite",
  ]) assert.match(contactUi, new RegExp(`\\b${api}\\b`));
  assert.match(contactUi, /careerContactExpectedState\(detail\)/);
});

test("create, interaction, and task commands keep mount-stable identity", () => {
  const editor = slice("function ContactModal", "function ContactInteractionModal");
  const interaction = slice("function ContactInteractionModal", "function ContactTaskModal");
  const task = slice("function ContactTaskModal", "type CareerMaterialSavePhase");
  assert.match(editor, /useState\(\(\) => newId\("contact"\)\)/);
  assert.match(interaction, /useState\(\(\) => newId\("interaction"\)\)/);
  assert.match(interaction, /useState\(\(\) => newId\("task"\)\)/);
  assert.match(task, /useState\(\(\) => newId\("task"\)\)/);
  for (const modal of [editor, interaction, task]) {
    assert.match(modal, /useState\(\(\) => new Date\(\)\.toISOString\(\)\)/);
    assert.match(modal, /if \([^\n]*writeRef\.current\) return/);
    assert.match(modal, /commandRef\.current = command/);
  }
});

test("uncertain writes inspect the same receipt and only absent can reopen the same command", () => {
  for (const modal of [
    slice("function ContactModal", "function ContactInteractionModal"),
    slice("function ContactInteractionModal", "function ContactTaskModal"),
    slice("function ContactTaskModal", "type CareerMaterialSavePhase"),
  ]) {
    assert.match(modal, /setReceipt\(result\.receipt\)[\s\S]*setPhase\("uncertain"\)/);
    assert.match(modal, /inspectCareerContactWrite\(receipt\)/);
    assert.match(modal, /decision === "retry-same-command"[\s\S]*setPhase\("editing"\)/);
    assert.match(modal, /decision === "block"[\s\S]*setPhase\("blocked"\)/);
    assert.match(modal, /decision === "refresh"[\s\S]*await refreshOnly/);
  }
});

test("saved and changed writes enter refresh-only paths instead of resubmitting", () => {
  const editor = slice("function ContactModal", "function ContactInteractionModal");
  const drawer = slice("function ContactDrawer", "function JobModal");
  assert.match(editor, /result\.outcome === "changed" \|\| result\.outcome === "outcome_uncertain"[\s\S]*setPhase\("refresh-only"\)/);
  assert.match(editor, /await onRefresh\(\)[\s\S]*onSaved\(id\)/);
  assert.doesNotMatch(editor, /onSaved\(id\)[\s\S]*await onRefresh\(\)/);
  assert.match(drawer, /result\.outcome === "changed"[\s\S]*setPhase\("refresh-only"\)/);
  assert.match(drawer, /result\.outcome === "outcome_uncertain"[\s\S]*setPhase\("refresh-only"\)/);
  assert.match(drawer, /refreshArchiveResult[\s\S]*await onRefresh\(\)[\s\S]*loadCareerContactExpectedState/);
});

test("dirty forms guard close button, Escape, and scrim through one close request", () => {
  for (const modal of [
    slice("function ContactModal", "function ContactInteractionModal"),
    slice("function ContactInteractionModal", "function ContactTaskModal"),
    slice("function ContactTaskModal", "type CareerMaterialSavePhase"),
  ]) {
    assert.match(modal, /function requestClose\(\)[\s\S]*if \(locked\) return;[\s\S]*setDiscardPrompt\(true\)/);
    assert.match(modal, /<Modal[\s\S]*onClose=\{requestClose\}/);
    assert.match(modal, /<form[^>]*onChange=\{\(\) => setDirty\(true\)\}/);
    assert.match(modal, /<form hidden=\{phase !== "editing" \|\| discardPrompt\}/);
    assert.match(modal, /<ContactDiscardPrompt/);
    assert.match(modal, /useCareerContactWorkProtection\(dirty \|\| locked\)/);
  }
  const focusHelper = slice("function useCareerContactPhaseFocus", "function ContactWriteStatus");
  assert.match(focusHelper, /previousSecondaryRef\.current && !secondary/);
  assert.match(focusHelper, /returningToForm \? root\.querySelector<HTMLElement>\("input:not\(\[disabled\]\), textarea:not\(\[disabled\]\), select:not\(\[disabled\]\)"\)/);
});

test("failed reads cannot render writable edit, interaction, or task forms", () => {
  const editor = slice("function ContactModal", "function ContactInteractionModal");
  const interaction = slice("function ContactInteractionModal", "function ContactTaskModal");
  const task = slice("function ContactTaskModal", "type CareerMaterialSavePhase");
  assert.match(editor, /contactId && \(!detail \|\| readError\)/);
  assert.match(interaction, /if \(!detail \|\| readError\) return/);
  assert.match(task, /if \(!detail \|\| readError\) return/);
  assert.match(editor, /未知内容当成空表单/);
  assert.match(interaction, /未知内容写成一次真实联系/);
  assert.match(task, /未知内容写成一条真实待办/);
});

test("editing preserves linked ended and archived jobs", () => {
  const editor = slice("function ContactModal", "function ContactInteractionModal");
  assert.match(editor, /\.\.\.\(detail\?\.jobs \?\? \[\]\), \.\.\.data\.jobs/);
  assert.match(editor, /job\.archived === 1 \? "已归档" : stage\?\.is_terminal \? "已结束" : "进行中"/);
  assert.match(editor, /defaultChecked=\{linked\.has\(job\.id\)\}/);
});

test("real interaction facts are explicit and legacy timestamps are not shown", () => {
  const interaction = slice("function ContactInteractionModal", "function ContactTaskModal");
  const drawer = slice("function ContactDrawer", "function JobModal");
  assert.match(interaction, /<select name="direction" required defaultValue="">/);
  assert.match(interaction, /<option value="" disabled>请选择<\/option>/);
  assert.match(interaction, /<select name="channel" defaultValue="">/);
  assert.doesNotMatch(interaction, /defaultValue="mutual"|defaultValue=\{contact\?\.channel/);
  assert.doesNotMatch(drawer, /contact\.(?:next_follow_up|last_contact_at)/);
  assert.doesNotMatch(drawer, /career-contact-legacy/);
});

test("archive is explicit about retained tasks and undo uses stable CAS plus read-only recovery", () => {
  const drawer = slice("function ContactDrawer", "function JobModal");
  const root = slice("export default function CareerApp", "function CareerLoading");
  assert.match(drawer, /已经安排的待办仍会出现在“今日”和日历，不会被取消/);
  assert.match(drawer, /onClick=\{\(\) => archived \? void changeArchive\(false\) : setPhase\("confirm-archive"\)\}/);
  assert.match(root, /restoreCareerContactSafely\(ticket\.id, ticket\.expected\)/);
  assert.match(root, /ticket\.phase === "refresh-only"[\s\S]*loadCareerContactExpectedState/);
  assert.match(root, /rememberContactRemovalFocus\(contact\.id\)/);
});

test("cross-tab and focus signals only refresh or warn", () => {
  const root = slice("export default function CareerApp", "function CareerLoading");
  assert.match(root, /subscribeToCareerDataChanges/);
  assert.match(root, /window\.addEventListener\("focus", refreshVisibleContactsOnFocus\)/);
  assert.match(root, /setContactDataHint\("联系人资料刚在另一个页面发生了变化/);
  const signalSlice = slice("useEffect(() => subscribeToCareerDataChanges", "function refreshVisibleContactsOnFocus");
  assert.doesNotMatch(signalSlice, /Safely\(/);
});

test("contact controls remain generous and narrow layouts cannot force horizontal overflow", () => {
  assert.match(css, /\.career-contact-modal-phase,[\s\S]*?min-width: 0;[\s\S]*?overflow-wrap: anywhere/);
  assert.match(css, /\.career-contact-modal-phase \.career-field input,[\s\S]*?min-height: 44px/);
  assert.match(css, /\.career-contact-modal-phase \.career-button,[\s\S]*?min-height: 44px/);
  assert.match(css, /\.career-view:has\(> \.career-contact-grid\) > \.career-segmented button,[\s\S]*?min-height: 44px/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.career-contact-modal-phase \.career-form-actions \{ display: grid; grid-template-columns: minmax\(0, 1fr\); \}/);
});
