import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

async function suiteRoutes() {
  const configUrl = new URL("app/suite-spaces.tsx", projectRoot);
  const source = await readFile(configUrl, "utf8");
  const sourceFile = ts.createSourceFile(
    configUrl.pathname,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  const declaration = sourceFile.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((entry) => ts.isIdentifier(entry.name) && entry.name.text === "suiteSpaces");
  assert.ok(declaration?.initializer, "suiteSpaces must remain a static typed registry");
  const entries = unwrapExpression(declaration.initializer);
  assert.ok(ts.isArrayLiteralExpression(entries));

  return entries.elements.map((entry) => {
    const object = unwrapExpression(entry);
    assert.ok(ts.isObjectLiteralExpression(object));
    const href = object.properties.find(
      (property) => ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) && property.name.text === "href",
    );
    assert.ok(href && ts.isPropertyAssignment(href));
    const value = unwrapExpression(href.initializer);
    assert.ok(ts.isStringLiteral(value));
    return value.text;
  });
}

test("Career brand is a home link without nesting the mobile close button", async () => {
  const source = await readFile(new URL("app/career/CareerApp.tsx", projectRoot), "utf8");
  const brandStart = source.indexOf('<Link href="/" className="career-brand" aria-label="返回私人工作台">');
  assert.notEqual(brandStart, -1);
  const brandEnd = source.indexOf("</Link>", brandStart);
  assert.ok(brandEnd > brandStart);
  assert.doesNotMatch(source.slice(brandStart, brandEnd), /<button\b/);
  assert.match(source.slice(brandEnd), /data-sidebar-close/);
});

test("landing shortcuts and cards share the typed suite-space registry", async () => {
  const source = await readFile(new URL("app/page.tsx", projectRoot), "utf8");
  assert.equal((source.match(/suiteSpaces\.map/g) ?? []).length, 2);
  assert.match(source, /aria-label="选择空间"/);
  assert.match(source, /aria-label=\{`进入\$\{space\.name\}空间`\}/);
});

test("landing privacy copy distinguishes local defaults from deliberate AI context", async () => {
  const source = await readFile(new URL("app/page.tsx", projectRoot), "utf8");
  assert.match(source, /默认保存在本浏览器/);
  assert.match(source, /只有你主动使用 AI 功能时/);
  assert.match(source, /该次请求所需的最少上下文/);
  assert.match(source, /清除站点数据仍会影响资料/);
});

test("global CSS contains only reset and suite landing styles", async () => {
  const source = await readFile(new URL("app/globals.css", projectRoot), "utf8");
  const classNames = [...source.matchAll(/\.([_a-zA-Z][_a-zA-Z0-9-]*)/g)]
    .map((match) => match[1]);
  assert.deepEqual(
    [...new Set(classNames.filter((className) => !className.startsWith("suite-")))],
    [],
    "product-specific prototypes belong in their product stylesheet, never globals.css",
  );

  assert.match(source, /^@import\s*"tailwindcss";/);
  assert.match(source, /\.suite-home\s*\{/);
  assert.match(source, /\.suite-career\s*\{/);
  assert.match(source, /\.suite-vocab\s*\{/);
  assert.match(source, /\.suite-fitness\s*\{/);
  assert.match(source, /@media\s*\(min-width:\s*651px\)\s*and\s*\(max-width:\s*919px\)/);
  assert.match(source, /@media\s*\(max-width:\s*650px\)/);
  assert.match(source, /@media\s*\(max-width:\s*360px\)/);
  assert.match(source, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test("landing focus and wrapping stay accessible as the registry grows", async () => {
  const source = await readFile(new URL("app/globals.css", projectRoot), "utf8");
  assert.match(source, /\.suite-home a:focus-visible\s*\{[^}]*outline:\s*3px solid #0057b8/i);
  assert.match(source, /\.suite-choices\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap[^}]*justify-content:\s*center/s);
  assert.match(source, /\.suite-card\s*\{[^}]*max-width:\s*calc\(\(100%\s*-\s*32px\)\s*\/\s*3\)/s);
  assert.match(source, /@media\s*\(min-width:\s*651px\)\s*and\s*\(max-width:\s*919px\)\s*\{[\s\S]*?\.suite-card\s*\{[^}]*max-width:\s*calc\(\(100%\s*-\s*16px\)\s*\/\s*2\)/);
  assert.match(source, /@media\s*\(max-width:\s*650px\)\s*\{[\s\S]*?\.suite-shortcuts a\s*\{[^}]*flex:\s*1 1 80px[^}]*max-width:\s*110px|@media\s*\(max-width:\s*650px\)\s*\{[\s\S]*?\.suite-shortcuts a\s*\{[^}]*max-width:\s*110px[^}]*flex:\s*1 1 80px/);
  assert.doesNotMatch(source, /\.(?:suite-card|suite-choices|suite-shortcuts)[^{]*:nth-child\(/);

  const relativeLuminance = (hex) => {
    const channel = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * channel[0] + .7152 * channel[1] + .0722 * channel[2];
  };
  const focusLuminance = relativeLuminance("#0057b8");
  const adjacentLuminance = relativeLuminance("#f5f5f7");
  assert.ok((adjacentLuminance + .05) / (focusLuminance + .05) >= 3);
});

test("suite registry flows through registration instead of being duplicated in the worker", async () => {
  const layout = await readFile(new URL("app/layout.tsx", projectRoot), "utf8");
  const registration = await readFile(new URL("app/OfflineRegistration.tsx", projectRoot), "utf8");
  const worker = await readFile(new URL("public/sw.js", projectRoot), "utf8");
  const configuredRoutes = await suiteRoutes();

  assert.match(layout, /import \{ suiteSpaces \} from "\.\/suite-spaces"/);
  assert.match(layout, /suiteSpaces\.map\(\(space\) => space\.href\)/);
  assert.match(layout, /<OfflineRegistration routes=\{offlineRoutes\}/);
  assert.match(registration, /routes: readonly string\[\]/);
  assert.match(registration, /new Set\(\["\/", \.\.\.routes\]\)/);
  assert.match(registration, /controller\.postMessage\(\{/);
  assert.match(registration, /type: SYNC_SUITE_ROUTES/);
  assert.match(registration, /routes\.forEach\(\(route\) => router\.prefetch\(route\)\)/);
  assert.match(worker, /event\.data\?\.type !== SYNC_SUITE_ROUTES/);
  assert.match(worker, /event\.waitUntil\(prefetchSuiteRoutes\(event\.data\.routes\)\)/);
  for (const route of configuredRoutes) assert.doesNotMatch(worker, new RegExp(`["']${route}["']`));
});

test("offline sync caches each HTML document and its same-origin script and link assets", async () => {
  const source = await readFile(new URL("public/sw.js", projectRoot), "utf8");
  assert.match(source, /const CACHE_NAME = "private-ai-suite-v2"/);
  assert.match(source, /html\.match\(\/<\(\?:script\|link\)/);
  assert.match(source, /\\b\(\?:src\|href\)/);
  assert.match(source, /new URL\(value, pageUrl\)/);
  assert.match(source, /isCacheableSameOriginUrl\(url\)/);
  assert.match(source, /!url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(source, /!url\.pathname\.startsWith\("\/__"\)/);
  assert.match(source, /await cache\.put\(request, response\.clone\(\)\)/);
  assert.match(source, /Promise\.all\(assets\.map\(\(assetUrl\) => cacheAsset\(cache, assetUrl\)\)\)/);
  assert.match(source, /Promise\.all\(normalizeSuiteRoutes\(routes\)\.map/);
  assert.match(source, /catch \{[\s\S]*?remaining spaces from syncing/);
  assert.match(source, /\["script", "style", "worker", "font", "image"\]\.includes\(request\.destination\)/);
});
