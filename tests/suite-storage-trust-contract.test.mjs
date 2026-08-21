import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

const readProjectFile = (path) => readFile(new URL(path, projectRoot), "utf8");

test("storage card shows the exact current origin without probing or navigating elsewhere", async () => {
  const source = await readProjectFile("app/StorageTrustCard.tsx");

  assert.match(source, /^"use client";/);
  assert.match(source, /window\.location\.origin/);
  assert.match(source, /当前完整地址/);
  assert.match(source, /aria-live="polite"/);
  assert.doesNotMatch(
    source,
    /\b(?:fetch|XMLHttpRequest|WebSocket)\b|location\.(?:assign|replace)|window\.open/,
  );
});

test("storage card explains address isolation, shared risk, and three-backup migration", async () => {
  const source = await readProjectFile("app/StorageTrustCard.tsx");

  assert.match(source, /完整地址，加上你现在使用的浏览器资料/);
  assert.match(source, /换主机名、端口或浏览器资料/);
  assert.match(source, /容量不足，或清除这个地址的资料，都可能同时影响三处/);
  assert.match(source, /数据库、附件归处与完整备份各自独立/);
  assert.match(source, /不能彼此替代/);
  assert.match(source, /分别从三个空间准备完整备份，一共 3 份/);
});

test("landing renders the storage truth after the space choices", async () => {
  const source = await readProjectFile("app/page.tsx");
  const choices = source.indexOf('<section className="suite-choices"');
  const storage = source.indexOf("<StorageTrustCard />");

  assert.match(source, /import \{ StorageTrustCard \} from "\.\/StorageTrustCard"/);
  assert.ok(choices >= 0 && storage > choices);
  assert.equal((source.match(/<StorageTrustCard \/>/g) ?? []).length, 1);
});

test("storage truth remains calm, touchable, and bounded at 319px", async () => {
  const component = await readProjectFile("app/StorageTrustCard.tsx");
  const css = await readProjectFile("app/globals.css");

  assert.match(component, /<details className="suite-storage-details">/);
  assert.match(component, /<summary>/);
  assert.match(css, /\.suite-storage\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.suite-storage-details summary\s*\{[^}]*min-height:\s*48px/s);
  assert.match(css, /\.suite-storage-details summary:focus-visible\s*\{[^}]*outline:\s*3px solid #0057b8/s);
  assert.match(css, /\.suite-storage-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,minmax\(min\(100%,210px\),1fr\)\)/s);
  assert.match(css, /\.suite-storage-origin code\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/s);
  assert.match(css, /@media\s*\(max-width:\s*360px\)\s*\{[\s\S]*?\.suite-storage\s*\{[^}]*padding:\s*21px 15px/);
});
