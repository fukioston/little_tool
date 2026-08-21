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
  "PRIVATE_JOB_ID",
  "PRIVATE_INTERVIEW_ID",
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
  "PRIVATE_LIFECYCLE",
  "PRIVATE_EXTRA",
];

const STRUCTURE_LOCAL_ONLY_TOKENS = [
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
    lifecycle_metadata: "PRIVATE_LIFECYCLE",
    extra: "PRIVATE_EXTRA",
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
    lifecycle_metadata: "PRIVATE_LIFECYCLE",
    extra: "PRIVATE_EXTRA",
    ...overrides,
  };
}

function assertNoPrivateTokens(value) {
  assertNoTokens(value, PRIVATE_TOKENS);
}

function assertNoTokens(value, tokens) {
  const serialized = JSON.stringify(value);
  for (const token of tokens) {
    assert.equal(serialized.includes(token), false, `${token} must stay local`);
  }
}

function assertNoUnsafeControls(value) {
  if (typeof value === "string") {
    for (const character of value) {
      const codePoint = character.codePointAt(0);
      const unsafe = codePoint <= 8 ||
        (codePoint >= 11 && codePoint <= 12) ||
        (codePoint >= 14 && codePoint <= 31) ||
        (codePoint >= 127 && codePoint <= 159) ||
        codePoint === 0x061c ||
        (codePoint >= 0x200e && codePoint <= 0x200f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069) ||
        codePoint === 0xfeff;
      assert.equal(unsafe, false, `unsafe code point U+${codePoint.toString(16)} crossed the AI boundary`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoUnsafeControls(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) assertNoUnsafeControls(item);
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

test("interview-structure payload contains only current form content and minimal job identity", () => {
  const result = payloads.buildCareerStructureInterviewPayload(
    sensitiveJob(),
    sensitiveInterview({
      summary: "  Technical\nconversation  ",
      raw_notes: "Asked about systems.\r\n\r\n\r\nI explained queues.",
      questions: [
        {
          id: "PRIVATE_EXTRA",
          question: " Why this role?\n ",
          answer: "I value useful tools.\r\nThe team fits.",
          note: " Recruiter\tseemed positive ",
          interviewer_follow_up: "PRIVATE_EXTRA",
        },
      ],
      reflection: "  Explain tradeoffs earlier.\n\nKeep the example. ",
    }),
  );

  assert.deepEqual(result, {
    job: { company: "Arc Labs", role: "Product Engineer" },
    interview: {
      round_name: "Technical Interview",
      summary: "Technical conversation",
      raw_notes: "Asked about systems.\n\nI explained queues.",
      questions: [{
        question: "Why this role?",
        answer: "I value useful tools.\nThe team fits.",
        note: "Recruiter seemed positive",
      }],
      reflection: "Explain tradeoffs earlier.\n\nKeep the example.",
    },
  });
  assert.deepEqual(Object.keys(result), ["job", "interview"]);
  assert.deepEqual(Object.keys(result.job), ["company", "role"]);
  assert.deepEqual(Object.keys(result.interview), [
    "round_name", "summary", "raw_notes", "questions", "reflection",
  ]);
  assert.deepEqual(Object.keys(result.interview.questions[0]), ["question", "answer", "note"]);
  assertNoTokens(result, STRUCTURE_LOCAL_ONLY_TOKENS);
});

test("interview-structure output is deeply immutable and never mutates frozen form input", () => {
  const questions = Object.freeze([
    Object.freeze({ question: "A", answer: "B", note: "C", extra: "PRIVATE_EXTRA" }),
  ]);
  const job = Object.freeze(sensitiveJob());
  const interview = Object.freeze(sensitiveInterview({ questions }));
  const jobBefore = structuredClone(job);
  const interviewBefore = structuredClone(interview);
  const result = payloads.buildCareerStructureInterviewPayload(job, interview);

  assert.deepEqual(job, jobBefore);
  assert.deepEqual(interview, interviewBefore);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.job), true);
  assert.equal(Object.isFrozen(result.interview), true);
  assert.equal(Object.isFrozen(result.interview.questions), true);
  assert.equal(Object.isFrozen(result.interview.questions[0]), true);
  assert.throws(() => result.interview.questions.push({ question: "x", answer: "", note: "" }), TypeError);
  assert.throws(() => { result.interview.questions[0].answer = "changed"; }, TypeError);
});

test("interview-structure bounds arrays and text by Unicode code point and strips unsafe controls", () => {
  const questions = Array.from(
    { length: payloads.CAREER_AI_PAYLOAD_LIMITS.interviewQuestions + 5 },
    (_, index) => ({
      question: `${"🧭".repeat(payloads.CAREER_AI_PAYLOAD_LIMITS.interviewQuestion + 5)}\0\u202e${index}`,
      answer: `line one\u0085\r\nline two${"🌱".repeat(payloads.CAREER_AI_PAYLOAD_LIMITS.interviewAnswer)}`,
      note: "note\u2066 hidden",
      extra: "PRIVATE_EXTRA",
    }),
  );
  const result = payloads.buildCareerStructureInterviewPayload(
    sensitiveJob(),
    sensitiveInterview({
      summary: `\ud800${"🧠".repeat(payloads.CAREER_AI_PAYLOAD_LIMITS.interviewSummary + 3)}`,
      raw_notes: "alpha\u2028beta\u0001",
      questions,
      reflection: "left\ufeffright\u200f",
    }),
  );

  assert.equal(result.interview.questions.length, payloads.CAREER_AI_PAYLOAD_LIMITS.interviewQuestions);
  assert.equal(Array.from(result.interview.summary).length, payloads.CAREER_AI_PAYLOAD_LIMITS.interviewSummary);
  assert.equal(result.interview.summary.startsWith("�🧠"), true);
  assert.equal(Array.from(result.interview.questions[0].question).length, payloads.CAREER_AI_PAYLOAD_LIMITS.interviewQuestion);
  assert.equal(result.interview.questions[0].question.endsWith("🧭"), true);
  assert.equal(result.interview.raw_notes, "alpha\nbeta");
  assert.equal(result.interview.reflection, "leftright");
  assertNoUnsafeControls(result);
  assertNoTokens(result, STRUCTURE_LOCAL_ONLY_TOKENS);
});

test("interview-structure handles malformed optional form fields deterministically", () => {
  const result = payloads.buildCareerStructureInterviewPayload(
    { company: "Arc", role: "Engineer", note: "PRIVATE_NOTE" },
    {
      round_name: "Screen",
      summary: 42,
      raw_notes: { text: "PRIVATE_RAW_NOTES" },
      questions: "PRIVATE_QUESTIONS",
      reflection: ["PRIVATE_REFLECTION"],
      extra: "PRIVATE_EXTRA",
    },
  );
  assert.deepEqual(result, {
    job: { company: "Arc", role: "Engineer" },
    interview: { round_name: "Screen", summary: "", raw_notes: "", questions: [], reflection: "" },
  });
  assertNoPrivateTokens(result);
});

test("builders never mutate even deeply frozen inputs", () => {
  const job = Object.freeze(sensitiveJob());
  const interview = Object.freeze(sensitiveInterview());
  const jobBefore = structuredClone(job);
  const interviewBefore = structuredClone(interview);

  payloads.buildCareerRequirementsPayload(job);
  payloads.buildCareerInterviewPrepPayload(job, interview);
  payloads.buildCareerStructureInterviewPayload(job, Object.freeze({
    ...interview,
    questions: Object.freeze([]),
  }));

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
    () => payloads.buildCareerStructureInterviewPayload(
      { company: "", role: null },
      { round_name: false },
    ),
    (error) => {
      assert.equal(error.code, "CAREER_AI_PAYLOAD_REQUIRED_FIELDS");
      assert.deepEqual(error.missingFields, ["job.company", "job.role", "interview.round_name"]);
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
  assert.deepEqual(payloads.CAREER_STRUCTURE_INTERVIEW_SHARED_FIELDS, [
    "公司", "职位", "面试轮次", "一句话总结", "原始速记", "问题", "回答", "问题备注", "复盘与下一步",
  ]);
  assert.equal(Object.isFrozen(payloads.CAREER_REQUIREMENTS_SHARED_FIELDS), true);
  assert.equal(Object.isFrozen(payloads.CAREER_INTERVIEW_PREP_SHARED_FIELDS), true);
  assert.equal(Object.isFrozen(payloads.CAREER_STRUCTURE_INTERVIEW_SHARED_FIELDS), true);
  assert.throws(() => payloads.CAREER_REQUIREMENTS_SHARED_FIELDS.push("私人备注"), TypeError);
});

test("server sanitizer rebuilds every protected action from untrusted nested payloads", () => {
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

  for (const action of ["structure_interview", "structureInterview", " structure-interview "]) {
    const result = payloads.sanitizeCareerAiRequestPayload(action, {
      job: sensitiveJob(),
      interview: sensitiveInterview({
        summary: "Allowed summary",
        raw_notes: "Allowed notes",
        questions: [{ question: "Allowed question", answer: "Allowed answer", note: "Allowed note", extra: "PRIVATE_EXTRA" }],
        reflection: "Allowed reflection",
      }),
      top_level_secret: "PRIVATE_EXTRA",
    });
    assert.deepEqual(Object.keys(result.job), ["company", "role"]);
    assert.deepEqual(Object.keys(result.interview), ["round_name", "summary", "raw_notes", "questions", "reflection"]);
    assertNoTokens(result, STRUCTURE_LOCAL_ONLY_TOKENS);
  }
});

test("server sanitizer rejects incomplete protected actions and every action without a strict contract", () => {
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

  for (const action of [
    "parse_job",
    "tailor_material",
    "improveAnswer",
    "follow-up-email",
    "weekly_review",
    "__proto__",
    "unknown",
  ]) {
    assert.throws(
      () => payloads.sanitizeCareerAiRequestPayload(action, {
        raw_notes: "PRIVATE_RAW_NOTES",
        extra: "PRIVATE_EXTRA",
      }),
      (error) => error instanceof payloads.CareerAiActionNotAllowedError &&
        error.code === "CAREER_AI_ACTION_NOT_ALLOWED" &&
        !error.message.includes(action),
    );
  }
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

test("Career AI route sanitizes every allowed action before prompting and maps missing facts to a safe 400", async () => {
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
  const structured = await route.POST(new Request("http://localhost/api/ai/career", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: " structure-interview ",
      payload: {
        job: sensitiveJob(),
        interview: sensitiveInterview({
          summary: "Allowed summary",
          raw_notes: "Allowed notes",
          questions: [{
            question: "Allowed question",
            answer: "Allowed answer",
            note: "Allowed note",
            extra: "PRIVATE_EXTRA",
          }],
          reflection: "Allowed reflection",
        }),
        extra: "PRIVATE_EXTRA",
      },
    }),
  }));
  assert.equal(structured.status, 200);
  assert.equal(globalThis.__careerAiPromptCalls.length, 1);
  assert.equal(globalThis.__careerAiDeepSeekCalls.length, 1);
  assert.equal(globalThis.__careerAiPromptCalls[0].action, " structure-interview ");
  assertNoTokens(globalThis.__careerAiPromptCalls[0].payload, STRUCTURE_LOCAL_ONLY_TOKENS);

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
    error: "AI 所需的信息不完整，请补全后再试。",
    code: "CAREER_AI_INPUT_INCOMPLETE",
  });
  assert.equal(globalThis.__careerAiPromptCalls.length, 0);
  assert.equal(globalThis.__careerAiDeepSeekCalls.length, 0);
});

test("Career AI route returns a safe 400 for unopened actions without prompting or calling DeepSeek", async () => {
  const route = await loadCareerAiRoute();
  globalThis.__careerAiPromptCalls = [];
  globalThis.__careerAiDeepSeekCalls = [];

  for (const action of [
    "parse_job",
    "tailor_material",
    "improve_answer",
    "follow_up_email",
    "weekly_review",
    "__proto__",
    "unknown",
  ]) {
    const response = await route.POST(new Request("http://localhost/api/ai/career", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        payload: { raw_notes: "PRIVATE_RAW_NOTES", extra: "PRIVATE_EXTRA" },
      }),
    }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "这个 AI 功能尚未开放。",
      code: "CAREER_AI_ACTION_NOT_ALLOWED",
    });
  }

  assert.equal(globalThis.__careerAiPromptCalls.length, 0);
  assert.equal(globalThis.__careerAiDeepSeekCalls.length, 0);
});

test("real Career prompt receives only the sanitized interview-structure contract", async () => {
  const promptsUrl = dataModule(
    await transpileStandaloneTypeScript("lib/server/prompts.ts"),
    "lib/server/prompts.ts",
  );
  const prompts = await import(promptsUrl);
  const safePayload = payloads.sanitizeCareerAiRequestPayload("structure_interview", {
    job: sensitiveJob(),
    interview: sensitiveInterview({
      summary: "Allowed summary",
      raw_notes: "Allowed raw notes",
      questions: [{
        question: "Allowed question",
        answer: "Allowed answer",
        note: "Allowed note",
        extra: "PRIVATE_EXTRA",
      }],
      reflection: "Allowed reflection",
    }),
    extra: "PRIVATE_EXTRA",
  });
  const prompt = prompts.careerPrompt("structure_interview", safePayload);

  assertNoTokens(prompt, STRUCTURE_LOCAL_ONLY_TOKENS);
  assert.match(prompt.user, /Allowed raw notes/);
  assert.match(prompt.user, /Allowed question/);
  assert.doesNotMatch(prompt.user, /PRIVATE_EXTRA|PRIVATE_NOTE|PRIVATE_MEETING_URL|PRIVATE_STATUS/);
});

test("real Career prompt keeps the complete bounded interview form instead of slicing its tail", async () => {
  const promptsUrl = dataModule(
    await transpileStandaloneTypeScript("lib/server/prompts.ts"),
    "lib/server/prompts.ts",
  );
  const prompts = await import(promptsUrl);
  const questionCount = payloads.CAREER_AI_PAYLOAD_LIMITS.interviewQuestions;
  const safePayload = payloads.buildCareerStructureInterviewPayload(
    { company: "Arc", role: "Engineer" },
    {
      round_name: "Technical",
      summary: "S".repeat(payloads.CAREER_AI_PAYLOAD_LIMITS.interviewSummary),
      raw_notes: "R".repeat(payloads.CAREER_AI_PAYLOAD_LIMITS.interviewRawNotes),
      questions: Array.from({ length: questionCount }, (_, index) => ({
        question: `Q${index}`.padEnd(payloads.CAREER_AI_PAYLOAD_LIMITS.interviewQuestion, "Q"),
        answer: `A${index}`.padEnd(payloads.CAREER_AI_PAYLOAD_LIMITS.interviewAnswer, "A"),
        note: `N${index}`.padEnd(payloads.CAREER_AI_PAYLOAD_LIMITS.interviewQuestionNote, "N"),
      })),
      reflection: `${"F".repeat(payloads.CAREER_AI_PAYLOAD_LIMITS.interviewReflection - "ALLOWED_REFLECTION_END".length)}ALLOWED_REFLECTION_END`,
    },
  );
  const prompt = prompts.careerPrompt("structure_interview", safePayload);

  assert.match(prompt.user, /ALLOWED_REFLECTION_END/);
  assert.equal(prompt.user.includes(`Q${questionCount - 1}`), true);
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
  assert.match(source, /error instanceof CareerAiActionNotAllowedError/);
  assert.match(source, /new HttpError\(\s*400,/);
});
