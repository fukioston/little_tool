import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const sourceUrl = new URL("../app/career/CareerApp.tsx", import.meta.url);
const cssUrl = new URL("../app/career/career.css", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const css = await readFile(cssUrl, "utf8");

async function loadImportHelpers() {
  const sourceFile = ts.createSourceFile(sourceUrl.pathname, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const wanted = new Set([
    "careerImportSourceSnapshot",
    "careerImportFieldNote",
    "selectCareerImportCommitRows",
    "partitionCareerImportInspectionRows",
    "careerImportCsvFileIssue",
    "careerImportAiSourceIssue",
  ]);
  const declarations = sourceFile.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name && wanted.has(statement.name.text),
  );
  assert.equal(declarations.length, wanted.size);
  const { outputText, diagnostics = [] } = ts.transpileModule(declarations.map((item) => item.getText(sourceFile)).join("\n"), {
    fileName: "career-import-ui-helpers.ts",
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  assert.deepEqual(diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const helpers = await loadImportHelpers();
const importStart = source.indexOf("function CareerImportModal");
const importEnd = source.indexOf("function CommandPalette", importStart);
const importSource = source.slice(importStart, importEnd);

test("paste, browser capture, and CSV retain distinct exact source snapshots", () => {
  const values = {
    paste: "  exact pasted text\n",
    capture: { url: " https://example.com/job/1 ", selectedText: "Selected\nJD" },
    csv: 'Company,Title\n"A, Inc",Designer',
  };
  assert.equal(helpers.careerImportSourceSnapshot("paste", values), values.paste);
  assert.equal(helpers.careerImportSourceSnapshot("csv", values), values.csv);
  assert.deepEqual(JSON.parse(helpers.careerImportSourceSnapshot("capture", values)), {
    kind: "career-browser-capture-v1",
    url: "https://example.com/job/1",
    selectedText: "Selected\nJD",
  });
  assert.notEqual(
    helpers.careerImportSourceSnapshot("capture", values),
    helpers.careerImportSourceSnapshot("paste", values),
  );
});

test("field guidance distinguishes absent evidence from low-confidence evidence", () => {
  assert.equal(helpers.careerImportFieldNote("unknown", false), "原文未说明");
  assert.equal(helpers.careerImportFieldNote("low", false), "需要你确认");
  assert.equal(helpers.careerImportFieldNote("medium", false), "建议核对");
  assert.equal(helpers.careerImportFieldNote("high", false), "原文较清楚");
  assert.equal(helpers.careerImportFieldNote("unknown", true), "你已确认");
  assert.doesNotMatch(importSource, /overall|总分|评分|错误数/);
});

test("every import path creates a preview through the frozen storage boundary", () => {
  for (const call of [
    "createCareerJobImportPreview",
    "reviseCareerJobImportPreview",
    "forkCareerJobImportPreview",
    "parseCareerCsvImportPreview",
    "commitCareerJobImports",
    "inspectCareerImportCommit",
  ]) assert.match(importSource, new RegExp(`${call}\\(`));
  assert.doesNotMatch(importSource, /runCareerSql|runCareerBatch|INSERT INTO|FileReader|split\(\/\\r\?\\n\//);
  assert.match(source, />从原文添加<\/button>/);
  assert.match(source, /title="从职位原文建立记录"/);
});

test("AI source and URL claims are discarded in favor of an explicit user URL", () => {
  assert.match(importSource, /"source", "platform", "source_hint", "detected_source", "sourceUrl", "source_url", "url", "original_url"/);
  assert.match(importSource, /"stageId", "stage_id", "stage", "status", "priority"/);
  assert.match(importSource, /delete parsedCandidate\[untrustedSourceField\]/);
  assert.match(importSource, /const explicitUrl = targetMode === "capture" \? captureValue\.url\.trim\(\) : isStandaloneUrl \? trimmedPaste : ""/);
  assert.match(importSource, /if \(explicitUrl\) parsedCandidate\.original_url = explicitUrl/);
  assert.doesNotMatch(importSource, /detectedSource|parsedSource|智能识别|智能导入/);
});

test("AI request races cannot replace a newer source preview and can be stopped", () => {
  assert.match(importSource, /new AbortController\(\)/);
  assert.match(importSource, /requestRef\.current\.controller\?\.abort\(\)/);
  assert.match(importSource, /requestIsCurrent\(token, targetMode, snapshot\)/);
  assert.match(importSource, /signal: controller\.signal/);
  assert.match(importSource, /controller\.signal\.aborted \|\| requestRef\.current\.token !== token/);
  assert.match(importSource, />停止整理<\/button>/);
  assert.match(css, /\.career-import-shell button \{ min-height: 44px; \}/);
  assert.equal(helpers.careerImportAiSourceIssue("a".repeat(160 * 1024)), "");
  assert.equal(helpers.careerImportAiSourceIssue("a".repeat(160 * 1024 + 1)), "内容较长，请只保留职位正文或改用 CSV。");
  assert.equal(helpers.careerImportAiSourceIssue("职".repeat(60_000)), "内容较长，请只保留职位正文或改用 CSV。");
  const issueCheck = importSource.indexOf("const sourceIssue = careerImportAiSourceIssue(snapshot)");
  const fetchCall = importSource.indexOf('fetch("/api/import/job"');
  assert.ok(issueCheck >= 0 && issueCheck < fetchCall, "AI source size must be checked before fetch");
  assert.doesNotMatch(importSource, /slice\([^)]*160 \* 1024/);
});

test("CSV stays local and top-level blocking notices cannot be bypassed", () => {
  const csvStart = importSource.indexOf("async function previewCsv");
  const csvEnd = importSource.indexOf("function updateDraft", csvStart);
  const csvSource = importSource.slice(csvStart, csvEnd);
  assert.equal(helpers.careerImportCsvFileIssue(0), "这个 CSV 是空文件，请选择包含表头和职位内容的文件。");
  assert.equal(helpers.careerImportCsvFileIssue(16 * 1024 * 1024), "");
  assert.match(helpers.careerImportCsvFileIssue(16 * 1024 * 1024 + 1), /超过 16 MiB/);
  const sizeCheck = csvSource.indexOf("careerImportCsvFileIssue(file.size)");
  const fileRead = csvSource.indexOf("await file.text()");
  assert.ok(sizeCheck >= 0 && sizeCheck < fileRead, "CSV size must be checked before File.text");
  assert.match(csvSource, /if \(fileIssue\) \{[\s\S]*?return;[\s\S]*?\}\s*setPhase\("fingerprinting"\)/);
  assert.match(csvSource, /await file\.text\(\)/);
  assert.match(csvSource, /parseCareerCsvImportPreview\(text\)/);
  assert.doesNotMatch(csvSource, /fetch\(/);
  assert.match(importSource, /const hasGlobalBlocking = globalWarnings\.some\(\(warning\) => warning\.severity === "blocking"\)/);
  assert.match(importSource, /!hasGlobalBlocking && !hasBlocking/);
  assert.match(importSource, /CSV 只在当前浏览器本机解析，不会发送给 AI/);
  assert.match(importSource, /duplicateOfRowNumber === undefined/);
  assert.match(importSource, />仍另存<\/button>/);
});

test("folded CSV duplicates never enter selection, counts, or same-name gates until explicitly forked", () => {
  const rows = [
    { id: "primary", included: true, preview: {} },
    { id: "folded", included: true, preview: { duplicateOfRowNumber: 2 } },
    { id: "excluded", included: false, preview: {} },
    { id: "forked", included: true, preview: {} },
  ];
  assert.deepEqual(helpers.selectCareerImportCommitRows(rows).map((row) => row.id), ["primary", "forked"]);
  assert.deepEqual(helpers.selectCareerImportCommitRows(rows, new Set(["forked"])).map((row) => row.id), ["forked"]);
  assert.match(importSource, /const selected = selectCareerImportCommitRows\(rowsRef\.current, absentRowIds\)/);
  assert.match(importSource, /const selectedRows = selectCareerImportCommitRows\(rows, absentRowIds\)/);
});

test("an uncertain commit has a read-only reconciliation path", () => {
  const inspectStart = importSource.indexOf("async function inspectUncertainCommit");
  const inspectEnd = importSource.indexOf("async function retryRefreshOnly", inspectStart);
  const inspectSource = importSource.slice(inspectStart, inspectEnd);
  assert.match(inspectSource, /inspectCareerImportCommit\(row\.preview\)/);
  assert.doesNotMatch(inspectSource, /commitCareerJobImport|createCareerJobImportPreview|forkCareerJobImportPreview/);
  assert.match(inspectSource, /status === "exact_committed"|await refreshAfterCommit\(\)/);
  assert.match(inspectSource, /status === "absent"/);
  assert.match(inspectSource, /status === "still_unknown"/);
  assert.match(inspectSource, /status === "conflict"/);
  assert.match(inspectSource, /partitionCareerImportInspectionRows\(uncertainRowsRef\.current, inspections\)/);
  assert.match(inspectSource, /setAbsentRowIds\(absentIds\)/);
  assert.match(inspectSource, /setCommittedRowIds\(exactIds\)/);
  assert.doesNotMatch(inspectSource, /setAbsentRowIds\(new Set\(uncertainRowsRef\.current/);
  assert.match(importSource, /committedRowIds\.has\(row\.id\)/);
  assert.match(importSource, /不会再次编辑、选择或写入/);
  assert.match(importSource, /originalRecoverySelection/);
  assert.match(importSource, /不能更换原文、文件或新增选择/);
  assert.match(importSource, /phase === "commit-check"/);
  assert.match(importSource, /这一步只读取原操作标识，不会创建新职位/);
});

test("mixed exact and absent inspections retry only the original absent operations", () => {
  const rows = [
    { id: "already-saved", preview: { importOperationId: "op-exact" }, included: true },
    { id: "retry-only", preview: { importOperationId: "op-absent" }, included: true },
  ];
  const partitioned = helpers.partitionCareerImportInspectionRows(rows, [
    { status: "exact_committed" },
    { status: "absent" },
  ]);
  assert.deepEqual(partitioned.exactRows.map((row) => row.preview.importOperationId), ["op-exact"]);
  assert.deepEqual(partitioned.absentRows.map((row) => row.preview.importOperationId), ["op-absent"]);
  const absentIds = new Set(partitioned.absentRows.map((row) => row.id));
  assert.deepEqual(
    helpers.selectCareerImportCommitRows(rows, absentIds).map((row) => row.preview.importOperationId),
    ["op-absent"],
  );
  const commitStart = importSource.indexOf("async function commitPreview");
  const commitEnd = importSource.indexOf("async function inspectUncertainCommit", commitStart);
  const commitSource = importSource.slice(commitStart, commitEnd);
  assert.match(commitSource, /selectCareerImportCommitRows\(rowsRef\.current, absentRowIds\)/);
  assert.match(commitSource, /selected\.map\(\(row\) => \(\{ preview: row\.preview/);
});

test("post-write refresh recovery never repeats a write", () => {
  const retryStart = importSource.indexOf("async function retryRefreshOnly");
  const retryEnd = importSource.indexOf("const renderedSourceSnapshot", retryStart);
  const retrySource = importSource.slice(retryStart, retryEnd);
  assert.match(retrySource, /await onRefresh\(\)/);
  assert.doesNotMatch(retrySource, /commitCareerJobImport|createCareerJobImportPreview|forkCareerJobImportPreview/);
  assert.match(importSource, /phase === "refresh-only"/);
  assert.match(importSource, />只重新读取<\/button>/);
});

test("dirty close, tab keyboard behavior, and mobile geometry remain explicit", () => {
  assert.match(importSource, /role="tablist"/);
  assert.match(importSource, /role="tab"/);
  assert.match(importSource, /ArrowRight/);
  assert.match(importSource, /ArrowLeft/);
  assert.match(importSource, /event\.key === "Home"/);
  assert.match(importSource, /event\.key === "End"/);
  assert.match(importSource, /type="file" accept="\.csv,text\/csv"/);
  assert.match(importSource, /setCloseConfirm\(true\)/);
  const requestCloseStart = importSource.indexOf("function requestClose");
  const requestCloseEnd = importSource.indexOf("function tabKeydown", requestCloseStart);
  const requestCloseSource = importSource.slice(requestCloseStart, requestCloseEnd);
  assert.ok(requestCloseSource.indexOf("cancelPendingRequest()") < requestCloseSource.indexOf("setCloseConfirm(true)"));
  assert.match(importSource, /useEffect\(\(\) => \(\) => \{[\s\S]*?requestRef\.current\.controller\?\.abort\(\)[\s\S]*?token: requestRef\.current\.token \+ 1/);
  assert.match(importSource, /title="放弃这次导入吗？"/);
  assert.match(importSource, /phase === "committing" \|\| phase === "commit-check" \|\| phase === "refreshing" \|\| phase === "refresh-only"/);
  assert.match(css, /\.career-import-preview-list\.csv \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.career-import-preview-list\.csv \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /\.career-import-file-input \{[\s\S]*min-height: 48px/);
  assert.match(css, /\.career-import-shell \{ min-width: 0; overflow-x: hidden; \}/);
});

test("every final import close restores the stable trigger after unmount", () => {
  assert.match(source, /onClick=\{\(event\) => onImport\(event\.currentTarget\)\}/);
  assert.match(source, /const importOpenerRef = useRef<HTMLButtonElement \| null>\(null\)/);
  assert.match(source, /onImport=\{openCareerImport\}/);
  assert.match(source, /<CareerImportModal data=\{allData\}[\s\S]*?onClose=\{closeCareerImport\}/);
  const focusEffectStart = source.indexOf('if (modal === "import" || !importFocusReturnPendingRef.current) return');
  const focusEffectEnd = source.indexOf("}, [modal]);", focusEffectStart);
  const focusEffectSource = source.slice(focusEffectStart, focusEffectEnd);
  assert.match(focusEffectSource, /window\.requestAnimationFrame\(\(\) => \{/);
  assert.match(focusEffectSource, /opener\?\.isConnected/);
  assert.match(focusEffectSource, /opener\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(focusEffectSource, /setTimeout/);
  const closeStart = source.indexOf("function closeCareerImport");
  const closeEnd = source.indexOf("if (loading)", closeStart);
  const closeSource = source.slice(closeStart, closeEnd);
  assert.match(closeSource, /importFocusReturnPendingRef\.current = true/);
  assert.match(closeSource, /setModal\(null\)/);
  assert.match(importSource, />继续核对<\/button>/);
  assert.match(importSource, /onClick=\{\(\) => setCloseConfirm\(false\)\}>继续核对/);
  assert.match(importSource, /if \(closeConfirm \|\| !finalClosePendingRef\.current\) return;[\s\S]*?finalClosePendingRef\.current = false;[\s\S]*?onClose\(\)/);
  const abandonStart = importSource.indexOf('className="career-button danger"');
  const abandonEnd = importSource.indexOf(">放弃这次输入</button>", abandonStart);
  const abandonSource = importSource.slice(abandonStart, abandonEnd);
  assert.match(abandonSource, /finalClosePendingRef\.current = true; setCloseConfirm\(false\)/);
  assert.doesNotMatch(abandonSource, /onClose\(\)/);
});

test("same-name choices stay neutral, explicit, and reversible", () => {
  assert.match(source, /本机已有同名记录/);
  assert.match(source, /这里不替你判断/);
  assert.match(source, />仍保存这份<\/button>/);
  assert.match(source, />这次先不保存<\/button>/);
  assert.match(source, /if \(csv\) onInclude\(false\)/);
  assert.doesNotMatch(importSource, /function setSameNameDecision[\s\S]*?setRowIncluded\(rowId, false\)/);
  assert.match(importSource, /sameNameSkipped/);
  assert.match(importSource, /也可以改回“仍保存这份”/);
  assert.match(source, /<CareerImportModal data=\{allData\}/);
});

test("capture sends only URL and selected text, never a whole-page fallback", () => {
  assert.match(importSource, /\{ url: captureValue\.url\.trim\(\), text: captureValue\.selectedText \}/);
  assert.match(importSource, /不包含 Cookie、登录态或站内消息/);
  assert.doesNotMatch(source, /document\.body\.innerText/);
  assert.match(source, /window\.getSelection\(\)\?\.toString\(\)\.trim\(\)\|\|''/);
  assert.match(source, /不会自动投递/);
});
