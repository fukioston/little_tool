import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

async function loadContract() {
  const relativePath = "lib/fitness/ai-contract.ts";
  const source = await readFile(new URL(relativePath, projectRoot), "utf8");
  const { outputText, diagnostics = [] } = ts.transpileModule(source, {
    fileName: relativePath,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
  });
  assert.deepEqual(diagnostics.filter((entry) => entry.category === ts.DiagnosticCategory.Error), []);
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

function venue() {
  return {
    venue_id: "venue-main",
    name: "公司健身房",
    equipment: [
      {
        equipment_id: "eq-cable",
        name: "双滑轮",
        category: "cable",
        quantity: 1,
        status: "available",
        details: ["有绳索附件"],
        available_loads: [{ load_grams: 5_000, quantity: 1, label: "第一档", available: true }],
      },
      {
        equipment_id: "eq-bench",
        name: "可调长凳",
        category: "bench",
        quantity: 1,
        status: "available",
        details: [],
        available_loads: [],
      },
      {
        equipment_id: "eq-maintenance",
        name: "维修中的跑步机",
        category: "treadmill",
        quantity: 1,
        status: "maintenance",
        details: [],
        available_loads: [],
      },
    ],
  };
}

function allowedExercises() {
  return [
    {
      exercise_id: "cable-row",
      name: "坐姿绳索划船",
      movement_pattern: "horizontal_pull",
      required_equipment_ids: ["eq-cable"],
      is_bodyweight: false,
    },
    {
      exercise_id: "bench-supported-row",
      name: "长凳支撑划船",
      movement_pattern: "horizontal_pull",
      required_equipment_ids: ["eq-bench"],
      is_bodyweight: false,
    },
    {
      exercise_id: "push-up",
      name: "俯卧撑",
      movement_pattern: "horizontal_push",
      required_equipment_ids: [],
      is_bodyweight: true,
    },
    {
      exercise_id: "cable-bench-row",
      name: "长凳绳索划船",
      movement_pattern: "horizontal_pull",
      required_equipment_ids: ["eq-cable", "eq-bench"],
      is_bodyweight: false,
    },
  ];
}

function planInput() {
  return {
    venue: venue(),
    allowed_exercises: allowedExercises(),
    goals: ["一般力量"],
    experience: "刚开始规律训练",
    weekly_schedule: {
      strength_sessions: 1,
      cardio_sessions: 0,
      session_minutes: 45,
      available_days: ["周二", "周六"],
    },
    constraints: [],
    preferences: ["不排队"],
    known_capabilities: [],
  };
}

function exercise(overrides = {}) {
  return {
    exercise_id: "cable-row",
    exercise_name: "绳索划船",
    movement_pattern: "水平拉",
    equipment_id: "eq-cable",
    is_bodyweight: false,
    sets: 3,
    rep_range: { min: 8, max: 12 },
    duration_seconds: null,
    load_rule: { mode: "rir_guided", target_rir: 3, instruction: "从能稳定保留三次余力的档位开始，由用户现场确认。" },
    rest_seconds: 90,
    reason: "在当前场地可执行。",
    execution_check: "开始前确认滑轮和绳索附件可用。",
    alternatives: [],
    ...overrides,
  };
}

function safety() {
  return {
    medical_diagnosis_provided: false,
    stop_if_pain_or_unusual_symptoms: true,
    note: "出现疼痛或异常症状时停止，并在需要时咨询专业人士。",
  };
}

function planResult(item = exercise()) {
  return {
    schema_version: "1.0",
    draft_only: true,
    title: "两次力量训练草稿",
    rationale: "按当前时间与器材形成，保存前仍需确认。",
    days: [{
      day_key: "周二",
      label: "全身 A",
      session_type: "strength",
      estimated_minutes: 45,
      items: [item],
    }],
    assumptions: [],
    questions: [],
    warnings: [],
    safety: safety(),
  };
}

function adaptInput() {
  return {
    venue: venue(),
    allowed_exercises: allowedExercises(),
    current_session: {
      session_id: "session-1",
      remaining_items: [{
        item_id: "item-row",
        exercise_name: "绳索划船",
        equipment_id: "eq-cable",
        is_bodyweight: false,
        sets_remaining: 3,
      }],
    },
    trigger: {
      kind: "equipment_unavailable",
      details: "双滑轮正在排队",
      unavailable_equipment_ids: ["eq-cable"],
      available_minutes: 30,
    },
    constraints: [],
  };
}

test("fitness action and input contracts reject unsupported or ambiguous references", async () => {
  const contract = await loadContract();
  assert.equal(contract.isFitnessAiAction("plan_draft"), true);
  assert.equal(contract.isFitnessAiAction("diagnose_injury"), false);
  assert.equal(contract.parseEquipmentDraftInput({ description: "  两副 10kg 哑铃  " }).description, "两副 10kg 哑铃");

  const duplicate = planInput();
  duplicate.venue.equipment.push({ ...duplicate.venue.equipment[0] });
  assert.throws(() => contract.parsePlanDraftInput(duplicate), /重复/);

  const unknownCapability = planInput();
  unknownCapability.known_capabilities = [{ equipment_id: "eq-made-up", exercise_id: "cable-row", load_grams: 20_000, reps: 10, rir: 2, note: "已确认" }];
  assert.throws(() => contract.parsePlanDraftInput(unknownCapability), /未知器材/);

  const unknownExerciseEquipment = planInput();
  unknownExerciseEquipment.allowed_exercises[0].required_equipment_ids = ["eq-made-up"];
  assert.throws(() => contract.parsePlanDraftInput(unknownExerciseEquipment), /未知器材/);

  const tooManyExercises = planInput();
  tooManyExercises.allowed_exercises = Array.from({ length: 161 }, (_, index) => ({
    exercise_id: `bodyweight-${index}`,
    name: `自重动作 ${index}`,
    movement_pattern: "core",
    required_equipment_ids: [],
    is_bodyweight: true,
  }));
  assert.throws(() => contract.parsePlanDraftInput(tooManyExercises), /数量过多/);
});

test("equipment draft keeps bounded evidence-backed checklist fields", async () => {
  const { parseEquipmentDraft } = await loadContract();
  const item = {
    name: "固定哑铃",
    category: "dumbbell",
    quantity: 2,
    location: "自由重量区",
    observed_capabilities: ["固定重量"],
    attachments: [],
    load: { unit: "kg", values: [5, 10], min: 5, max: 10, increment: 5, evidence: "5kg 和 10kg 各一对" },
    source_evidence: "自由重量区有 5kg 和 10kg 哑铃各一对",
    needs_confirmation: ["是否还有其他重量"],
    secret: "discarded",
  };
  const parsed = parseEquipmentDraft({
    schema_version: "1.0",
    draft_only: true,
    summary: "从描述中识别到一组固定哑铃，仍需现场核对。",
    items: Array.from({ length: 180 }, () => item),
    questions: [],
    warnings: Array.from({ length: 30 }, (_, index) => `w${index}`),
    unknown: "discarded",
  });
  assert.equal(parsed.items.length, 160);
  assert.equal(parsed.warnings.length, 16);
  assert.equal("secret" in parsed.items[0], false);
  assert.equal("unknown" in parsed, false);
});

test("equipment draft rejects empty, malformed, or unsupported measured claims", async () => {
  const { parseEquipmentDraft } = await loadContract();
  assert.throws(() => parseEquipmentDraft({}), /版本/);
  assert.throws(() => parseEquipmentDraft({ schema_version: "1.0", draft_only: true, summary: "没有识别到内容", items: [], questions: [] }), /没有返回/);
  assert.throws(() => parseEquipmentDraft({
    schema_version: "1.0",
    draft_only: true,
    summary: "待核对",
    items: [{
      name: "器械",
      category: "machine",
      quantity: null,
      location: null,
      observed_capabilities: [],
      attachments: [],
      load: { unit: "kg", values: [20], min: null, max: null, increment: null, evidence: "" },
      source_evidence: "有一台器械",
      needs_confirmation: ["重量"],
    }],
    questions: [],
  }), /证据|为空/);
});

test("plan draft accepts only available input equipment IDs and strips unknown fields", async () => {
  const contract = await loadContract();
  const input = contract.parsePlanDraftInput(planInput());
  const result = planResult(exercise({ load_rule: { mode: "rir_guided", target_rir: 3, instruction: "现场确认余力。", guessed_kg: 40 } }));
  const parsed = contract.parsePlanDraft({ ...result, private_note: "discarded" }, input);
  assert.equal(parsed.days[0].items[0].equipment_id, "eq-cable");
  assert.equal(parsed.days[0].items[0].exercise_id, "cable-row");
  assert.equal(parsed.days[0].items[0].exercise_name, "坐姿绳索划船");
  assert.equal(parsed.days[0].items[0].movement_pattern, "horizontal_pull");
  assert.equal("guessed_kg" in parsed.days[0].items[0].load_rule, false);
  assert.equal("private_note" in parsed, false);

  assert.throws(() => contract.parsePlanDraft(planResult(exercise({ equipment_id: "eq-made-up" })), input), /未知或不可用/);
  assert.throws(() => contract.parsePlanDraft(planResult(exercise({ equipment_id: "eq-maintenance" })), input), /未知或不可用/);
  assert.throws(() => contract.parsePlanDraft(planResult(exercise({ exercise_id: "invented-row" })), input), /未知动作/);
  assert.throws(() => contract.parsePlanDraft(planResult(exercise({ equipment_id: "eq-bench" })), input), /不属于该动作/);
  assert.throws(() => contract.parsePlanDraft(planResult(exercise({ is_bodyweight: true })), input), /自重/);
  assert.throws(() => contract.parsePlanDraft(planResult(exercise({ load_rule: { mode: "rir_guided", target_rir: 3, instruction: "先试 40kg。" } })), input), /具体重量/);
  assert.throws(() => contract.parsePlanDraft(planResult(exercise({ alternatives: [{
    exercise_id: "invented-alternative",
    exercise_name: "虚构替代",
    movement_pattern: "horizontal_pull",
    equipment_id: "eq-bench",
    is_bodyweight: false,
    reason: "待确认",
  }] })), input), /未知动作/);
  assert.throws(() => contract.parsePlanDraft(planResult(exercise({ alternatives: [{
    exercise_id: "bench-supported-row",
    exercise_name: "长凳支撑划船",
    movement_pattern: "horizontal_pull",
    equipment_id: "eq-cable",
    is_bodyweight: false,
    reason: "待确认",
  }] })), input), /不属于该动作/);

  const higherFrequency = planInput();
  higherFrequency.weekly_schedule.strength_sessions = 2;
  assert.throws(() => contract.parsePlanDraft(planResult(), contract.parsePlanDraftInput(higherFrequency)), /频次/);
});

test("plan draft allows explicit bodyweight binding without inventing equipment", async () => {
  const contract = await loadContract();
  const input = contract.parsePlanDraftInput(planInput());
  const bodyweight = exercise({
    exercise_id: "push-up",
    exercise_name: "俯卧撑",
    movement_pattern: "水平推",
    equipment_id: null,
    is_bodyweight: true,
    load_rule: { mode: "bodyweight", target_rir: 3, instruction: "按动作质量与余力停止。" },
  });
  const parsed = contract.parsePlanDraft(planResult(bodyweight), input);
  assert.equal(parsed.days[0].items[0].equipment_id, null);
  assert.equal(parsed.days[0].items[0].load_rule.mode, "bodyweight");
});

test("session adaptation rejects unknown item and blocked equipment IDs", async () => {
  const contract = await loadContract();
  const input = contract.parseAdaptSessionInput(adaptInput());
  const replacement = exercise({
    exercise_id: "bench-supported-row",
    exercise_name: "长凳支撑自重划船替代",
    movement_pattern: "水平拉",
    equipment_id: "eq-bench",
  });
  const result = {
    schema_version: "1.0",
    draft_only: true,
    summary: "先换到当前可用长凳相关动作，保存前确认现场条件。",
    estimated_minutes: 25,
    changes: [{
      operation: "replace",
      source_item_id: "item-row",
      explanation: "原器材正在排队。",
      numeric_value: null,
      replacement,
    }],
    checks: ["确认长凳可用"],
    questions: [],
    warnings: [],
    safety: safety(),
  };
  const parsed = contract.parseSessionAdaptation(result, input);
  assert.equal(parsed.changes[0].replacement.equipment_id, "eq-bench");

  const unknownItem = structuredClone(result);
  unknownItem.changes[0].source_item_id = "item-made-up";
  assert.throws(() => contract.parseSessionAdaptation(unknownItem, input), /未知训练条目/);

  const unknownExercise = structuredClone(result);
  unknownExercise.changes[0].replacement.exercise_id = "invented-row";
  assert.throws(() => contract.parseSessionAdaptation(unknownExercise, input), /未知动作/);

  const blocked = structuredClone(result);
  blocked.changes[0].replacement.equipment_id = "eq-cable";
  assert.throws(() => contract.parseSessionAdaptation(blocked, input), /未知或不可用/);

  const blockedSecondaryRequirement = structuredClone(result);
  blockedSecondaryRequirement.changes[0].replacement.exercise_id = "cable-bench-row";
  blockedSecondaryRequirement.changes[0].replacement.equipment_id = "eq-bench";
  assert.throws(() => contract.parseSessionAdaptation(blockedSecondaryRequirement, input), /必需器材/);
});

test("body-discomfort adaptation can conservatively end a session without a diagnosis", async () => {
  const contract = await loadContract();
  const value = adaptInput();
  value.trigger = {
    kind: "body_discomfort",
    details: "肩部出现不寻常疼痛",
    unavailable_equipment_ids: [],
    available_minutes: null,
  };
  const input = contract.parseAdaptSessionInput(value);
  const parsed = contract.parseSessionAdaptation({
    schema_version: "1.0",
    draft_only: true,
    summary: "结束本次训练并保留已经完成的记录。",
    estimated_minutes: 0,
    changes: [{
      operation: "end_session",
      source_item_id: null,
      explanation: "不继续尝试会触发不适的动作。",
      numeric_value: null,
      replacement: null,
    }],
    checks: ["若症状持续或加重，咨询专业人士"],
    questions: [],
    warnings: [],
    safety: safety(),
  }, input);
  assert.equal(parsed.safety.medical_diagnosis_provided, false);
  assert.equal(parsed.changes[0].operation, "end_session");

  const diagnosed = structuredClone(parsed);
  diagnosed.safety.medical_diagnosis_provided = true;
  assert.throws(() => contract.parseSessionAdaptation(diagnosed, input), /false/);
});
