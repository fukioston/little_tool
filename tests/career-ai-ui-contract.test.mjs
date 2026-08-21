import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const sourceUrl = new URL("../app/career/CareerApp.tsx", import.meta.url);
const cssUrl = new URL("../app/career/career.css", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const css = await readFile(cssUrl, "utf8");

function dataModule(value, name) {
  return `data:text/javascript;base64,${Buffer.from(`${value}\n//# sourceURL=${name}`).toString("base64")}`;
}

async function transpileTypeScript(relativePath) {
  const value = await readFile(new URL(relativePath, projectRoot), "utf8");
  const { outputText, diagnostics = [] } = ts.transpileModule(value, {
    fileName: relativePath,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
  });
  assert.deepEqual(diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  return outputText;
}

const payloads = await import(dataModule(
  await transpileTypeScript("lib/career/ai-payload.ts"),
  "lib/career/ai-payload.ts",
));

async function loadClientHelpers() {
  const sourceFile = ts.createSourceFile(sourceUrl.pathname, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const wanted = new Set([
    "isCareerAiClientAction",
    "createCareerAiClientRequest",
    "fetchCareerAiClientRequest",
    "careerAiDisclosureText",
  ]);
  const declarations = sourceFile.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name && wanted.has(statement.name.text),
  );
  assert.equal(declarations.length, wanted.size);
  const helperSource = `${declarations.map((item) => item.getText(sourceFile)).join("\n")}\nexport { ${[...wanted].join(", ")} };`;
  const { outputText, diagnostics = [] } = ts.transpileModule(helperSource, {
    fileName: "career-ai-ui-helpers.ts",
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  assert.deepEqual(diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  return import(dataModule(outputText, "career-ai-ui-helpers.ts"));
}

const helpers = await loadClientHelpers();
const runAiStart = source.indexOf("async function runAi");
const runAiEnd = source.indexOf("function navigate", runAiStart);
const runAiSource = source.slice(runAiStart, runAiEnd);
const privateTokens = [
  "PRIVATE_JOB_ID",
  "PRIVATE_INTERVIEW_ID",
  "PRIVATE_NOTE",
  "PRIVATE_CONTACT",
  "PRIVATE_SOURCE_URL",
  "PRIVATE_SALARY",
  "PRIVATE_TAGS",
  "PRIVATE_MEETING_URL",
  "PRIVATE_STATUS",
  "PRIVATE_CREATED_AT",
  "PRIVATE_UPDATED_AT",
  "PRIVATE_LIFECYCLE",
  "PRIVATE_EXTRA",
];

function sensitiveJob(overrides = {}) {
  return {
    id: "PRIVATE_JOB_ID",
    company: "Arc Labs",
    role: "Product Designer",
    description: "Design calm product experiences.",
    location: "Singapore",
    work_mode: "hybrid",
    note: "PRIVATE_NOTE",
    contact_name: "PRIVATE_CONTACT",
    source_url: "PRIVATE_SOURCE_URL",
    salary: "PRIVATE_SALARY",
    tags: "PRIVATE_TAGS",
    created_at: "PRIVATE_CREATED_AT",
    updated_at: "PRIVATE_UPDATED_AT",
    lifecycle_metadata: "PRIVATE_LIFECYCLE",
    extra: "PRIVATE_EXTRA",
    ...overrides,
  };
}

function sensitiveInterview(overrides = {}) {
  return {
    id: "PRIVATE_INTERVIEW_ID",
    round_name: "Portfolio review",
    scheduled_at: "2026-08-22T06:00:00.000Z",
    duration: 60,
    interviewer: "Mina",
    meeting_url: "PRIVATE_MEETING_URL",
    status: "PRIVATE_STATUS",
    created_at: "PRIVATE_CREATED_AT",
    updated_at: "PRIVATE_UPDATED_AT",
    lifecycle_metadata: "PRIVATE_LIFECYCLE",
    extra: "PRIVATE_EXTRA",
    ...overrides,
  };
}

async function captureBrowserBody(action, rawPayload) {
  const calls = [];
  const prepared = helpers.createCareerAiClientRequest(action, rawPayload, payloads.sanitizeCareerAiRequestPayload);
  await helpers.fetchCareerAiClientRequest(prepared, undefined, async (url, init) => {
    calls.push({ url, init });
    return { ok: true };
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/ai/career");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { "content-type": "application/json" });
  return JSON.parse(calls[0].init.body);
}

function assertNoPrivateTokens(value) {
  const serialized = JSON.stringify(value);
  for (const token of privateTokens) assert.equal(serialized.includes(token), false, `${token} crossed the browser AI boundary`);
}

test("browser request bodies contain only each action's exact client whitelist", async () => {
  const fit = await captureBrowserBody("fit_analysis", {
    job: sensitiveJob(),
    interview: sensitiveInterview(),
    top_level_secret: "PRIVATE_EXTRA",
  });
  assert.deepEqual(Object.keys(fit), ["action", "payload"]);
  assert.equal(fit.action, "fit_analysis");
  assert.deepEqual(Object.keys(fit.payload), ["job"]);
  assert.deepEqual(Object.keys(fit.payload.job), ["company", "role", "description"]);
  assertNoPrivateTokens(fit);

  const prep = await captureBrowserBody("interview_prep", {
    job: sensitiveJob(),
    interview: sensitiveInterview(),
    top_level_secret: "PRIVATE_EXTRA",
  });
  assert.equal(prep.action, "interview_prep");
  assert.deepEqual(Object.keys(prep.payload.job), ["company", "role", "description", "location", "work_mode"]);
  assert.deepEqual(Object.keys(prep.payload.interview), ["round_name", "scheduled_at", "duration", "interviewer"]);
  assertNoPrivateTokens(prep);

  const structure = await captureBrowserBody("structure_interview", {
    job: sensitiveJob({ description: "PRIVATE_EXTRA", location: "PRIVATE_EXTRA", work_mode: "PRIVATE_EXTRA" }),
    interview: sensitiveInterview({
      summary: "A grounded summary",
      raw_notes: "Current controlled notes",
      questions: [{ question: "Current question", answer: "Current answer", note: "Current note", extra: "PRIVATE_EXTRA" }],
      reflection: "Current reflection",
    }),
    top_level_secret: "PRIVATE_EXTRA",
  });
  assert.equal(structure.action, "structure_interview");
  assert.deepEqual(Object.keys(structure.payload.job), ["company", "role"]);
  assert.deepEqual(Object.keys(structure.payload.interview), ["round_name", "summary", "raw_notes", "questions", "reflection"]);
  assert.deepEqual(Object.keys(structure.payload.interview.questions[0]), ["question", "answer", "note"]);
  assertNoPrivateTokens(structure);
});

test("missing facts and every non-exact action stop before fetch", async () => {
  let fetchCalls = 0;
  const fakeFetch = async () => { fetchCalls += 1; return { ok: true }; };
  async function tryClient(action, rawPayload, sanitize = payloads.sanitizeCareerAiRequestPayload) {
    const prepared = helpers.createCareerAiClientRequest(action, rawPayload, sanitize);
    return helpers.fetchCareerAiClientRequest(prepared, undefined, fakeFetch);
  }

  await assert.rejects(
    tryClient("fit_analysis", { job: { company: "Arc", role: "Designer", description: "" } }),
    (error) => error.code === "CAREER_AI_PAYLOAD_REQUIRED_FIELDS",
  );
  await assert.rejects(
    tryClient("interview_prep", { job: { company: "Arc", role: "" }, interview: { round_name: "" } }),
    (error) => error.code === "CAREER_AI_PAYLOAD_REQUIRED_FIELDS",
  );
  assert.equal(fetchCalls, 0);

  let sanitizerCalls = 0;
  for (const action of ["fitAnalysis", "interviewPrep", "structureInterview", "parse_job", "__proto__"]) {
    await assert.rejects(
      tryClient(action, { token: "PRIVATE_EXTRA" }, () => { sanitizerCalls += 1; return {}; }),
      (error) => error.code === "CAREER_AI_ACTION_NOT_ALLOWED",
    );
  }
  assert.equal(sanitizerCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("runAi sanitizes synchronously before request state or fetch", () => {
  const createIndex = runAiSource.indexOf("createCareerAiClientRequest(action, payload)");
  const requestStateIndex = runAiSource.indexOf("aiRequestRef.current?.controller.abort()");
  const fetchIndex = runAiSource.indexOf("fetchCareerAiClientRequest(clientRequest");
  assert.ok(createIndex >= 0 && createIndex < requestStateIndex && requestStateIndex < fetchIndex);
  assert.match(runAiSource, /notify\(careerAiClientIssueText\(action, error\), "info"\);[\s\S]*?return;/);
  assert.doesNotMatch(runAiSource, /fetch\(|JSON\.stringify\(\{ action, payload \}\)/);
  assert.match(source, /请先补全公司、职位和职位描述[\s\S]*?这次没有发送任何内容/);
  assert.match(source, /请先补全公司、职位和面试轮次[\s\S]*?这次没有发送任何内容/);
});

test("all four UI entries expose only the three narrowed actions", () => {
  const actions = [...source.matchAll(/onAi\(\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(actions.sort(), ["fit_analysis", "interview_prep", "interview_prep", "structure_interview"].sort());
  assert.equal((source.match(/className="career-button [^"]*career-ai-trigger"/g) ?? []).length, 4);
  assert.match(source, /\{ job, interview: \{ round_name: interview\.round_name, summary, raw_notes: rawNotes, questions, reflection \} \}/);
  assert.doesNotMatch(source, /structure_interview[\s\S]{0,240}\{ \.\.\.interview/);
  assert.doesNotMatch(source, /structure_interview[\s\S]{0,240}status,/);
});

test("entry and preview disclosures derive from one action-to-field mapping", () => {
  const mappingStart = source.indexOf("const CAREER_AI_SHARED_FIELDS_BY_ACTION");
  const mappingEnd = source.indexOf("function isCareerAiClientAction", mappingStart);
  const mappingSource = source.slice(mappingStart, mappingEnd);
  assert.doesNotMatch(mappingSource, /\bexport\b/);
  assert.match(mappingSource, /fit_analysis: CAREER_REQUIREMENTS_SHARED_FIELDS/);
  assert.match(mappingSource, /interview_prep: CAREER_INTERVIEW_PREP_SHARED_FIELDS/);
  assert.match(mappingSource, /structure_interview: CAREER_STRUCTURE_INTERVIEW_SHARED_FIELDS/);
  assert.match(source, /<CareerAiDisclosure action=\{state\.action\} className="in-preview" \/>/);
  assert.equal((source.match(/<CareerAiDisclosure action=/g) ?? []).length, 5);

  assert.equal(
    helpers.careerAiDisclosureText("fit_analysis", payloads.CAREER_REQUIREMENTS_SHARED_FIELDS),
    "发送给 DeepSeek：公司、职位、职位描述。结果不会自动保存。",
  );
  assert.equal(
    helpers.careerAiDisclosureText("interview_prep", payloads.CAREER_INTERVIEW_PREP_SHARED_FIELDS),
    "发送给 DeepSeek：公司、职位、职位描述、地点、工作方式、面试轮次、计划时间、预计时长、面试官。结果不会自动保存。",
  );
  assert.equal(
    helpers.careerAiDisclosureText("structure_interview", payloads.CAREER_STRUCTURE_INTERVIEW_SHARED_FIELDS),
    "发送给 DeepSeek：公司、职位、面试轮次、一句话总结、原始速记、问题、回答、问题备注、复盘与下一步；不发送面试状态、会议链接或职位备注。结果不会自动保存。",
  );
});

test("AI disclosure remains calm and usable at 319px", () => {
  assert.match(css, /\.career-ai-disclosure \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\.career-ai-trigger \{ min-height: 44px; \}/);
  assert.match(css, /\.career-ai-preview \.career-button \{ min-height: 44px; \}/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.career-ai-disclosure \{ max-width: 100%; \}/);
  assert.match(css, /@media \(max-width: 420px\)[\s\S]*?\.career-experience-toolbar \{ align-items: stretch; flex-direction: column;/);
  assert.doesNotMatch(source, /保护率|风险分|数据安全评分|本地\s*AI/);
});
