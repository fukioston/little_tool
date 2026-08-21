import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

function dataModule(source, sourceName) {
  const sourceUrl = `\n//# sourceURL=${sourceName.replaceAll(" ", "%20")}`;
  return `data:text/javascript;base64,${Buffer.from(`${source}${sourceUrl}`).toString("base64")}`;
}

async function transpileStandaloneTypeScript(relativePath) {
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
    diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error),
    [],
  );
  return outputText;
}

const payloadModuleUrl = dataModule(
  await transpileStandaloneTypeScript("lib/career/ai-payload.ts"),
  "lib/career/ai-payload.ts",
);
const payloads = await import(payloadModuleUrl);
const PRIVATE_TOKENS = [
  "PRIVATE_NOTE",
  "PRIVATE_CONTACT",
  "PRIVATE_SOURCE_URL",
  "PRIVATE_SALARY",
  "PRIVATE_TAGS",
  "PRIVATE_MEETING_URL",
  "PRIVATE_SUMMARY",
  "PRIVATE_RAW_NOTES",
  "PRIVATE_QUESTIONS",
  "PRIVATE_REFLECTION",
  "PRIVATE_STATUS",
  "PRIVATE_CREATED_AT",
  "PRIVATE_UPDATED_AT",
];

function sensitiveJob(overrides = {}) {
  return {
    id: "PRIVATE_JOB_ID",
    company: "  Arc\nLabs  ",
    role: " Product\tEngineer ",
    description: "Build tools.\r\n\r\n\r\nWork with design.",
    location: " Singapore\nRemote ",
    work_mode: " hybrid ",
    note: "PRIVATE_NOTE",
    contact_name: "PRIVATE_CONTACT",
    source_url: "PRIVATE_SOURCE_URL",
    salary: "PRIVATE_SALARY",
    tags: "PRIVATE_TAGS",
    created_at: "PRIVATE_CREATED_AT",
    updated_at: "PRIVATE_UPDATED_AT",
    ...overrides,
  };
}

function sensitiveInterview(overrides = {}) {
  return {
    id: "PRIVATE_INTERVIEW_ID",
    round_name: " Technical\nInterview ",
    scheduled_at: "2026-08-22T06:00:00.000Z",
    duration: 60,
    interviewer: " Jason\tLin ",
    meeting_url: "PRIVATE_MEETING_URL",
    summary: "PRIVATE_SUMMARY",
    raw_notes: "PRIVATE_RAW_NOTES",
    questions_json: "PRIVATE_QUESTIONS",
    reflection: "PRIVATE_REFLECTION",
    status: "PRIVATE_STATUS",
    created_at: "PRIVATE_CREATED_AT",
    updated_at: "PRIVATE_UPDATED_AT",
    ...overrides,
  };
}

function assertNoPrivateTokens(value) {
  const serialized = JSON.stringify(value);
  for (const token of PRIVATE_TOKENS) {
    assert.equal(serialized.includes(token), false, `${token} must stay local`);
  }
}

test("requirements payload contains only its disclosed immutable whitelist", () => {
  const result = payloads.buildCareerRequirementsPayload(sensitiveJob());

  assert.deepEqual(result, {
    job: {
      company: "Arc Labs",
      role: "Product Engineer",
      description: "Build tools.\n\nWork with design.",
    },
  });
  assert.deepEqual(Object.keys(result), ["job"]);
  assert.deepEqual(Object.keys(result.job), ["company", "role", "description"]);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.getPrototypeOf(result.job), Object.prototype);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.job), true);
  assertNoPrivateTokens(result);
});

test("interview-prep payload excludes every private note and unused lifecycle field", () => {
  const result = payloads.buildCareerInterviewPrepPayload(
    sensitiveJob(),
    sensitiveInterview(),
  );

  assert.deepEqual(result, {
    job: {
      company: "Arc Labs",
      role: "Product Engineer",
      description: "Build tools.\n\nWork with design.",
      location: "Singapore Remote",
      work_mode: "hybrid",
    },
    interview: {
      round_name: "Technical Interview",
      scheduled_at: "2026-08-22T06:00:00.000Z",
      duration: 60,
      interviewer: "Jason Lin",
    },
  });
  assert.deepEqual(Object.keys(result.job), ["company", "role", "description", "location", "work_mode"]);
  assert.deepEqual(Object.keys(result.interview), ["round_name", "scheduled_at", "duration", "interviewer"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.job), true);
  assert.equal(Object.isFrozen(result.interview), true);
  assertNoPrivateTokens(result);
});

test("builders never mutate even deeply frozen inputs", () => {
  const job = Object.freeze(sensitiveJob());
  const interview = Object.freeze(sensitiveInterview());
  const jobBefore = structuredClone(job);
  const interviewBefore = structuredClone(interview);

  payloads.buildCareerRequirementsPayload(job);
  payloads.buildCareerInterviewPrepPayload(job, interview);

  assert.deepEqual(job, jobBefore);
  assert.deepEqual(interview, interviewBefore);
});

test("missing or badly typed required facts fail with a stable validation error", () => {
  assert.throws(
    () => payloads.buildCareerRequirementsPayload(null),
    (error) => {
      assert.equal(error instanceof payloads.CareerAiPayloadValidationError, true);
      assert.equal(error instanceof TypeError, true);
      assert.equal(error.code, "CAREER_AI_PAYLOAD_REQUIRED_FIELDS");
      assert.deepEqual(error.missingFields, ["job.company", "job.role", "job.description"]);
      assert.equal(Object.isFrozen(error.missingFields), true);
      return true;
    },
  );
  assert.throws(
    () => payloads.buildCareerInterviewPrepPayload(
      { company: 42, role: false },
      { round_name: { text: "do not coerce" } },
    ),
    (error) => {
      assert.equal(error.code, "CAREER_AI_PAYLOAD_REQUIRED_FIELDS");
      assert.deepEqual(error.missingFields, ["job.company", "job.role", "interview.round_name"]);
      return true;
    },
  );
});

test("bad optional types stay empty instead of being coerced or guessed", () => {
  const result = payloads.buildCareerInterviewPrepPayload(
    {
      company: "Arc",
      role: "Engineer",
      description: { text: "do not coerce" },
      location: ["remote"],
      work_mode: Symbol("hybrid"),
    },
    {
      round_name: "Technical interview",
      scheduled_at: "22 August 2026 at 2pm",
      duration: "60",
      interviewer: null,
    },
  );

  assert.deepEqual(result, {
    job: { company: "Arc", role: "Engineer", description: "", location: "", work_mode: "" },
    interview: { round_name: "Technical interview", scheduled_at: null, duration: null, interviewer: "" },
  });
});

test("text and numeric limits are deterministic and Unicode-safe", () => {
  const longDescription = `  ${"🧭".repeat(payloads.CAREER_AI_PAYLOAD_LIMITS.description + 20)}  `;
  const result = payloads.buildCareerInterviewPrepPayload(
    sensitiveJob({
      company: "A".repeat(payloads.CAREER_AI_PAYLOAD_LIMITS.company + 10),
      description: longDescription,
    }),
    sensitiveInterview({ duration: payloads.CAREER_AI_PAYLOAD_LIMITS.durationMinutes + 1 }),
  );

  assert.equal(Array.from(result.job.company).length, payloads.CAREER_AI_PAYLOAD_LIMITS.company);
  assert.equal(Array.from(result.job.description).length, payloads.CAREER_AI_PAYLOAD_LIMITS.description);
  assert.equal(result.job.description.endsWith("🧭"), true);
  assert.equal(result.interview.duration, null);
  assert.equal(
    payloads.buildCareerInterviewPrepPayload(
      { company: "Arc", role: "Engineer" },
      { round_name: "Screen", duration: 30.5 },
    ).interview.duration,
    null,
  );
});

test("only canonical UTC instants cross the AI boundary", () => {
  const minimumJob = { company: "Arc", role: "Engineer" };
  assert.equal(
    payloads.buildCareerInterviewPrepPayload(
      minimumJob,
      { round_name: "Screen", scheduled_at: "2026-08-22T06:00:00.000Z" },
    ).interview.scheduled_at,
    "2026-08-22T06:00:00.000Z",
  );
  for (const value of [
    "2026-08-22T06:00:00Z",
    "2026-08-22T14:00:00.000+08:00",
    "2026-02-30T06:00:00.000Z",
    1_787_375_600_000,
  ]) {
    assert.equal(
      payloads.buildCareerInterviewPrepPayload(
        minimumJob,
        { round_name: "Screen", scheduled_at: value },
      ).interview.scheduled_at,
      null,
    );
  }
});

test("UI disclosure lists are exact, readable, and immutable", () => {
  assert.deepEqual(payloads.CAREER_REQUIREMENTS_SHARED_FIELDS, ["公司", "职位", "职位描述"]);
  assert.deepEqual(payloads.CAREER_INTERVIEW_PREP_SHARED_FIELDS, [
    "公司", "职位", "职位描述", "地点", "工作方式", "面试轮次", "计划时间", "预计时长", "面试官",
  ]);
  assert.equal(Object.isFrozen(payloads.CAREER_REQUIREMENTS_SHARED_FIELDS), true);
  assert.equal(Object.isFrozen(payloads.CAREER_INTERVIEW_PREP_SHARED_FIELDS), true);
  assert.throws(() => payloads.CAREER_REQUIREMENTS_SHARED_FIELDS.push("私人备注"), TypeError);
});

test("server sanitizer rebuilds both protected actions from untrusted nested payloads", () => {
  for (const action of ["fit_analysis", "fitAnalysis", " fit-analysis "]) {
    const result = payloads.sanitizeCareerAiRequestPayload(action, {
      job: sensitiveJob(),
      payload_note: "PRIVATE_NOTE",
      interview: sensitiveInterview(),
    });
    assert.deepEqual(Object.keys(result), ["job"]);
    assert.deepEqual(Object.keys(result.job), ["company", "role", "description"]);
    assertNoPrivateTokens(result);
  }

  for (const action of ["interview_prep", "interviewPrep"]) {
    const result = payloads.sanitizeCareerAiRequestPayload(action, {
      job: sensitiveJob(),
      interview: sensitiveInterview(),
      top_level_secret: "PRIVATE_NOTE",
    });
    assert.deepEqual(Object.keys(result), ["job", "interview"]);
    assert.deepEqual(Object.keys(result.job), ["company", "role", "description", "location", "work_mode"]);
    assert.deepEqual(Object.keys(result.interview), ["round_name", "scheduled_at", "duration", "interviewer"]);
    assertNoPrivateTokens(result);
  }
});

test("server sanitizer rejects incomplete protected actions but preserves other action contracts", () => {
  assert.throws(
    () => payloads.sanitizeCareerAiRequestPayload("fitAnalysis", {
      job: { company: "Arc", role: "Engineer", description: "  " },
    }),
    (error) => error.code === "CAREER_AI_PAYLOAD_REQUIRED_FIELDS" &&
      error.missingFields.join(",") === "job.description",
  );
  assert.throws(
    () => payloads.sanitizeCareerAiRequestPayload("interview_prep", {
      job: { company: "Arc", role: "" },
      interview: {},
    }),
    (error) => error.code === "CAREER_AI_PAYLOAD_REQUIRED_FIELDS" &&
      error.missingFields.join(",") === "job.role,interview.round_name",
  );

  const existingContract = Object.freeze({
    raw_notes: "PRIVATE_RAW_NOTES",
    questions_json: "PRIVATE_QUESTIONS",
  });
  assert.strictEqual(
    payloads.sanitizeCareerAiRequestPayload("structure_interview", existingContract),
    existingContract,
  );
});

async function loadCareerAiRoute() {
  const deepSeekUrl = dataModule(`
    export async function runDeepSeekJson(prompt) {
      globalThis.__careerAiDeepSeekCalls.push(prompt);
      return { data: { accepted: true }, model: "stub", promptVersion: prompt.promptVersion, usage: null };
    }
  `, "tests/stubs/deepseek.mjs");
  const promptsUrl = dataModule(`
    export function careerPrompt(action, payload) {
      globalThis.__careerAiPromptCalls.push({ action, payload });
      return { system: "test", user: "test", promptVersion: "career-test" };
    }
  `, "tests/stubs/prompts.mjs");
  const httpUrl = dataModule(
    await transpileStandaloneTypeScript("lib/server/http.ts"),
    "lib/server/http.ts",
  );
  const routeOutput = (await transpileStandaloneTypeScript("app/api/ai/career/route.ts"))
    .replaceAll('"@/lib/career/ai-payload"', JSON.stringify(payloadModuleUrl))
    .replaceAll('"@/lib/server/deepseek"', JSON.stringify(deepSeekUrl))
    .replaceAll('"@/lib/server/prompts"', JSON.stringify(promptsUrl))
    .replaceAll('"@/lib/server/http"', JSON.stringify(httpUrl));
  return import(dataModule(routeOutput, "app/api/ai/career/route.ts"));
}

test("Career AI route sanitizes before prompting and maps missing facts to a safe 400", async () => {
  const route = await loadCareerAiRoute();
  globalThis.__careerAiPromptCalls = [];
  globalThis.__careerAiDeepSeekCalls = [];

  const accepted = await route.POST(new Request("http://localhost/api/ai/career", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "fitAnalysis",
      payload: { job: sensitiveJob(), top_level_secret: "PRIVATE_NOTE" },
    }),
  }));
  assert.equal(accepted.status, 200);
  assert.equal(globalThis.__careerAiPromptCalls.length, 1);
  assertNoPrivateTokens(globalThis.__careerAiPromptCalls[0].payload);

  globalThis.__careerAiPromptCalls = [];
  globalThis.__careerAiDeepSeekCalls = [];
  const rejected = await route.POST(new Request("http://localhost/api/ai/career", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "fit_analysis",
      payload: { job: { company: "Arc", role: "Engineer" } },
    }),
  }));
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), {
    ok: false,
    error: "AI 所需的职位信息不完整，请补全后再试。",
    code: "CAREER_AI_INPUT_INCOMPLETE",
  });
  assert.equal(globalThis.__careerAiPromptCalls.length, 0);
  assert.equal(globalThis.__careerAiDeepSeekCalls.length, 0);
});

test("Career AI route source contract requires the sanitizer before careerPrompt", async () => {
  const source = await readFile(new URL("app/api/ai/career/route.ts", projectRoot), "utf8");
  const sanitizeAt = source.indexOf("sanitizeCareerAiRequestPayload(body.action, body.payload ?? {})");
  const promptAt = source.indexOf("careerPrompt(body.action, safePayload)");
  assert.notEqual(sanitizeAt, -1);
  assert.notEqual(promptAt, -1);
  assert.equal(sanitizeAt < promptAt, true);
  assert.doesNotMatch(source, /careerPrompt\(body\.action,\s*body\.payload/);
  assert.match(source, /error instanceof CareerAiPayloadValidationError/);
  assert.match(source, /new HttpError\(\s*400,/);
});
