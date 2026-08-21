import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const appUrl = new URL("../app/fitness/FitnessApp.tsx", import.meta.url);
const logicUrl = new URL("../app/fitness/fitness-ui-logic.ts", import.meta.url);
const filesUrl = new URL("../lib/local-db/files.ts", import.meta.url);
const cssUrl = new URL("../app/fitness/fitness.css", import.meta.url);
const [source, logic, files, css] = await Promise.all([
  readFile(appUrl, "utf8"),
  readFile(logicUrl, "utf8"),
  readFile(filesUrl, "utf8"),
  readFile(cssUrl, "utf8"),
]);

async function loadStorageFormatter() {
  const sourceFile = ts.createSourceFile(
    logicUrl.pathname,
    logic,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  const declaration = sourceFile.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "formatFitnessStorageBytes",
  );
  assert.ok(declaration, "the storage display must use one tested formatter");
  const { outputText, diagnostics = [] } = ts.transpileModule(
    declaration.getText(sourceFile),
    {
      fileName: "fitness-storage-formatter.ts",
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    },
  );
  assert.deepEqual(
    diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error),
    [],
  );
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

async function loadStorageEstimator() {
  const sourceFile = ts.createSourceFile(
    filesUrl.pathname,
    files,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = sourceFile.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "estimateLocalStorage",
  );
  assert.ok(declaration, "the storage estimate must remain independently testable");
  const harness = `
    class LocalFileError extends Error {
      constructor(message, code) { super(message); this.code = code; }
    }
    function requireBrowserStorage() { return globalThis.__fitnessStorageMock; }
    ${declaration.getText(sourceFile).replace("export async function", "async function")}
    export { estimateLocalStorage };
  `;
  const { outputText, diagnostics = [] } = ts.transpileModule(harness, {
    fileName: "fitness-storage-estimate.ts",
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  assert.deepEqual(
    diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error),
    [],
  );
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const { formatFitnessStorageBytes } = await loadStorageFormatter();

test("storage totals preserve a real zero instead of inventing one kilobyte", () => {
  assert.equal(formatFitnessStorageBytes(0), "0 B");
  assert.equal(formatFitnessStorageBytes(512), "512 B");
  assert.equal(formatFitnessStorageBytes(1024), "1 KB");
  assert.equal(formatFitnessStorageBytes(1536), "1.5 KB");
  assert.equal(formatFitnessStorageBytes(null), "暂时未知");
  assert.equal(formatFitnessStorageBytes(undefined), "暂时未知");
  assert.equal(formatFitnessStorageBytes(Number.NaN), "暂时未知");
  assert.equal(formatFitnessStorageBytes(-1), "暂时未知");

  const settingsStart = source.indexOf("function SettingsView");
  const settingsEnd = source.indexOf("function SettingSwitch", settingsStart);
  assert.ok(settingsStart >= 0 && settingsEnd > settingsStart);
  assert.doesNotMatch(source.slice(settingsStart, settingsEnd), /Math\.max\(1/);
  assert.match(files, /const usage = Number\.isFinite\(estimate\.usage\)/);
  assert.match(files, /const quota = Number\.isFinite\(estimate\.quota\)/);
  assert.match(files, /available: usage === null \|\| quota === null \? null/);
  assert.match(files, /Promise\.allSettled\(/);
  assert.match(files, /persisted: boolean \| null/);
  assert.match(files, /estimateResult\.status === "fulfilled" \? estimateResult\.value : \{\}/);
  assert.match(files, /typeof persistedResult\.value === "boolean"/);
  assert.doesNotMatch(files, /estimate\.usage \?\? 0|estimate\.quota \?\? 0/);
});

test("capacity and protection failures remain independent facts", async () => {
  const { estimateLocalStorage } = await loadStorageEstimator();
  globalThis.__fitnessStorageMock = {
    estimate: async () => ({}),
    persisted: async () => true,
  };
  assert.deepEqual(await estimateLocalStorage(), {
    usage: null,
    quota: null,
    available: null,
    persisted: true,
    usageDetails: {},
  });

  globalThis.__fitnessStorageMock = {
    estimate: async () => ({ usage: 0, quota: 0 }),
    persisted: async () => { throw new Error("permission state unavailable"); },
  };
  assert.deepEqual(await estimateLocalStorage(), {
    usage: 0,
    quota: 0,
    available: 0,
    persisted: null,
    usageDetails: {},
  });

  globalThis.__fitnessStorageMock = {
    estimate: async () => { throw new Error("estimate unavailable"); },
    persisted: async () => { throw new Error("permission state unavailable"); },
  };
  await assert.rejects(
    estimateLocalStorage(),
    (error) => error.code === "STORAGE_ESTIMATE_UNAVAILABLE",
  );
  delete globalThis.__fitnessStorageMock;
});

test("the settings page names the exact origin and browser-profile boundary", () => {
  assert.match(source, /useSyncExternalStore\([\s\S]*?readClientOrigin,[\s\S]*?readServerOrigin/);
  assert.match(source, /const readClientOrigin = \(\) => window\.location\.origin/);
  assert.match(source, /currentOrigin=\{currentOrigin\}/);
  assert.equal((source.match(/window\.location\.origin/g) ?? []).length, 1);
  assert.match(source, />当前完整地址</);
  assert.match(source, /当前完整地址与当前浏览器资料（profile）共同决定资料放在哪里/);
  assert.match(source, /协议、主机名（hostname）或端口不同，就是另一套地址/);
  assert.match(source, /更换浏览器资料（profile），也会打开另一套本地空间/);
  assert.match(source, /<code>\{currentOrigin \|\| "正在确认当前地址…"\}<\/code>/);

  assert.match(css, /\.sl-origin-fact code\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.match(css, /\.sl-origin-fact code\s*\{[\s\S]*?word-break:\s*break-word;/);
});

test("capacity truth is explicitly site-wide and separates usage, quota, and availability", () => {
  assert.match(source, /此地址站点数据合计（职迹、拾词、适练和缓存）/);
  assert.match(source, />已使用<\/dt><dd>\{formatFitnessStorageBytes\(storage\.usage\)\}/);
  assert.match(source, />浏览器估算上限<\/dt><dd>\{formatFitnessStorageBytes\(storage\.quota\)\}/);
  assert.match(source, />估算可用<\/dt><dd>\{formatFitnessStorageBytes\(storage\.available\)\}/);
  assert.match(source, /storageReadStatus === "error"/);
  assert.match(source, /暂时无法读取，不代表资料丢失/);
  assert.match(source, />重新检查<\/button>/);
});

test("persistence remains an explicit, modest protection shared by all three spaces", () => {
  assert.equal(
    (source.match(/requestPersistentLocalStorage\(\)/g) ?? []).length,
    1,
    "the persistence prompt must only be reached by its explicit action",
  );
  assert.match(source, /const requestStorageProtection = useCallback/);
  assert.match(source, /if \(!supportsPersistentLocalStorage\(\)\)/);
  assert.match(source, /这个浏览器没有提供保护申请接口/);
  assert.match(source, /onClick=\{\(\) => void onPersist\(\)\}/);
  assert.match(source, /申请降低清理风险/);
  assert.match(source, /已降低浏览器自动清理风险/);
  assert.match(source, /同一完整地址里的职迹、拾词与适练共享这项浏览器保护/);
  assert.match(source, /这项保护只降低浏览器自动清理风险，不是备份/);
  assert.match(source, /浏览器没有完成这次保护申请；本地资料和原有容量信息没有因此改变/);
  assert.match(source, /保护状态暂时未知/);
  assert.match(source, /storage\.persisted !== true/);
  assert.match(source, /浏览器已报告授予保护，但暂时没有返回复查状态/);
  assert.match(source, /浏览器没有报告授予额外保护/);
  assert.match(files, /export function supportsPersistentLocalStorage\(\): boolean/);
  assert.match(source, /storageActionMessage && <p className="sl-storage-action-status" role="status">/);
  assert.doesNotMatch(source, /export function formatFitnessStorageBytes/);
  assert.doesNotMatch(source, /保证不会被清理|永久保护|绝不会丢失/);
});

test("storage actions keep compact-screen touch and focus affordances", () => {
  assert.match(
    css,
    /\.sl-storage button,\s*\.sl-storage-unavailable button\s*\{[\s\S]*?min-height:\s*44px;/,
  );
  assert.match(css, /\.shilian :is\(button, a, input, select, textarea\):focus-visible/);
  assert.match(css, /\.sl-storage-metrics\s*\{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.sl-storage-metrics > div\s*\{[\s\S]*?min-width:\s*0;/);
});
