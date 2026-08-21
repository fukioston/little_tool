import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const sourceUrl = new URL("../app/fitness/forms.tsx", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const dialogHookSourceUrl = new URL("../app/fitness/useFitnessDialog.ts", import.meta.url);
const dialogHookSource = await readFile(dialogHookSourceUrl, "utf8");

async function loadPureFormHelpers() {
  const sourceFile = ts.createSourceFile(
    sourceUrl.pathname,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  const wanted = new Set([
    "applyEquipmentTemplateSuggestion",
    "clearOwnedFormError",
    "createEquipmentIdentityDraft",
    "createFormBusyController",
    "isActiveConstraintScopeMissing",
    "parseEquipmentLoadText",
    "resolveVenueVerificationTimestamp",
    "runReportedFormPersistence",
    "suggestedEquipmentQuantity",
    "updateEquipmentIdentityDraft",
  ]);
  const helpers = sourceFile.statements
    .filter(
      (statement) => ts.isFunctionDeclaration(statement) &&
        statement.name && wanted.has(statement.name.text),
    )
    .map((statement) => statement.getText(sourceFile))
    .join("\n");
  assert.equal((helpers.match(/export function/g) ?? []).length, wanted.size);

  const { outputText, diagnostics = [] } = ts.transpileModule(helpers, {
    fileName: "fitness-form-helpers.ts",
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  assert.deepEqual(
    diagnostics.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

async function loadPureDialogHelpers() {
  const sourceFile = ts.createSourceFile(
    dialogHookSourceUrl.pathname,
    dialogHookSource,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const helper = sourceFile.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "resolveFitnessDialogTabDestination",
  );
  assert.ok(helper);
  const { outputText, diagnostics = [] } = ts.transpileModule(helper.getText(sourceFile), {
    fileName: "fitness-dialog-helper.ts",
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  assert.deepEqual(
    diagnostics.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const {
  applyEquipmentTemplateSuggestion,
  clearOwnedFormError,
  createEquipmentIdentityDraft,
  createFormBusyController,
  isActiveConstraintScopeMissing,
  parseEquipmentLoadText,
  resolveVenueVerificationTimestamp,
  runReportedFormPersistence,
  suggestedEquipmentQuantity,
  updateEquipmentIdentityDraft,
} = await loadPureFormHelpers();
const { resolveFitnessDialogTabDestination } = await loadPureDialogHelpers();

test("dialog Tab routing contains focus even after the active control becomes disabled", () => {
  assert.equal(resolveFitnessDialogTabDestination(0, -1, false), "dialog");
  assert.equal(resolveFitnessDialogTabDestination(3, -1, false), "first");
  assert.equal(resolveFitnessDialogTabDestination(3, -1, true), "last");
  assert.equal(resolveFitnessDialogTabDestination(3, 0, true), "last");
  assert.equal(resolveFitnessDialogTabDestination(3, 2, false), "first");
  assert.equal(resolveFitnessDialogTabDestination(3, 0, false), null);
  assert.equal(resolveFitnessDialogTabDestination(3, 1, false), null);
  assert.equal(resolveFitnessDialogTabDestination(3, 2, true), null);
});

test("Fitness dialog and persistent forms expose a complete busy accessibility contract", () => {
  assert.match(source, /busy = false,/);
  assert.match(source, /busy\?: boolean;/);
  assert.match(source, /className="sl-scrim" tabIndex=\{-1\} aria-hidden="true" disabled=\{busy\}/);
  assert.match(source, /role="dialog" aria-modal="true" aria-busy=\{busy\}/);
  assert.match(source, /data-dialog-close disabled=\{busy\}/);
  assert.equal(
    (source.match(/<button type="button" disabled=\{busy\} onClick=\{onClose\}>取消<\/button>/g) ?? []).length,
    4,
  );
  assert.equal((source.match(/<FormBusyStatus busy=\{busy\} \/>/g) ?? []).length, 4);
  assert.match(source, /className="sl-visually-hidden" role="status">正在保存，请稍候。/);

  assert.match(dialogHookSource, /resolveFitnessDialogTabDestination\(candidates\.length, activeIndex, event\.shiftKey\)/);
  assert.match(dialogHookSource, /document\.addEventListener\("focusin", focusin, true\)/);
  assert.match(dialogHookSource, /document\.removeEventListener\("focusin", focusin, true\)/);
  const focusinStart = dialogHookSource.indexOf("const focusin =");
  const listenerStart = dialogHookSource.indexOf('document.addEventListener("keydown"', focusinStart);
  assert.doesNotMatch(
    dialogHookSource.slice(focusinStart, listenerStart),
    /preventDefault/,
    "focus containment must not swallow the pointer click that opened or closed a surface",
  );
});

test("form busy lifecycle is synchronous, deduplicated, and ignores stale settles", () => {
  const reports = [];
  const controller = createFormBusyController((busy) => reports.push(busy));
  const firstSettle = controller.begin();
  assert.equal(typeof firstSettle, "function");
  assert.equal(controller.isBusy(), true);
  assert.deepEqual(reports, [true]);
  assert.equal(controller.begin(), null, "a second persistence cannot start while busy");
  assert.deepEqual(reports, [true]);

  firstSettle();
  firstSettle();
  assert.equal(controller.isBusy(), false);
  assert.deepEqual(reports, [true, false], "settling twice must not report twice");

  const staleSettle = controller.begin();
  assert.deepEqual(reports, [true, false, true]);
  controller.dispose();
  assert.equal(controller.isBusy(), false);
  assert.deepEqual(reports, [true, false, true, false], "unmount disposal clears parent busy state");
  staleSettle();
  assert.deepEqual(reports, [true, false, true, false], "a stale async settle after unmount is ignored");
  assert.equal(controller.begin(), null, "a disposed form cannot restart persistence");

  const remounted = createFormBusyController((busy) => reports.push(busy));
  const resumedSettle = remounted.begin();
  assert.equal(typeof resumedSettle, "function");
  resumedSettle();
  assert.deepEqual(reports, [true, false, true, false, true, false]);
});

test("reported persistence starts busy before saving and clears it on every settlement", async () => {
  const order = [];
  const errors = [];
  const controller = createFormBusyController((busy) => order.push(`busy:${busy}`));
  let resolveSave;
  const pendingSave = new Promise((resolve) => {
    resolveSave = resolve;
  });
  const run = runReportedFormPersistence(
    controller.begin,
    () => {
      order.push("save");
      return pendingSave;
    },
    (message) => errors.push(message),
    "fallback",
  );
  assert.deepEqual(order, ["busy:true", "save"]);
  assert.equal(
    runReportedFormPersistence(
      controller.begin,
      async () => order.push("duplicate-save"),
      (message) => errors.push(message),
      "fallback",
    ),
    null,
  );
  resolveSave();
  await run;
  assert.deepEqual(order, ["busy:true", "save", "busy:false"]);
  assert.deepEqual(errors, []);

  await runReportedFormPersistence(
    controller.begin,
    async () => {
      throw new Error("保存失败");
    },
    (message) => errors.push(message),
    "fallback",
  );
  assert.deepEqual(errors, ["保存失败"]);
  assert.equal(controller.isBusy(), false);

  await runReportedFormPersistence(
    controller.begin,
    () => {
      throw "not-an-error";
    },
    (message) => errors.push(message),
    "同步保存失败",
  );
  assert.deepEqual(errors, ["保存失败", "同步保存失败"]);
  assert.equal(controller.isBusy(), false);
  assert.doesNotMatch(order.join(" "), /duplicate-save/);
});

test("equipment load parser preserves explicit truthful values and allows unknown loads", () => {
  assert.deepEqual(parseEquipmentLoadText("  \n ", "kg", 2), []);
  assert.deepEqual(parseEquipmentLoadText("10×2, 2.5; 5*4", "kg", 3), [
    { load_grams: 2_500, quantity: 3, label: "2.5 kg", available: true },
    { load_grams: 5_000, quantity: 4, label: "5 kg", available: true },
    { load_grams: 10_000, quantity: 2, label: "10 kg", available: true },
  ]);
  assert.deepEqual(parseEquipmentLoadText("10x1", "lb", 2), [
    { load_grams: 4_536, quantity: 1, label: "10 lb", available: true },
  ]);
});

test("new equipment suggestions follow templates until each identity field is customized", () => {
  assert.equal(suggestedEquipmentQuantity("dumbbell"), 2);
  assert.equal(suggestedEquipmentQuantity("barbell"), 1);
  assert.equal(suggestedEquipmentQuantity("plates"), 1);

  const initial = createEquipmentIdentityDraft(null, "固定哑铃", 2);
  assert.deepEqual(initial, {
    name: "固定哑铃",
    quantity: "2",
    nameCustomized: false,
    quantityCustomized: false,
  });

  const barbell = applyEquipmentTemplateSuggestion(initial, "奥杆", 1);
  assert.equal(barbell.name, "奥杆");
  assert.equal(barbell.quantity, "1");

  const named = updateEquipmentIdentityDraft(barbell, "name", "训练区 A 杆");
  const plates = applyEquipmentTemplateSuggestion(named, "杠铃片组", 1);
  assert.equal(plates.name, "训练区 A 杆", "a manually edited name must not be replaced");
  assert.equal(plates.quantity, "1", "the untouched quantity may still follow its template");

  const counted = updateEquipmentIdentityDraft(plates, "quantity", "4");
  const dumbbells = applyEquipmentTemplateSuggestion(counted, "固定哑铃", 2);
  assert.equal(dumbbells.name, "训练区 A 杆");
  assert.equal(dumbbells.quantity, "4", "a manually edited total must not be replaced");
});

test("editing existing equipment preserves identity and explicit load counts stay independent", () => {
  const existing = createEquipmentIdentityDraft(
    { name: "窗边哑铃", quantity: 7 },
    "固定哑铃",
    2,
  );
  assert.deepEqual(
    applyEquipmentTemplateSuggestion(existing, "跑步机", 1),
    existing,
    "switching templates while editing must preserve the saved name and total exactly",
  );

  const newDumbbells = createEquipmentIdentityDraft(null, "固定哑铃", 2);
  assert.equal(newDumbbells.quantity, "2");
  assert.deepEqual(parseEquipmentLoadText("5×2", "kg", Number(newDumbbells.quantity)), [
    { load_grams: 5_000, quantity: 2, label: "5 kg", available: true },
  ]);
  assert.equal(
    newDumbbells.quantity,
    "2",
    "a load-row count is inventory detail and must not rewrite the equipment total",
  );
});

test("equipment load parser rejects every malformed token instead of dropping it", () => {
  assert.throws(
    () => parseEquipmentLoadText("5×2, 轻, 10×2", "kg", 2),
    /第 2 项“轻”无法识别.*重量×数量/,
  );
  assert.throws(
    () => parseEquipmentLoadText("5×2,,10×2", "kg", 2),
    /第 2 项是空的.*多余的分隔符/,
  );
  assert.throws(
    () => parseEquipmentLoadText("5kg×2", "kg", 2),
    /第 1 项“5kg×2”无法识别/,
  );
});

test("equipment load parser rejects zero or impossible quantities without correcting them", () => {
  assert.throws(
    () => parseEquipmentLoadText("10×0", "kg", 2),
    /数量必须是 1 到 1000 的整数.*不会把 0 自动改成 1/,
  );
  assert.throws(
    () => parseEquipmentLoadText("10×1001", "kg", 2),
    /数量必须是 1 到 1000 的整数/,
  );
  assert.throws(
    () => parseEquipmentLoadText("10", "kg", 0),
    /数量必须是 1 到 1000 的整数/,
  );
});

test("equipment load parser rejects duplicate and impossible weights", () => {
  assert.throws(
    () => parseEquipmentLoadText("10×1, 10.0×2", "kg", 2),
    /第 2 项与第 1 项是同一重量.*实际总数量/,
  );
  assert.throws(
    () => parseEquipmentLoadText("0×1", "kg", 2),
    /重量必须大于 0 kg/,
  );
  assert.throws(
    () => parseEquipmentLoadText("10001×1", "kg", 2),
    /重量超出可记录范围/,
  );
});

test("field-owned validation clears only its own stale error", () => {
  assert.equal(clearOwnedFormError("档位错误", "档位错误"), "");
  assert.equal(clearOwnedFormError("保存服务失败", "档位错误"), "保存服务失败");
  assert.equal(clearOwnedFormError("保存服务失败", ""), "保存服务失败");
});

test("only an active body boundary requires a known movement or exercise scope", () => {
  assert.equal(isActiveConstraintScopeMissing(true, 0, 0), true);
  assert.equal(isActiveConstraintScopeMissing(true, 1, 0), false);
  assert.equal(isActiveConstraintScopeMissing(true, 0, 1), false);
  assert.equal(isActiveConstraintScopeMissing(false, 0, 0), false);
});

test("venue verification timestamp changes only after explicit on-site confirmation", () => {
  const previous = 1_700_000_000_000;
  const now = 1_800_000_000_000;
  assert.equal(resolveVenueVerificationTimestamp(false, previous, now), previous);
  assert.equal(resolveVenueVerificationTimestamp(false, null, now), null);
  assert.equal(resolveVenueVerificationTimestamp(false, undefined, now), null);
  assert.equal(resolveVenueVerificationTimestamp(true, previous, now), now);
  assert.equal(resolveVenueVerificationTimestamp(true, null, now), now);
});

test("venue and relative-resistance UI state the truth boundary", () => {
  assert.match(source, /name="verifiedNow" type="checkbox"/);
  assert.doesNotMatch(source, /name="verifiedNow"[^>]*defaultChecked/);
  assert.match(source, /普通编辑不会把旧清单伪装成刚刚确认/);
  assert.match(source, /轻 \/ 中 \/ 重和阻力范围都是相对信息/);
  assert.match(source, /面板若只写 1 \/ 2 \/ 3 等无单位数字，它们不是公斤/);
  assert.match(source, /阻力范围或无单位面板数字请留空，并写进备注/);
});

test("all persistent Fitness forms expose one shared modal-busy contract", () => {
  assert.equal(
    (source.match(/onBusyChange\?: \(busy: boolean\) => void/g) ?? []).length,
    5,
    "four public form props plus the shared hook must use the same callback type",
  );
  assert.equal(
    (source.match(/\n\s{2}onBusyChange,\n/g) ?? []).length,
    4,
    "venue, equipment, profile, and constraint forms must all receive the prop",
  );
  assert.equal(
    (source.match(/useReportedFormBusy\(onBusyChange\)/g) ?? []).length,
    4,
  );
  assert.equal(
    (source.match(/runReportedFormPersistence\(beginBusy,/g) ?? []).length,
    4,
  );
  assert.match(source, /return \(\) => \{[\s\S]*mounted = false;[\s\S]*controller\.dispose\(\);/);

  const equipmentStart = source.indexOf("export function EquipmentForm");
  const profileStart = source.indexOf("export function ProfileForm");
  const constraintStart = source.indexOf("export function ConstraintForm");
  const equipmentSource = source.slice(equipmentStart, profileStart);
  const constraintSource = source.slice(constraintStart);
  assert.ok(
    equipmentSource.indexOf("parseEquipmentLoadText(") <
      equipmentSource.indexOf("runReportedFormPersistence(beginBusy,"),
    "equipment parsing must finish before busy is reported",
  );
  assert.ok(
    constraintSource.indexOf("isActiveConstraintScopeMissing(") <
      constraintSource.indexOf("runReportedFormPersistence(beginBusy,"),
    "invalid constraint scope must return before busy is reported",
  );
});

test("custom validation identifies, describes, focuses, and clears the owning control", () => {
  const equipmentStart = source.indexOf("export function EquipmentForm");
  const profileStart = source.indexOf("export function ProfileForm");
  const constraintStart = source.indexOf("export function ConstraintForm");
  const equipmentSource = source.slice(equipmentStart, profileStart);
  const constraintSource = source.slice(constraintStart);

  assert.match(equipmentSource, /const loadInput = useRef<HTMLTextAreaElement>\(null\)/);
  assert.match(equipmentSource, /ref=\{loadInput\} name="loads"/);
  assert.match(equipmentSource, /aria-invalid=\{loadError \? true : undefined\}/);
  assert.match(equipmentSource, /aria-describedby=\{loadError \? "sl-equipment-load-help sl-equipment-load-error" : "sl-equipment-load-help"\}/);
  assert.match(equipmentSource, /id="sl-equipment-load-help"/);
  assert.match(equipmentSource, /id=\{loadError \? "sl-equipment-load-error" : undefined\}/);
  assert.match(equipmentSource, /setLoadError\(message\);[\s\S]*setError\(message\);[\s\S]*loadInput\.current\?\.focus\(\);[\s\S]*return;/);
  assert.match(equipmentSource, /onChange=\{clearLoadError\}/);
  assert.ok(
    equipmentSource.indexOf("loadInput.current?.focus();") <
      equipmentSource.indexOf("runReportedFormPersistence(beginBusy,"),
    "client load errors must focus without reporting persistence busy",
  );

  assert.match(constraintSource, /const firstPattern = useRef<HTMLButtonElement>\(null\)/);
  assert.match(constraintSource, /aria-invalid=\{scopeError \? true : undefined\}/);
  assert.match(constraintSource, /aria-describedby=\{scopeError \? "sl-constraint-scope-error" : undefined\}/);
  assert.match(constraintSource, /ref=\{index === 0 \? firstPattern : undefined\}/);
  assert.match(constraintSource, /id=\{scopeError \? "sl-constraint-scope-error" : undefined\}/);
  assert.match(constraintSource, /setScopeError\(message\);[\s\S]*setError\(message\);[\s\S]*firstPattern\.current\?\.focus\(\);[\s\S]*return;/);
  assert.match(constraintSource, /onClick=\{\(\) => \{ clearScopeError\(\); setPatterns/);
  assert.doesNotMatch(source, /<form[^>]*noValidate/);
});

test("equipment identity inputs are controlled and template suggestions respect dirty state", () => {
  const equipmentStart = source.indexOf("export function EquipmentForm");
  const profileStart = source.indexOf("export function ProfileForm");
  const equipmentSource = source.slice(equipmentStart, profileStart);

  assert.match(equipmentSource, /const \[identityDraft, setIdentityDraft\] = useState\(\(\) => createEquipmentIdentityDraft\(/);
  assert.match(equipmentSource, /suggestedEquipmentQuantity\(initialTemplate\.kind\)/);
  assert.match(equipmentSource, /applyEquipmentTemplateSuggestion\(current, entry\.suggestedName, suggestedEquipmentQuantity\(entry\.kind\)\)/);
  assert.match(equipmentSource, /name="name" value=\{identityDraft\.name\} onChange=\{\(event\) => setIdentityDraft\(\(current\) => updateEquipmentIdentityDraft\(current, "name", event\.target\.value\)\)\}/);
  assert.match(equipmentSource, /name="quantity"[^>]*value=\{identityDraft\.quantity\} onChange=\{\(event\) => setIdentityDraft\(\(current\) => updateEquipmentIdentityDraft\(current, "quantity", event\.target\.value\)\)\}/);
  assert.doesNotMatch(equipmentSource, /name="(?:name|quantity)"[^>]*defaultValue=/);
  assert.doesNotMatch(equipmentSource, /setIdentityDraft[^\n]*(?:parsedLoads|loads\.length)/);
});
