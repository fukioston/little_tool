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

test("offline app shell contains every configured suite entry exactly once", async () => {
  const source = await readFile(new URL("public/sw.js", projectRoot), "utf8");
  const declaration = /const APP_SHELL = (\[[^;]+\]);/.exec(source);
  assert.ok(declaration);
  const routes = JSON.parse(declaration[1]);
  const configuredRoutes = await suiteRoutes();
  assert.deepEqual(routes, ["/", ...configuredRoutes]);
  assert.equal(new Set(routes).size, routes.length);
});
