export const FITNESS_AI_ACTIONS = ["equipment_draft", "plan_draft", "adapt_session"] as const;

export type FitnessAiAction = (typeof FITNESS_AI_ACTIONS)[number];

export type FitnessEquipmentCategory =
  | "barbell"
  | "plates"
  | "rack"
  | "bench"
  | "dumbbell"
  | "kettlebell"
  | "cable"
  | "fixed_machine"
  | "smith_machine"
  | "pullup_bar"
  | "dip_station"
  | "bands"
  | "mat"
  | "treadmill"
  | "bike"
  | "rower"
  | "elliptical"
  | "stair_climber"
  | "open_space"
  | "other";

export type FitnessEquipmentSnapshot = {
  equipment_id: string;
  name: string;
  category: FitnessEquipmentCategory;
  quantity: number;
  status: "available" | "limited" | "maintenance" | "removed";
  details: string[];
  available_loads: Array<{ load_grams: number; quantity: number; label: string | null; available: boolean }>;
};

export type FitnessVenueSnapshot = {
  venue_id: string;
  name: string;
  equipment: FitnessEquipmentSnapshot[];
};

export type FitnessAllowedExercise = {
  exercise_id: string;
  name: string;
  movement_pattern: string;
  required_equipment_ids: string[];
  is_bodyweight: boolean;
};

export type EquipmentDraftInput = {
  venue_name: string | null;
  description: string;
};

export type PlanDraftInput = {
  venue: FitnessVenueSnapshot;
  allowed_exercises: FitnessAllowedExercise[];
  goals: string[];
  experience: string | null;
  weekly_schedule: {
    strength_sessions: number;
    cardio_sessions: number;
    session_minutes: number;
    available_days: string[];
  };
  constraints: string[];
  preferences: string[];
  known_capabilities: Array<{
    equipment_id: string | null;
    exercise_id: string;
    load_grams: number | null;
    reps: number | null;
    rir: number | null;
    note: string;
  }>;
};

export type CurrentSessionItem = {
  item_id: string;
  exercise_name: string;
  equipment_id: string | null;
  is_bodyweight: boolean;
  sets_remaining: number;
};

export type AdaptSessionInput = {
  venue: FitnessVenueSnapshot;
  allowed_exercises: FitnessAllowedExercise[];
  current_session: {
    session_id: string | null;
    remaining_items: CurrentSessionItem[];
  };
  trigger: {
    kind: "equipment_unavailable" | "time_shortened" | "body_discomfort" | "other";
    details: string;
    unavailable_equipment_ids: string[];
    available_minutes: number | null;
  };
  constraints: string[];
};

export type EquipmentDraft = {
  schema_version: "1.0";
  draft_only: true;
  summary: string;
  items: Array<{
    name: string;
    category: FitnessEquipmentCategory;
    quantity: number | null;
    location: string | null;
    observed_capabilities: string[];
    attachments: string[];
    load: {
      unit: "kg" | "lb" | "level" | "other" | null;
      values: number[];
      min: number | null;
      max: number | null;
      increment: number | null;
      evidence: string;
    } | null;
    source_evidence: string;
    needs_confirmation: string[];
  }>;
  questions: string[];
  warnings: string[];
};

export type FitnessLoadRule = {
  mode: "rir_guided" | "user_confirmed" | "bodyweight";
  target_rir: number | null;
  instruction: string;
};

export type FitnessDraftAlternative = {
  exercise_id: string;
  exercise_name: string;
  movement_pattern: string;
  equipment_id: string | null;
  is_bodyweight: boolean;
  reason: string;
};

export type FitnessDraftExercise = {
  exercise_id: string;
  exercise_name: string;
  movement_pattern: string;
  equipment_id: string | null;
  is_bodyweight: boolean;
  sets: number;
  rep_range: { min: number; max: number } | null;
  duration_seconds: number | null;
  load_rule: FitnessLoadRule;
  rest_seconds: number;
  reason: string;
  execution_check: string;
  alternatives: FitnessDraftAlternative[];
};

export type FitnessSafetyNotice = {
  medical_diagnosis_provided: false;
  stop_if_pain_or_unusual_symptoms: true;
  note: string;
};

export type PlanDraft = {
  schema_version: "1.0";
  draft_only: true;
  title: string;
  rationale: string;
  days: Array<{
    day_key: string;
    label: string;
    session_type: "strength" | "cardio" | "mixed" | "recovery" | "rest";
    estimated_minutes: number;
    items: FitnessDraftExercise[];
  }>;
  assumptions: string[];
  questions: string[];
  warnings: string[];
  safety: FitnessSafetyNotice;
};

export type SessionAdaptationDraft = {
  schema_version: "1.0";
  draft_only: true;
  summary: string;
  estimated_minutes: number | null;
  changes: Array<{
    operation: "replace" | "remove" | "reorder" | "reduce_sets" | "shorten_rest" | "end_session";
    source_item_id: string | null;
    explanation: string;
    numeric_value: number | null;
    replacement: FitnessDraftExercise | null;
  }>;
  checks: string[];
  questions: string[];
  warnings: string[];
  safety: FitnessSafetyNotice;
};

export type FitnessAiInput = EquipmentDraftInput | PlanDraftInput | AdaptSessionInput;
export type FitnessAiResult = EquipmentDraft | PlanDraft | SessionAdaptationDraft;

const MAX_TEXT = 2_000;
const MAX_SHORT = 240;
const MAX_LIST = 24;
const MAX_EQUIPMENT = 160;
const MAX_ALLOWED_EXERCISES = 160;
const MAX_DAYS = 14;
const MAX_EXERCISES = 24;
const EQUIPMENT_CATEGORIES = [
  "barbell",
  "plates",
  "rack",
  "bench",
  "dumbbell",
  "kettlebell",
  "cable",
  "fixed_machine",
  "smith_machine",
  "pullup_bar",
  "dip_station",
  "bands",
  "mat",
  "treadmill",
  "bike",
  "rower",
  "elliptical",
  "stair_climber",
  "open_space",
  "other",
] as const satisfies readonly FitnessEquipmentCategory[];

export class FitnessAiContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FitnessAiContractError";
  }
}

function fail(message: string): never {
  throw new FitnessAiContractError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(`AI 返回的${label}格式不正确。`);
  }
  return value as Record<string, unknown>;
}

function inputRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${label}格式不正确。`);
  }
  return value as Record<string, unknown>;
}

function outputText(value: unknown, label: string, limit = MAX_TEXT): string {
  if (typeof value !== "string") return fail(`AI 返回的${label}格式不正确。`);
  const normalized = value.trim();
  if (!normalized) return fail(`AI 返回的${label}为空。`);
  return normalized.slice(0, limit);
}

function outputNullableText(value: unknown, label: string, limit = MAX_TEXT): string | null {
  if (value === null || value === undefined) return null;
  return outputText(value, label, limit);
}

function inputText(value: unknown, label: string, limit = MAX_TEXT): string {
  if (typeof value !== "string") return fail(`${label}格式不正确。`);
  const normalized = value.trim();
  if (!normalized) return fail(`${label}不能为空。`);
  if (normalized.length > limit) return fail(`${label}过长。`);
  return normalized;
}

function inputNullableText(value: unknown, label: string, limit = MAX_TEXT): string | null {
  if (value === null || value === undefined || value === "") return null;
  return inputText(value, label, limit);
}

function inputList(value: unknown, label: string, max: number, required = false): unknown[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) return fail(`${label}格式不正确。`);
  if (value.length > max) return fail(`${label}数量过多。`);
  if (required && value.length === 0) return fail(`${label}不能为空。`);
  return value;
}

function inputTextList(value: unknown, label: string, max = MAX_LIST, required = false): string[] {
  return inputList(value, label, max, required).map((entry, index) => inputText(entry, `${label}[${index}]`, MAX_SHORT));
}

function outputTextList(value: unknown, label: string, max = MAX_LIST): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    return fail(`AI 返回的${label}格式不正确。`);
  }
  const bounded = value.slice(0, max);
  if (bounded.some((entry) => typeof entry !== "string")) {
    return fail(`AI 返回的${label}格式不正确。`);
  }
  return bounded
    .map((entry) => entry.trim().slice(0, MAX_SHORT))
    .filter(Boolean);
}

function finiteNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    return fail(`${label}超出允许范围。`);
  }
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  const parsed = finiteNumber(value, label, min, max);
  if (!Number.isInteger(parsed)) return fail(`${label}必须是整数。`);
  return parsed;
}

function nullableNumber(value: unknown, label: string, min: number, max: number): number | null {
  if (value === null || value === undefined) return null;
  return finiteNumber(value, label, min, max);
}

function nullableInteger(value: unknown, label: string, min: number, max: number): number | null {
  if (value === null || value === undefined) return null;
  return integer(value, label, min, max);
}

function oneOf<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) return fail(`${label}不在允许范围内。`);
  return value as T[number];
}

function literalTrue(value: unknown, label: string): true {
  if (value !== true) return fail(`${label}必须明确为 true。`);
  return true;
}

function literalFalse(value: unknown, label: string): false {
  if (value !== false) return fail(`${label}必须明确为 false。`);
  return false;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return fail(`${label}格式不正确。`);
  return value;
}

function parseEquipmentSnapshot(value: unknown, index: number): FitnessEquipmentSnapshot {
  const item = inputRecord(value, `equipment[${index}]`);
  const loads = inputList(item.available_loads, `equipment[${index}].available_loads`, 80).map((entry, loadIndex) => {
    const load = inputRecord(entry, `available_loads[${loadIndex}]`);
    return {
      load_grams: integer(load.load_grams, `available_loads[${loadIndex}].load_grams`, 0, 1_000_000_000),
      quantity: integer(load.quantity, `available_loads[${loadIndex}].quantity`, 0, 100),
      label: inputNullableText(load.label, `available_loads[${loadIndex}].label`, 120),
      available: boolean(load.available, `available_loads[${loadIndex}].available`),
    };
  });
  return {
    equipment_id: inputText(item.equipment_id, `equipment[${index}].equipment_id`, 120),
    name: inputText(item.name, `equipment[${index}].name`, 160),
    category: oneOf(item.category, EQUIPMENT_CATEGORIES, `equipment[${index}].category`),
    quantity: integer(item.quantity, `equipment[${index}].quantity`, 0, 100),
    status: oneOf(item.status, ["available", "limited", "maintenance", "removed"] as const, `equipment[${index}].status`),
    details: inputTextList(item.details, `equipment[${index}].details`, 20),
    available_loads: loads,
  };
}

function parseVenueInput(value: unknown): FitnessVenueSnapshot {
  const venue = inputRecord(value, "venue");
  const equipment = inputList(venue.equipment, "venue.equipment", MAX_EQUIPMENT).map(parseEquipmentSnapshot);
  const ids = new Set<string>();
  for (const item of equipment) {
    if (ids.has(item.equipment_id)) return fail(`器材 ID 重复：${item.equipment_id}`);
    ids.add(item.equipment_id);
  }
  return {
    venue_id: inputText(venue.venue_id, "venue.venue_id", 120),
    name: inputText(venue.name, "venue.name", 160),
    equipment,
  };
}

function parseAllowedExercises(
  value: unknown,
  venue: FitnessVenueSnapshot,
  required: boolean,
): FitnessAllowedExercise[] {
  const equipmentById = new Map(venue.equipment.map((item) => [item.equipment_id, item]));
  const exercises = inputList(value, "allowed_exercises", MAX_ALLOWED_EXERCISES, required).map((entry, index) => {
    const item = inputRecord(entry, `allowed_exercises[${index}]`);
    const requiredEquipmentIds = inputTextList(
      item.required_equipment_ids,
      `allowed_exercises[${index}].required_equipment_ids`,
      20,
    );
    if (new Set(requiredEquipmentIds).size !== requiredEquipmentIds.length) {
      return fail(`allowed_exercises[${index}] 包含重复器材 ID。`);
    }
    for (const equipmentId of requiredEquipmentIds) {
      const equipment = equipmentById.get(equipmentId);
      if (!equipment) return fail(`允许动作引用了未知器材 ID：${equipmentId}`);
      if (equipment.status !== "available" && equipment.status !== "limited") {
        return fail(`允许动作引用了不可用器材 ID：${equipmentId}`);
      }
    }
    const isBodyweight = boolean(item.is_bodyweight, `allowed_exercises[${index}].is_bodyweight`);
    if (!isBodyweight && requiredEquipmentIds.length === 0) {
      return fail(`allowed_exercises[${index}] 的非自重动作缺少器材 ID。`);
    }
    return {
      exercise_id: inputText(item.exercise_id, `allowed_exercises[${index}].exercise_id`, 120),
      name: inputText(item.name, `allowed_exercises[${index}].name`, 160),
      movement_pattern: inputText(item.movement_pattern, `allowed_exercises[${index}].movement_pattern`, 120),
      required_equipment_ids: requiredEquipmentIds,
      is_bodyweight: isBodyweight,
    };
  });
  const ids = new Set<string>();
  for (const exercise of exercises) {
    if (ids.has(exercise.exercise_id)) return fail(`动作 ID 重复：${exercise.exercise_id}`);
    ids.add(exercise.exercise_id);
  }
  return exercises;
}

export function isFitnessAiAction(value: unknown): value is FitnessAiAction {
  return typeof value === "string" && FITNESS_AI_ACTIONS.includes(value as FitnessAiAction);
}

export function parseEquipmentDraftInput(value: unknown): EquipmentDraftInput {
  const root = inputRecord(value, "器材草稿输入");
  return {
    venue_name: inputNullableText(root.venue_name, "venue_name", 160),
    description: inputText(root.description, "description", 12_000),
  };
}

export function parsePlanDraftInput(value: unknown): PlanDraftInput {
  const root = inputRecord(value, "计划草稿输入");
  const venue = parseVenueInput(root.venue);
  const allowedExercises = parseAllowedExercises(root.allowed_exercises, venue, true);
  const weekly = inputRecord(root.weekly_schedule, "weekly_schedule");
  const result: PlanDraftInput = {
    venue,
    allowed_exercises: allowedExercises,
    goals: inputTextList(root.goals, "goals", 12, true),
    experience: inputNullableText(root.experience, "experience", 600),
    weekly_schedule: {
      strength_sessions: integer(weekly.strength_sessions, "strength_sessions", 0, 14),
      cardio_sessions: integer(weekly.cardio_sessions, "cardio_sessions", 0, 14),
      session_minutes: integer(weekly.session_minutes, "session_minutes", 10, 300),
      available_days: inputTextList(weekly.available_days, "available_days", 14, true),
    },
    constraints: inputTextList(root.constraints, "constraints", 24),
    preferences: inputTextList(root.preferences, "preferences", 24),
    known_capabilities: inputList(root.known_capabilities, "known_capabilities", 80).map((entry, index) => {
      const capability = inputRecord(entry, `known_capabilities[${index}]`);
      return {
        equipment_id: inputNullableText(capability.equipment_id, `known_capabilities[${index}].equipment_id`, 120),
        exercise_id: inputText(capability.exercise_id, `known_capabilities[${index}].exercise_id`, 120),
        load_grams: nullableInteger(capability.load_grams, `known_capabilities[${index}].load_grams`, 0, 1_000_000_000),
        reps: nullableInteger(capability.reps, `known_capabilities[${index}].reps`, 0, 1_000),
        rir: nullableInteger(capability.rir, `known_capabilities[${index}].rir`, 0, 10),
        note: inputNullableText(capability.note, `known_capabilities[${index}].note`, 500) ?? "",
      };
    }),
  };
  if (result.weekly_schedule.strength_sessions + result.weekly_schedule.cardio_sessions === 0) {
    return fail("力量与有氧频次不能同时为 0。");
  }
  const uniqueDays = new Set(result.weekly_schedule.available_days);
  if (uniqueDays.size !== result.weekly_schedule.available_days.length) return fail("可训练日期不能重复。");
  if (Math.max(result.weekly_schedule.strength_sessions, result.weekly_schedule.cardio_sessions) > uniqueDays.size) {
    return fail("训练频次超过了可训练日期能够容纳的范围。");
  }
  const equipmentIds = new Set(venue.equipment.map((item) => item.equipment_id));
  const exercisesById = new Map(allowedExercises.map((item) => [item.exercise_id, item]));
  for (const capability of result.known_capabilities) {
    if (capability.equipment_id !== null && !equipmentIds.has(capability.equipment_id)) {
      return fail(`能力记录引用了未知器材 ID：${capability.equipment_id}`);
    }
    const exercise = exercisesById.get(capability.exercise_id);
    if (!exercise) return fail(`能力记录引用了未知动作 ID：${capability.exercise_id}`);
    if (exercise.is_bodyweight) {
      if (capability.equipment_id !== null) return fail(`自重动作能力记录不能绑定器材 ID：${capability.exercise_id}`);
    } else if (!capability.equipment_id || !exercise.required_equipment_ids.includes(capability.equipment_id)) {
      return fail(`能力记录的器材不属于动作 ${capability.exercise_id} 的可执行器材。`);
    }
  }
  return result;
}

export function parseAdaptSessionInput(value: unknown): AdaptSessionInput {
  const root = inputRecord(value, "现场调整输入");
  const venue = parseVenueInput(root.venue);
  const allowedExercises = parseAllowedExercises(root.allowed_exercises, venue, true);
  const session = inputRecord(root.current_session, "current_session");
  const trigger = inputRecord(root.trigger, "trigger");
  const equipmentIds = new Set(venue.equipment.map((item) => item.equipment_id));
  const remainingItems = inputList(session.remaining_items, "remaining_items", 40, true).map((entry, index) => {
    const item = inputRecord(entry, `remaining_items[${index}]`);
    const isBodyweight = boolean(item.is_bodyweight, `remaining_items[${index}].is_bodyweight`);
    const equipmentId = inputNullableText(item.equipment_id, `remaining_items[${index}].equipment_id`, 120);
    if (isBodyweight && equipmentId !== null) return fail(`remaining_items[${index}] 的自重动作不能绑定器材。`);
    if (!isBodyweight && (!equipmentId || !equipmentIds.has(equipmentId))) {
      return fail(`remaining_items[${index}] 引用了未知器材 ID。`);
    }
    return {
      item_id: inputText(item.item_id, `remaining_items[${index}].item_id`, 120),
      exercise_name: inputText(item.exercise_name, `remaining_items[${index}].exercise_name`, 160),
      equipment_id: equipmentId,
      is_bodyweight: isBodyweight,
      sets_remaining: integer(item.sets_remaining, `remaining_items[${index}].sets_remaining`, 0, 30),
    };
  });
  const itemIds = new Set<string>();
  for (const item of remainingItems) {
    if (itemIds.has(item.item_id)) return fail(`训练条目 ID 重复：${item.item_id}`);
    itemIds.add(item.item_id);
  }
  const unavailableIds = inputTextList(trigger.unavailable_equipment_ids, "unavailable_equipment_ids", 40);
  for (const id of unavailableIds) {
    if (!equipmentIds.has(id)) return fail(`不可用清单引用了未知器材 ID：${id}`);
  }
  const kind = oneOf(trigger.kind, ["equipment_unavailable", "time_shortened", "body_discomfort", "other"] as const, "trigger.kind");
  const availableMinutes = nullableInteger(trigger.available_minutes, "available_minutes", 1, 300);
  if (kind === "time_shortened" && availableMinutes === null) return fail("时间缩短时必须提供 available_minutes。");
  if (kind === "equipment_unavailable" && unavailableIds.length === 0) return fail("器材不可用时必须提供对应的器材 ID。");
  return {
    venue,
    allowed_exercises: allowedExercises,
    current_session: {
      session_id: inputNullableText(session.session_id, "session_id", 120),
      remaining_items: remainingItems,
    },
    trigger: {
      kind,
      details: inputText(trigger.details, "trigger.details", 2_000),
      unavailable_equipment_ids: unavailableIds,
      available_minutes: availableMinutes,
    },
    constraints: inputTextList(root.constraints, "constraints", 24),
  };
}

export function parseFitnessAiInput(action: "equipment_draft", value: unknown): EquipmentDraftInput;
export function parseFitnessAiInput(action: "plan_draft", value: unknown): PlanDraftInput;
export function parseFitnessAiInput(action: "adapt_session", value: unknown): AdaptSessionInput;
export function parseFitnessAiInput(action: FitnessAiAction, value: unknown): FitnessAiInput {
  if (action === "equipment_draft") return parseEquipmentDraftInput(value);
  if (action === "plan_draft") return parsePlanDraftInput(value);
  return parseAdaptSessionInput(value);
}

function parseSafety(value: unknown): FitnessSafetyNotice {
  const safety = record(value, "安全说明");
  return {
    medical_diagnosis_provided: literalFalse(safety.medical_diagnosis_provided, "medical_diagnosis_provided"),
    stop_if_pain_or_unusual_symptoms: literalTrue(safety.stop_if_pain_or_unusual_symptoms, "stop_if_pain_or_unusual_symptoms"),
    note: outputText(safety.note, "安全说明", 800),
  };
}

function availableEquipmentIds(input: PlanDraftInput | AdaptSessionInput): Set<string> {
  const blocked = "trigger" in input ? new Set(input.trigger.unavailable_equipment_ids) : new Set<string>();
  return new Set(input.venue.equipment
    .filter((item) => (item.status === "available" || item.status === "limited") && !blocked.has(item.equipment_id))
    .map((item) => item.equipment_id));
}

function allowedExerciseMap(
  input: PlanDraftInput | AdaptSessionInput,
): ReadonlyMap<string, FitnessAllowedExercise> {
  return new Map(input.allowed_exercises.map((item) => [item.exercise_id, item]));
}

function parseExerciseIdentity(
  item: Record<string, unknown>,
  exercises: ReadonlyMap<string, FitnessAllowedExercise>,
  label: string,
): FitnessAllowedExercise {
  const exerciseId = outputText(item.exercise_id, `${label}.exercise_id`, 120);
  const exercise = exercises.get(exerciseId);
  if (!exercise) return fail(`AI 返回的${label}引用了未知动作 ID。`);
  // The model still echoes these fields for review, but local canonical data wins.
  outputText(item.exercise_name, `${label}动作名`, 160);
  outputText(item.movement_pattern, `${label}动作模式`, 120);
  return exercise;
}

function parseBinding(
  item: Record<string, unknown>,
  availableIds: ReadonlySet<string>,
  exercise: FitnessAllowedExercise,
  label: string,
): { equipment_id: string | null; is_bodyweight: boolean } {
  const isBodyweight = boolean(item.is_bodyweight, `${label}.is_bodyweight`);
  const equipmentId = outputNullableText(item.equipment_id, `${label}.equipment_id`, 120);
  if (isBodyweight !== exercise.is_bodyweight) {
    return fail(`AI 返回的${label}自重标记与允许动作池不一致。`);
  }
  if (exercise.required_equipment_ids.some((id) => !availableIds.has(id))) {
    return fail(`AI 返回的${label}仍依赖未知、停用或现场不可用的必需器材。`);
  }
  if (isBodyweight) {
    if (equipmentId !== null) return fail(`AI 返回的${label}把自重动作错误绑定到器材。`);
  } else {
    if (!equipmentId || !availableIds.has(equipmentId)) {
      return fail(`AI 返回的${label}引用了未知或不可用的器材 ID。`);
    }
    if (!exercise.required_equipment_ids.includes(equipmentId)) {
      return fail(`AI 返回的${label}器材 ID 不属于该动作的可执行器材。`);
    }
  }
  return { equipment_id: equipmentId, is_bodyweight: isBodyweight };
}

function parseRepRange(value: unknown, label: string): { min: number; max: number } | null {
  if (value === null || value === undefined) return null;
  const range = record(value, `${label}次数范围`);
  const min = integer(range.min, `${label}.rep_range.min`, 1, 200);
  const max = integer(range.max, `${label}.rep_range.max`, 1, 200);
  if (min > max) return fail(`AI 返回的${label}次数范围前后矛盾。`);
  return { min, max };
}

function parseLoadRule(value: unknown, isBodyweight: boolean, label: string): FitnessLoadRule {
  const load = record(value, `${label}负荷规则`);
  const mode = oneOf(load.mode, ["rir_guided", "user_confirmed", "bodyweight"] as const, `${label}.load_rule.mode`);
  if ((isBodyweight && mode !== "bodyweight") || (!isBodyweight && mode === "bodyweight")) {
    return fail(`AI 返回的${label}负荷规则与器材类型不一致。`);
  }
  const instruction = outputText(load.instruction, `${label}负荷说明`, 600);
  if (/\d+(?:[.,]\d+)?\s*(?:kg|kgs|公斤|千克|lb|lbs|磅)/i.test(instruction)) {
    return fail(`AI 返回的${label}包含未经本地确认的具体重量。`);
  }
  return {
    mode,
    target_rir: nullableInteger(load.target_rir, `${label}.load_rule.target_rir`, 0, 5),
    instruction,
  };
}

function parseAlternative(
  value: unknown,
  availableIds: ReadonlySet<string>,
  exercises: ReadonlyMap<string, FitnessAllowedExercise>,
  label: string,
): FitnessDraftAlternative {
  const item = record(value, label);
  const exercise = parseExerciseIdentity(item, exercises, label);
  const binding = parseBinding(item, availableIds, exercise, label);
  return {
    exercise_id: exercise.exercise_id,
    exercise_name: exercise.name,
    movement_pattern: exercise.movement_pattern,
    ...binding,
    reason: outputText(item.reason, `${label}替代理由`, 500),
  };
}

function parseDraftExercise(
  value: unknown,
  availableIds: ReadonlySet<string>,
  exercises: ReadonlyMap<string, FitnessAllowedExercise>,
  label: string,
): FitnessDraftExercise {
  const item = record(value, label);
  const exercise = parseExerciseIdentity(item, exercises, label);
  const binding = parseBinding(item, availableIds, exercise, label);
  const repRange = parseRepRange(item.rep_range, label);
  const duration = nullableInteger(item.duration_seconds, `${label}.duration_seconds`, 15, 14_400);
  if (!repRange && duration === null) return fail(`AI 返回的${label}既没有次数也没有时长。`);
  const alternativesRaw = item.alternatives ?? [];
  if (!Array.isArray(alternativesRaw)) return fail(`AI 返回的${label}替代动作格式不正确。`);
  return {
    exercise_id: exercise.exercise_id,
    exercise_name: exercise.name,
    movement_pattern: exercise.movement_pattern,
    ...binding,
    sets: integer(item.sets, `${label}.sets`, 1, 20),
    rep_range: repRange,
    duration_seconds: duration,
    load_rule: parseLoadRule(item.load_rule, binding.is_bodyweight, label),
    rest_seconds: integer(item.rest_seconds, `${label}.rest_seconds`, 0, 1_200),
    reason: outputText(item.reason, `${label}选择理由`, 600),
    execution_check: outputText(item.execution_check, `${label}可执行性说明`, 600),
    alternatives: alternativesRaw.slice(0, 5).map((entry, index) =>
      parseAlternative(entry, availableIds, exercises, `${label}.alternatives[${index}]`)),
  };
}

export function parseEquipmentDraft(value: unknown): EquipmentDraft {
  const root = record(value, "器材草稿");
  if (root.schema_version !== "1.0") return fail("AI 返回的器材草稿版本无法识别。");
  const rawItems = root.items;
  if (!Array.isArray(rawItems)) return fail("AI 返回的器材清单格式不正确。");
  const items = rawItems.slice(0, MAX_EQUIPMENT).map((entry, index) => {
    const item = record(entry, `第 ${index + 1} 件器材`);
    let load: EquipmentDraft["items"][number]["load"] = null;
    if (item.load !== null && item.load !== undefined) {
      const rawLoad = record(item.load, `第 ${index + 1} 件器材负荷`);
      const valuesRaw = rawLoad.values ?? [];
      if (!Array.isArray(valuesRaw)) return fail("AI 返回的器材重量档位格式不正确。");
      const values = valuesRaw.slice(0, 80).map((entryValue, valueIndex) => finiteNumber(entryValue, `load.values[${valueIndex}]`, 0, 1_000_000));
      const min = nullableNumber(rawLoad.min, "load.min", 0, 1_000_000);
      const max = nullableNumber(rawLoad.max, "load.max", 0, 1_000_000);
      const increment = nullableNumber(rawLoad.increment, "load.increment", 0, 1_000_000);
      if (min !== null && max !== null && min > max) return fail("AI 返回的器材负荷范围前后矛盾。");
      const hasMeasuredLoad = values.length > 0 || min !== null || max !== null || increment !== null;
      const evidence = outputText(rawLoad.evidence, "器材负荷证据", 500);
      if (hasMeasuredLoad && !evidence) return fail("AI 返回了没有来源证据的器材重量。");
      load = {
        unit: rawLoad.unit === null || rawLoad.unit === undefined
          ? null
          : oneOf(rawLoad.unit, ["kg", "lb", "level", "other"] as const, "load.unit"),
        values,
        min,
        max,
        increment,
        evidence,
      };
    }
    return {
      name: outputText(item.name, `第 ${index + 1} 件器材名称`, 160),
      category: oneOf(item.category, EQUIPMENT_CATEGORIES, "器材类别"),
      quantity: nullableInteger(item.quantity, "器材数量", 1, 99),
      location: outputNullableText(item.location, "器材位置", 160),
      observed_capabilities: outputTextList(item.observed_capabilities, "器材能力", 20),
      attachments: outputTextList(item.attachments, "器材附件", 20),
      load,
      source_evidence: outputText(item.source_evidence, "器材来源证据", 500),
      needs_confirmation: outputTextList(item.needs_confirmation, "待确认项", 20),
    };
  });
  const questions = outputTextList(root.questions, "待确认问题", 20);
  if (items.length === 0 && questions.length === 0) return fail("AI 没有返回可核对的器材清单或问题。");
  return {
    schema_version: "1.0",
    draft_only: literalTrue(root.draft_only, "draft_only"),
    summary: outputText(root.summary, "器材草稿摘要", 800),
    items,
    questions,
    warnings: outputTextList(root.warnings, "警告", 16),
  };
}

export function parsePlanDraft(value: unknown, input: PlanDraftInput): PlanDraft {
  const root = record(value, "计划草稿");
  if (root.schema_version !== "1.0") return fail("AI 返回的计划草稿版本无法识别。");
  const rawDays = root.days;
  if (!Array.isArray(rawDays) || rawDays.length === 0) return fail("AI 没有返回训练日草稿。");
  const allowedIds = availableEquipmentIds(input);
  const exercises = allowedExerciseMap(input);
  const days = rawDays.slice(0, MAX_DAYS).map((entry, dayIndex) => {
    const day = record(entry, `第 ${dayIndex + 1} 个训练日`);
    const rawItems = day.items;
    if (!Array.isArray(rawItems)) return fail(`AI 返回的第 ${dayIndex + 1} 个训练日动作格式不正确。`);
    return {
      day_key: outputText(day.day_key, "训练日标识", 80),
      label: outputText(day.label, "训练日名称", 160),
      session_type: oneOf(day.session_type, ["strength", "cardio", "mixed", "recovery", "rest"] as const, "训练日类型"),
      estimated_minutes: integer(day.estimated_minutes, "预计时长", 0, 360),
      items: rawItems.slice(0, MAX_EXERCISES).map((item, itemIndex) =>
        parseDraftExercise(item, allowedIds, exercises, `days[${dayIndex}].items[${itemIndex}]`)),
    };
  });
  const dayKeys = new Set(days.map((day) => day.day_key));
  if (dayKeys.size !== days.length) return fail("AI 返回了重复的训练日标识。");
  const availableDays = new Set(input.weekly_schedule.available_days);
  for (const day of days) {
    if (day.session_type !== "rest" && !availableDays.has(day.day_key)) {
      return fail("AI 返回的训练日不在用户提供的可训练日期中。");
    }
    if (["strength", "cardio", "mixed"].includes(day.session_type) && day.items.length === 0) {
      return fail("AI 返回的训练日没有可执行动作。");
    }
    if (day.session_type !== "rest" && day.estimated_minutes > input.weekly_schedule.session_minutes) {
      return fail("AI 返回的训练日超过了用户提供的时间预算。");
    }
  }
  if (!days.some((day) => day.items.length > 0)) return fail("AI 返回的计划没有任何可执行动作。");
  const strengthSessions = days.filter((day) => day.session_type === "strength" || day.session_type === "mixed").length;
  const cardioSessions = days.filter((day) => day.session_type === "cardio" || day.session_type === "mixed").length;
  if (strengthSessions !== input.weekly_schedule.strength_sessions || cardioSessions !== input.weekly_schedule.cardio_sessions) {
    return fail("AI 返回的计划频次与用户设置不一致。");
  }
  return {
    schema_version: "1.0",
    draft_only: literalTrue(root.draft_only, "draft_only"),
    title: outputText(root.title, "计划标题", 160),
    rationale: outputText(root.rationale, "计划理由", 1_200),
    days,
    assumptions: outputTextList(root.assumptions, "计划假设", 20),
    questions: outputTextList(root.questions, "待确认问题", 20),
    warnings: outputTextList(root.warnings, "警告", 16),
    safety: parseSafety(root.safety),
  };
}

export function parseSessionAdaptation(value: unknown, input: AdaptSessionInput): SessionAdaptationDraft {
  const root = record(value, "现场调整草稿");
  if (root.schema_version !== "1.0") return fail("AI 返回的现场调整版本无法识别。");
  const rawChanges = root.changes;
  if (!Array.isArray(rawChanges) || rawChanges.length === 0) return fail("AI 没有返回可核对的现场调整。");
  const allowedIds = availableEquipmentIds(input);
  const exercises = allowedExerciseMap(input);
  const currentItems = new Map(input.current_session.remaining_items.map((item) => [item.item_id, item]));
  const changes = rawChanges.slice(0, 40).map((entry, index) => {
    const change = record(entry, `第 ${index + 1} 项调整`);
    const operation = oneOf(change.operation, ["replace", "remove", "reorder", "reduce_sets", "shorten_rest", "end_session"] as const, "调整类型");
    const sourceItemId = outputNullableText(change.source_item_id, "原训练条目 ID", 120);
    if (operation === "end_session") {
      if (sourceItemId !== null) return fail("结束训练的调整不能绑定单个训练条目。");
    } else if (!sourceItemId || !currentItems.has(sourceItemId)) {
      return fail("AI 调整引用了未知训练条目 ID。");
    }
    let replacement: FitnessDraftExercise | null = null;
    if (operation === "replace") {
      if (change.replacement === null || change.replacement === undefined) return fail("替换动作缺少新的动作草稿。");
      replacement = parseDraftExercise(change.replacement, allowedIds, exercises, `changes[${index}].replacement`);
    } else if (change.replacement !== null && change.replacement !== undefined) {
      return fail("非替换调整不应包含 replacement。");
    }
    const numericValue = nullableInteger(change.numeric_value, "调整数值", 0, 1_200);
    if (operation === "reduce_sets") {
      const current = sourceItemId ? currentItems.get(sourceItemId) : undefined;
      if (numericValue === null || !current || numericValue > current.sets_remaining) return fail("减少组数的结果无法核对。");
    } else if (operation === "shorten_rest" && (numericValue === null || numericValue < 15)) {
      return fail("缩短休息必须给出至少 15 秒的目标值。");
    } else if (operation === "reorder" && numericValue === null) {
      return fail("重排动作必须给出新的顺序值。");
    } else if (!["reduce_sets", "shorten_rest", "reorder"].includes(operation) && numericValue !== null) {
      return fail("该调整不应包含 numeric_value。");
    }
    return {
      operation,
      source_item_id: sourceItemId,
      explanation: outputText(change.explanation, "调整理由", 800),
      numeric_value: numericValue,
      replacement,
    };
  });
  const estimatedMinutes = nullableInteger(root.estimated_minutes, "调整后时长", 0, 360);
  if (input.trigger.kind === "time_shortened" && estimatedMinutes !== null &&
    input.trigger.available_minutes !== null && estimatedMinutes > input.trigger.available_minutes) {
    return fail("AI 返回的调整仍超过当前可用时间。");
  }
  const safety = parseSafety(root.safety);
  return {
    schema_version: "1.0",
    draft_only: literalTrue(root.draft_only, "draft_only"),
    summary: outputText(root.summary, "现场调整摘要", 800),
    estimated_minutes: estimatedMinutes,
    changes,
    checks: outputTextList(root.checks, "核对项", 20),
    questions: outputTextList(root.questions, "待确认问题", 20),
    warnings: outputTextList(root.warnings, "警告", 16),
    safety,
  };
}

export function parseFitnessAiResult(action: "equipment_draft", value: unknown, input: EquipmentDraftInput): EquipmentDraft;
export function parseFitnessAiResult(action: "plan_draft", value: unknown, input: PlanDraftInput): PlanDraft;
export function parseFitnessAiResult(action: "adapt_session", value: unknown, input: AdaptSessionInput): SessionAdaptationDraft;
export function parseFitnessAiResult(action: FitnessAiAction, value: unknown, input: FitnessAiInput): FitnessAiResult {
  if (action === "equipment_draft") return parseEquipmentDraft(value);
  if (action === "plan_draft") return parsePlanDraft(value, input as PlanDraftInput);
  return parseSessionAdaptation(value, input as AdaptSessionInput);
}
