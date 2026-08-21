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
    diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error),
    [],
  );
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const payloads = await loadStandaloneTypeScriptModule("lib/career/ai-payload.ts");
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
