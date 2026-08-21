import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, projectRoot), "utf8");
}

async function loadStandaloneTypeScriptModule(relativePath) {
  const input = await source(relativePath);
  const { outputText, diagnostics = [] } = ts.transpileModule(input, {
    fileName: relativePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  assert.deepEqual(
    diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error),
    [],
  );
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

function card(id, overrides = {}) {
  return {
    id,
    lexeme_id: `lexeme-${id}`,
    headword: id,
    pronunciation: "",
    gloss_en: "meaning",
    context_sentence: `${id} in context`,
    context_surface: id,
    cloze_sentence: "____ in context",
    state: "review",
    due_at: 0,
    interval_days: 1,
    ease: 2.5,
    reps: 1,
    lapses: 0,
    last_review_at: null,
    algorithm_version: 2,
    suspended_from_state: null,
    suspended_reason: null,
    updated_at: 0,
    queue_eligible: true,
    ...overrides,
  };
}

test("a calm review round snapshots at most five cards without truncating the due source", async () => {
  const round = await loadStandaloneTypeScriptModule("lib/vocab/review-round.ts");
  const due = Array.from({ length: 9 }, (_, index) => card(`card-${index + 1}`));
  const before = due.map(({ id }) => id);

  const ids = round.startReviewRound(due);
  assert.deepEqual(ids, before.slice(0, 5));
  assert.deepEqual(due.map(({ id }) => id), before);
  assert.equal(due.length, 9, "the global due list remains intact");

  const stillDue = due.filter(({ id }) => id !== "card-1");
  assert.deepEqual(
    round.resolveReviewRound(stillDue, ids).map(({ id }) => id),
    ["card-2", "card-3", "card-4", "card-5"],
  );
  assert.deepEqual(
    round.restoreUndoneCardToRound(["card-6", "card-7", "card-8", "card-9", "card-10"], "card-1"),
    ["card-1", "card-6", "card-7", "card-8", "card-9"],
  );
});

test("zero daily new words pauses only new cards, never old due learning states", async () => {
  const srs = await loadStandaloneTypeScriptModule("lib/vocab/srs.ts");
  const now = 1_800_000_000_000;
  const cards = [
    card("new", { state: "new", due_at: now - 4 }),
    card("review", { state: "review", due_at: now - 3 }),
    card("learning", { state: "learning", due_at: now - 2 }),
    card("relearning", { state: "relearning", due_at: now - 1 }),
  ];
  const limited = srs.applyDailyNewLimit(cards, 0, 0, now);
  assert.deepEqual(
    limited.map(({ id, queue_eligible }) => [id, queue_eligible]),
    [
      ["new", false],
      ["review", true],
      ["learning", true],
      ["relearning", true],
    ],
  );
});

test("review UI uses a bounded optional round and never renders a debt meter", async () => {
  const views = await source("app/vocab/views.tsx");
  assert.match(views, /useState\(\(\) => startReviewRound\(due\)\)/);
  assert.match(views, /resolveReviewRound\(roundSource, roundIds\)/);
  assert.match(views, /随时停在这里，下次会从仍适合回看的词继续/);
  assert.match(views, /其他词会留在原处，想继续时再来/);
  assert.doesNotMatch(views, /className="sc-review-progress"/);
  assert.doesNotMatch(views, /\{reviewed\}\s*<\/strong>\s*<span>\s*\/\s*\{total\}/);
  assert.doesNotMatch(views, /个词可以继续回看|剩余\s*\{|清完|今日任务/);
  assert.doesNotMatch(views, /<strong>\{due\}<\/strong>/);
  assert.match(views, /onGo\(hasDue \? "review" : "words"\)/);
});

test("review focus moves only after a successful receipt-backed rating", async () => {
  const views = await source("app/vocab/views.tsx");
  assert.match(views, /const eventId = await onRate\(card, rating\)/);
  assert.match(views, /setLastEvent\(eventId\)/);
  assert.match(views, /setRoundIds\(\(current\) => current\.filter\(\(id\) => id !== card\.id\)\)/);
  assert.match(views, /setLocallyRatedVersions\(\(current\) => \(\{ \.\.\.current, \[card\.id\]: card\.updated_at \}\)\)/);
  assert.match(views, /handOffFocus\.current = true/);
  assert.match(views, /const target = card \? revealButton\.current : completeHeading\.current/);
  assert.match(views, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(views, /<h1 ref=\{completeHeading\} tabIndex=\{-1\}/);
  assert.match(views, /catch \(caught\) \{\s*setError/);
  const submitStart = views.indexOf("const submit = useCallback");
  const undoStart = views.indexOf("const undoLast = useCallback", submitStart);
  const submit = views.slice(submitStart, undoStart);
  assert.ok(submit.indexOf("handOffFocus.current = true") > submit.indexOf("await onRate(card, rating)"));
  assert.doesNotMatch(submit.slice(submit.indexOf("catch (caught)")), /handOffFocus\.current = true/);
});

test("durable review writes resolve even when the following page refresh fails", async () => {
  const app = await source("app/vocab/VocabApp.tsx");
  assert.match(
    app,
    /const id = await rateReview\(card, rating\); try \{ await refresh\(\); \} catch \{ setToast\("评分已记录，页面暂未重读；这一小轮仍可继续"\); \} return id;/,
  );
  assert.match(
    app,
    /await undoReview\(id\); try \{ await refresh\(\); \} catch \{ setToast\("评分已撤销，页面暂未重读；数据库不会重复改写"\); \}/,
  );
  assert.doesNotMatch(app, /await rateReview\(card, rating\); await refresh\(\)/);
  assert.doesNotMatch(app, /await undoReview\(id\); await refresh\(\)/);
});

test("zero activity stays blank while sub-minute activity remains truthful", async () => {
  const [views, css] = await Promise.all([
    source("app/vocab/views.tsx"),
    source("app/vocab/vocab.css"),
  ]);
  assert.match(views, /seconds === 0 \? "无记录" : seconds < 60 \? "少于 1 分钟"/);
  assert.match(views, /day\.seconds > 0 && <i/);
  assert.match(views, /totalSeconds === 0[\s\S]*sc-chart-empty/);
  assert.match(views, /totalSeconds > 0[\s\S]*sc-balance-ring/);
  assert.doesNotMatch(views, /Math\.max\(2,\s*day\.minutes/);
  assert.match(css, /\.sc-chart-empty\{/);
  assert.match(css, /\.sc-balance-empty\{/);
});

test("mobile closed navigation is inert and zero is an explicit review setting", async () => {
  const [app, views] = await Promise.all([
    source("app/vocab/VocabApp.tsx"),
    source("app/vocab/views.tsx"),
  ]);
  assert.match(app, /function useVocabMobileLayout\(\)/);
  assert.match(app, /window\.matchMedia\("\(max-width: 760px\)"\)/);
  assert.match(app, /const sidebarHidden = mobile && !sideOpen/);
  assert.match(app, /useOverlayDialog<HTMLElement>\(mobile && sideOpen/);
  assert.match(app, /role=\{mobile && sideOpen \? "dialog" : undefined\}/);
  assert.match(app, /aria-modal=\{mobile && sideOpen \? true : undefined\}/);
  assert.match(app, /if \(!query\.matches\) setSideOpen\(false\)/);
  assert.match(app, /aria-hidden=\{sidebarHidden \|\| undefined\} inert=\{sidebarHidden \|\| undefined\}/);
  assert.ok((app.match(/tabIndex=\{sidebarHidden \? -1 : undefined\}/g) ?? []).length >= 3);
  assert.match(app, /<ReviewView[\s\S]*onGo=\{go\}/);
  assert.match(views, /id="sc-daily-limit" type="range" min="0" max="30"/);
  assert.match(views, /暂停加入新词/);
  assert.match(views, /已到期、学习中和重新学习的词不受影响/);
});
