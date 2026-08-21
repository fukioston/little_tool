import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

test("Career brand is a home link without nesting the mobile close button", async () => {
  const source = await readFile(new URL("app/career/CareerApp.tsx", projectRoot), "utf8");
  const brandStart = source.indexOf('<Link href="/" className="career-brand" aria-label="返回私人工作台">');
  assert.notEqual(brandStart, -1);
  const brandEnd = source.indexOf("</Link>", brandStart);
  assert.ok(brandEnd > brandStart);
  assert.doesNotMatch(source.slice(brandStart, brandEnd), /<button\b/);
  assert.match(source.slice(brandEnd), /data-sidebar-close/);
});

test("offline app shell contains every suite entry exactly once", async () => {
  const source = await readFile(new URL("public/sw.js", projectRoot), "utf8");
  const declaration = /const APP_SHELL = (\[[^;]+\]);/.exec(source);
  assert.ok(declaration);
  const routes = JSON.parse(declaration[1]);
  assert.deepEqual(routes, ["/", "/career", "/vocab", "/fitness"]);
  assert.equal(new Set(routes).size, routes.length);
});
