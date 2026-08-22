import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

async function loadStandaloneTypeScriptModule(relativePath) {
  const source = await readFile(new URL(relativePath, projectRoot), "utf8");
  const { outputText, diagnostics = [] } = ts.transpileModule(source, {
    fileName: relativePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  assert.deepEqual(
    diagnostics.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

const srs = await loadStandaloneTypeScriptModule("lib/vocab/srs.ts");

function card(overrides = {}) {
  return {
    id: "card-1",
    lexeme_id: "lexeme-1",
    headword: "steady",
    pronunciation: "",
    gloss_en: "stable",
    context_sentence: "A steady pace can help.",
    context_surface: "steady",
    cloze_sentence: "A ____ pace can help.",
    state: "review",
    due_at: 0,
    interval_days: 5,
    ease: 2.5,
    reps: 3,
    lapses: 0,
    last_review_at: null,
    algorithm_version: 2,
    suspended_from_state: null,
    suspended_reason: null,
    updated_at: 0,
    ...overrides,
  };
}

test("SRS v2 produces deterministic transitions for every rating", () => {
  const now = 1_800_000_000_000;
  const again = srs.scheduleReviewV2(card(), "again", now);
  assert.equal(again.state, "relearning");
  assert.equal(again.reps, 4);
  assert.equal(again.lapses, 1);
  assert.equal(again.ease, 2.3);
  assert.equal(again.due_at, now + 10 * 60_000);

  const hard = srs.scheduleReviewV2(card(), "hard", now);
  assert.equal(hard.interval_days, 6);
  assert.equal(hard.ease, 2.45);

  const good = srs.scheduleReviewV2(card(), "good", now);
  assert.equal(good.interval_days, 12.5);
  assert.equal(good.state, "review");

  const easy = srs.scheduleReviewV2(card(), "easy", now);
  assert.equal(easy.interval_days, 14.25);
  assert.equal(easy.ease, 2.6);
  assert.equal(easy.algorithm_version, 2);
});

test("daily new limit excludes only new cards", () => {
  const now = 1_800_000_000_000;
  const cards = [
    card({ id: "new-1", state: "new", due_at: now - 3 }),
    card({ id: "review-1", state: "review", due_at: now - 2 }),
    card({ id: "learning-1", state: "learning", due_at: now - 1 }),
    card({ id: "new-2", state: "new", due_at: now }),
  ];
  const limited = srs.applyDailyNewLimit(cards, 1, 0, now);
  assert.deepEqual(
    limited.map(({ id, queue_eligible }) => [id, queue_eligible]),
    [
      ["new-1", true],
      ["review-1", true],
      ["learning-1", true],
      ["new-2", false],
    ],
  );

  const exhausted = srs.applyDailyNewLimit(cards, 1, 1, now);
  assert.equal(exhausted.find(({ id }) => id === "new-1").queue_eligible, false);
  assert.equal(exhausted.find(({ id }) => id === "review-1").queue_eligible, true);
  assert.equal(exhausted.find(({ id }) => id === "learning-1").queue_eligible, true);
});

test("context cloze treats regex punctuation as ordinary text", () => {
  assert.equal(
    srs.createContextCloze("C++ remains useful in systems work.", "C++"),
    "____ remains useful in systems work.",
  );
  assert.equal(
    srs.createContextCloze("Choose (carefully) before acting.", "(carefully)"),
    "Choose ____ before acting.",
  );
  assert.equal(
    srs.createContextCloze("A dot. is literal here.", "dot."),
    "A ____ is literal here.",
  );
});

test("review suspension follows explanation availability without overriding manual pauses", () => {
  assert.equal(srs.hasUsefulEnglishExplanation("No definition yet"), false);
  assert.equal(srs.hasUsefulEnglishExplanation("", "chosen with care"), true);
  const missing = srs.reconcileReviewSuspension({
    state: "new",
    suspended_from_state: null,
    suspended_reason: null,
  }, "saved", false);
  assert.deepEqual(missing, {
    state: "suspended",
    suspended_from_state: "new",
    suspended_reason: "lexeme_saved",
  });
  const stillSaved = srs.reconcileReviewSuspension(missing, "saved", true);
  assert.deepEqual(stillSaved, missing, "saved never enters the active queue");
  const learning = srs.reconcileReviewSuspension(stillSaved, "learning", true);
  assert.deepEqual(learning, {
    state: "new",
    suspended_from_state: null,
    suspended_reason: null,
  });
  assert.deepEqual(
    srs.reconcileReviewSuspension(learning, "saved", true),
    { state: "suspended", suspended_from_state: "new", suspended_reason: "lexeme_saved" },
    "learning to saved dynamically leaves the queue",
  );
  const manual = {
    state: "suspended",
    suspended_from_state: "review",
    suspended_reason: "manual_pause",
  };
  assert.deepEqual(
    srs.reconcileReviewSuspension(manual, "known", true),
    manual,
  );
});

test("local study day rolls over at the browser's local midnight", () => {
  const previous = process.env.TZ;
  process.env.TZ = "Asia/Singapore";
  try {
    const timestamp = Date.parse("2026-08-20T16:30:00.000Z");
    assert.equal(srs.localDayKey(timestamp), "2026-08-21");
    assert.deepEqual(srs.localDayBounds(timestamp), {
      start: Date.parse("2026-08-20T16:00:00.000Z"),
      end: Date.parse("2026-08-21T16:00:00.000Z"),
    });
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("new-review detection ignores corrupt legacy event JSON", () => {
  assert.equal(srs.reviewEventStartedAsNew('{"state":"new"}'), true);
  assert.equal(srs.reviewEventStartedAsNew('{"state":"review"}'), false);
  assert.equal(srs.reviewEventStartedAsNew("not json"), false);
});
