import { FITNESS_EXERCISES } from "./catalog";
import type {
  FitnessConstraint,
  FitnessEquipment,
  FitnessEquipmentLoad,
  FitnessExercise,
  FitnessGoal,
  FitnessPlanDraft,
  FitnessProfile,
  FitnessProgramItem,
  FitnessSplit,
  FitnessVenue,
  MovementPattern,
  ProgramDayKind,
} from "./types";

export type FitnessLoadHistory = Readonly<{
  exercise_id: string;
  equipment_id: string;
  load_grams: number;
  completed_at: number;
  completed?: boolean;
  pain?: boolean;
}>;

export type FitnessPlannerContext = Readonly<{
  profile: FitnessProfile;
  venue: FitnessVenue;
  equipment: readonly FitnessEquipment[];
  equipmentLoads: readonly FitnessEquipmentLoad[];
  constraints: readonly FitnessConstraint[];
  exercises?: readonly FitnessExercise[];
  loadHistory?: readonly FitnessLoadHistory[];
  session_minutes?: number;
}>;

export type FitnessPlannerInput = FitnessPlannerContext & Readonly<{
  name?: string;
  goal?: FitnessGoal;
  split?: FitnessSplit;
}>;

export type FitnessPlanValidation = Readonly<{
  valid: boolean;
  errors: readonly string[];
  warnings: readonly string[];
}>;

export type NearestLoadDirection = "nearest" | "at_or_below" | "at_or_above";

type DraftItem = Omit<FitnessProgramItem, "id" | "program_day_id" | "created_at">;

const AVAILABLE_STATUSES = new Set<FitnessEquipment["status"]>([
  "available",
  "limited",
]);
const WEEKDAY_FILL_ORDER = [1, 3, 5, 2, 4, 6, 0] as const;
const RESISTANCE_WARMUP_SECONDS = 5 * 60;
const CARDIO_SETUP_SECONDS = 2 * 60;
const EXERCISE_SETUP_SECONDS = 60;
const EXERCISE_TRANSITION_SECONDS = 45;

const GOAL_LABELS: Readonly<Record<FitnessGoal, string>> = {
  strength: "力量",
  muscle: "肌肉",
  cardio: "心肺",
  general_health: "日常体能",
  sport: "运动表现",
  mobility: "活动能力",
};

const SPLIT_LABELS: Readonly<Record<FitnessSplit, string>> = {
  auto: "自动安排",
  full_body: "全身",
  upper_lower: "上下肢",
  push_pull_legs: "推拉腿",
  custom: "自定义",
};

const PATTERN_LABELS: Readonly<Record<MovementPattern, string>> = {
  squat: "蹲",
  hinge: "髋铰链",
  horizontal_push: "水平推",
  vertical_push: "垂直推",
  horizontal_pull: "水平拉",
  vertical_pull: "垂直拉",
  lunge: "单腿",
  carry: "负重行走",
  core: "核心",
  isolation: "局部辅助",
  cardio: "心肺",
};

const PRIMARY_KIND_PRIORITY: readonly FitnessEquipment["kind"][] = [
  "barbell",
  "smith_machine",
  "dumbbell",
  "kettlebell",
  "cable",
  "fixed_machine",
  "treadmill",
  "bike",
  "rower",
  "elliptical",
  "stair_climber",
  "pullup_bar",
  "dip_station",
  "bands",
  "rack",
  "bench",
  "mat",
  "open_space",
  "plates",
  "other",
];

function integerInRange(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values.filter(Number.isFinite))].sort((left, right) => left - right);
}

function availableEquipment(context: FitnessPlannerContext): FitnessEquipment[] {
  return context.equipment
    .filter(
      (entry) =>
        entry.venue_id === context.venue.id &&
        entry.quantity > 0 &&
        AVAILABLE_STATUSES.has(entry.status),
    )
    .slice()
    .sort((left, right) => {
      const statusDifference =
        Number(left.status === "limited") - Number(right.status === "limited");
      return statusDifference || left.name.localeCompare(right.name, "zh-CN") ||
        left.id.localeCompare(right.id);
    });
}

function activeAvoidConstraints(
  context: Pick<FitnessPlannerContext, "constraints">,
): FitnessConstraint[] {
  return context.constraints.filter(
    (constraint) => constraint.active && constraint.severity === "avoid",
  );
}

function exerciseIsAvoided(
  exercise: FitnessExercise,
  context: Pick<FitnessPlannerContext, "constraints">,
): boolean {
  return activeAvoidConstraints(context).some(
    (constraint) =>
      constraint.exercise_ids.includes(exercise.id) ||
      constraint.movement_patterns.includes(exercise.pattern),
  );
}

function requiredLoadQuantity(
  exercise: FitnessExercise,
  equipment: FitnessEquipment,
): number {
  if (equipment.unilateral) return 1;
  if (equipment.kind === "kettlebell") return 1;
  if (equipment.kind !== "dumbbell") return 1;
  if (
    exercise.id.includes("one-arm") ||
    exercise.id.includes("goblet")
  ) {
    return 1;
  }
  return 2;
}

function discreteLoadsForExercise(
  exercise: FitnessExercise,
  equipment: FitnessEquipment,
  loads: readonly FitnessEquipmentLoad[],
): number[] {
  const requiredQuantity = requiredLoadQuantity(exercise, equipment);
  return uniqueNumbers(
    loads
      .filter(
        (entry) =>
          entry.equipment_id === equipment.id &&
          entry.available &&
          entry.quantity >= requiredQuantity &&
          entry.load_grams >= 0 &&
          (equipment.min_load_grams === null ||
            entry.load_grams >= equipment.min_load_grams) &&
          (equipment.max_load_grams === null ||
            entry.load_grams <= equipment.max_load_grams),
      )
      .map((entry) => entry.load_grams),
  );
}

function candidateSupportsExercise(
  exercise: FitnessExercise,
  equipment: FitnessEquipment,
  loads: readonly FitnessEquipmentLoad[],
): boolean {
  if (equipment.load_mode !== "discrete") return true;
  const recordedLoads = loads.filter((entry) => entry.equipment_id === equipment.id);
  if (recordedLoads.length === 0) return true;
  return discreteLoadsForExercise(exercise, equipment, loads).length > 0;
}

function resourcesForExercise(
  exercise: FitnessExercise,
  context: FitnessPlannerContext,
): FitnessEquipment[] | null {
  const venueEquipment = availableEquipment(context);
  const chosen: FitnessEquipment[] = [];

  for (const requirement of exercise.requirements) {
    const candidate = venueEquipment.find(
      (entry) =>
        entry.kind === requirement.kind &&
        candidateSupportsExercise(exercise, entry, context.equipmentLoads),
    );
    if (!candidate) {
      if (requirement.optional) continue;
      return null;
    }
    if (!chosen.some((entry) => entry.id === candidate.id)) chosen.push(candidate);
  }

  return chosen;
}

function primaryEquipment(resources: readonly FitnessEquipment[]): FitnessEquipment | null {
  for (const kind of PRIMARY_KIND_PRIORITY) {
    const match = resources.find((entry) => entry.kind === kind);
    if (match) return match;
  }
  return resources[0] ?? null;
}

function exerciseCatalog(context: FitnessPlannerContext): readonly FitnessExercise[] {
  return context.exercises ?? FITNESS_EXERCISES;
}

function exerciseById(
  id: string,
  context: FitnessPlannerContext,
): FitnessExercise | null {
  return exerciseCatalog(context).find((entry) => entry.id === id) ?? null;
}

function difficultyRank(
  exercise: FitnessExercise,
  experience: FitnessProfile["experience"],
): number {
  const base = exercise.difficulty === "beginner"
    ? 0
    : exercise.difficulty === "intermediate"
      ? 1
      : 2;
  if (experience === "advanced") return 2 - base;
  if (experience === "consistent") return base === 2 ? 2 : base;
  return base;
}

function feasibleExercisesForPattern(
  pattern: MovementPattern,
  context: FitnessPlannerContext,
): readonly FitnessExercise[] {
  return exerciseCatalog(context)
    .filter(
      (exercise) =>
        exercise.pattern === pattern &&
        !exerciseIsAvoided(exercise, context) &&
        resourcesForExercise(exercise, context) !== null,
    )
    .map((exercise, catalogIndex) => ({ exercise, catalogIndex }))
    .sort(
      (left, right) =>
        difficultyRank(left.exercise, context.profile.experience) -
          difficultyRank(right.exercise, context.profile.experience) ||
        left.catalogIndex - right.catalogIndex ||
        left.exercise.id.localeCompare(right.exercise.id),
    )
    .map(({ exercise }) => exercise);
}

/**
 * Return every symmetric total that can be built from a known bar and the
 * available plate inventory. Plate quantities are total physical plates, so
 * each usable pair consumes two.
 */
export function computeBarbellLoads(
  barGrams: number | null,
  plateLoads: readonly FitnessEquipmentLoad[],
): readonly number[] {
  if (barGrams === null || !Number.isFinite(barGrams) || barGrams < 0) return [];

  let sideTotals = new Set<number>([0]);
  const availablePlates = plateLoads
    .filter(
      (entry) =>
        entry.available &&
        entry.load_grams > 0 &&
        Number.isFinite(entry.load_grams) &&
        entry.quantity >= 2,
    )
    .slice()
    .sort(
      (left, right) =>
        left.load_grams - right.load_grams || left.id.localeCompare(right.id),
    );

  for (const plate of availablePlates) {
    const pairCount = Math.floor(plate.quantity / 2);
    const before = [...sideTotals];
    const next = new Set(sideTotals);
    for (const previousTotal of before) {
      for (let count = 1; count <= pairCount; count += 1) {
        next.add(previousTotal + plate.load_grams * count);
      }
    }
    sideTotals = next;
  }

  return uniqueNumbers(
    [...sideTotals].map((perSide) => barGrams + perSide * 2),
  );
}

/**
 * Return only loads the recorded equipment can really produce. For a
 * plate-loaded item, callers pass the compatible plate rows for that item.
 */
export function availableLoadsForEquipment(
  equipment: FitnessEquipment,
  loads: readonly FitnessEquipmentLoad[],
): readonly number[] {
  if (!AVAILABLE_STATUSES.has(equipment.status) || equipment.quantity <= 0) return [];
  if (equipment.load_mode === "none") return [];
  if (equipment.load_mode === "plate_loaded") {
    return computeBarbellLoads(equipment.bar_weight_grams, loads);
  }
  if (equipment.load_mode === "discrete") {
    const requiredQuantity =
      equipment.kind === "dumbbell" && !equipment.unilateral ? 2 : 1;
    return uniqueNumbers(
      loads
        .filter(
          (entry) =>
            entry.equipment_id === equipment.id &&
            entry.available &&
            entry.quantity >= requiredQuantity &&
            entry.load_grams >= 0 &&
            (equipment.min_load_grams === null ||
              entry.load_grams >= equipment.min_load_grams) &&
            (equipment.max_load_grams === null ||
              entry.load_grams <= equipment.max_load_grams),
        )
        .map((entry) => entry.load_grams),
    );
  }

  const minimum = equipment.min_load_grams;
  const maximum = equipment.max_load_grams;
  const increment = equipment.increment_grams;
  if (
    minimum === null ||
    maximum === null ||
    increment === null ||
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    !Number.isFinite(increment) ||
    minimum < 0 ||
    maximum < minimum ||
    increment <= 0
  ) {
    return [];
  }

  const result: number[] = [];
  for (let value = minimum; value <= maximum && result.length < 10_000; value += increment) {
    result.push(value);
  }
  return uniqueNumbers(result);
}

export function nearestAvailableLoad(
  targetGrams: number,
  availableLoads: readonly number[],
  direction: NearestLoadDirection = "nearest",
): number | null {
  if (!Number.isFinite(targetGrams)) return null;
  const options = uniqueNumbers(availableLoads);
  if (direction === "at_or_below") {
    return options.filter((value) => value <= targetGrams).at(-1) ?? null;
  }
  if (direction === "at_or_above") {
    return options.find((value) => value >= targetGrams) ?? null;
  }
  return options.reduce<number | null>((best, value) => {
    if (best === null) return value;
    const distance = Math.abs(value - targetGrams);
    const bestDistance = Math.abs(best - targetGrams);
    return distance < bestDistance || (distance === bestDistance && value < best)
      ? value
      : best;
  }, null);
}

function loadOptionsForExercise(
  exercise: FitnessExercise,
  primary: FitnessEquipment | null,
  resources: readonly FitnessEquipment[],
  context: FitnessPlannerContext,
): readonly number[] {
  if (!primary) return [];
  if (primary.load_mode === "discrete") {
    return discreteLoadsForExercise(exercise, primary, context.equipmentLoads);
  }
  if (primary.load_mode === "plate_loaded") {
    const plateIds = new Set(
      resources.filter((entry) => entry.kind === "plates").map((entry) => entry.id),
    );
    const plateRows = context.equipmentLoads.filter((entry) =>
      plateIds.has(entry.equipment_id)
    );
    return availableLoadsForEquipment(primary, plateRows);
  }
  return availableLoadsForEquipment(primary, context.equipmentLoads);
}

function comparableHistory(
  exerciseId: string,
  equipmentId: string,
  context: FitnessPlannerContext,
): FitnessLoadHistory | null {
  return (context.loadHistory ?? [])
    .filter(
      (entry) =>
        entry.exercise_id === exerciseId &&
        entry.equipment_id === equipmentId &&
        entry.completed !== false &&
        entry.pain !== true &&
        Number.isFinite(entry.load_grams) &&
        entry.load_grams >= 0,
    )
    .slice()
    .sort(
      (left, right) =>
        right.completed_at - left.completed_at ||
        right.load_grams - left.load_grams,
    )[0] ?? null;
}

function resolveExactLoad(
  exercise: FitnessExercise,
  primary: FitnessEquipment | null,
  resources: readonly FitnessEquipment[],
  context: FitnessPlannerContext,
): number | null {
  if (!primary) return null;
  const history = comparableHistory(exercise.id, primary.id, context);
  if (!history) return null;
  return nearestAvailableLoad(
    history.load_grams,
    loadOptionsForExercise(exercise, primary, resources, context),
    "at_or_below",
  );
}

function prescriptionForGoal(
  goal: FitnessGoal,
  profile: FitnessProfile,
): Pick<DraftItem, "sets" | "rep_min" | "rep_max" | "target_rir" | "rest_seconds"> {
  const targetRir = integerInRange(profile.preferred_rir, 0, 5);
  const restSeconds = integerInRange(profile.rest_seconds, 30, 600);
  if (goal === "strength") {
    return {
      sets: profile.experience === "advanced" ? 4 : 3,
      rep_min: 5,
      rep_max: 6,
      target_rir: targetRir,
      rest_seconds: restSeconds,
    };
  }
  if (goal === "muscle") {
    return {
      sets: 3,
      rep_min: 8,
      rep_max: 12,
      target_rir: targetRir,
      rest_seconds: restSeconds,
    };
  }
  if (goal === "sport") {
    return {
      sets: 3,
      rep_min: 6,
      rep_max: 10,
      target_rir: targetRir,
      rest_seconds: restSeconds,
    };
  }
  return {
    sets: 2,
    rep_min: 8,
    rep_max: 12,
    target_rir: targetRir,
    rest_seconds: restSeconds,
  };
}

function estimateItemSeconds(item: DraftItem): number {
  if (item.duration_seconds !== null) {
    return EXERCISE_SETUP_SECONDS + item.duration_seconds + EXERCISE_TRANSITION_SECONDS;
  }
  const averageReps = item.rep_min !== null && item.rep_max !== null
    ? (item.rep_min + item.rep_max) / 2
    : 8;
  const workSeconds = Math.max(30, averageReps * 4) * item.sets;
  return EXERCISE_SETUP_SECONDS + workSeconds +
    Math.max(0, item.sets - 1) * item.rest_seconds +
    EXERCISE_TRANSITION_SECONDS;
}

function estimateDaySeconds(kind: ProgramDayKind, items: readonly DraftItem[]): number {
  const base = kind === "cardio" ? CARDIO_SETUP_SECONDS : RESISTANCE_WARMUP_SECONDS;
  return base + items.reduce((total, item) => total + estimateItemSeconds(item), 0);
}

function resolvedSplit(split: FitnessSplit, resistanceDays: number): FitnessSplit {
  if (split !== "auto") return split;
  if (resistanceDays <= 3) return "full_body";
  if (resistanceDays === 4) return "upper_lower";
  return "push_pull_legs";
}

function effectiveFrequencies(profile: FitnessProfile): Readonly<{
  resistance: number;
  cardio: number;
  requestedTotal: number;
}> {
  const resistance = integerInRange(profile.resistance_days_per_week, 0, 7);
  const requestedCardio = integerInRange(profile.cardio_days_per_week, 0, 7);
  return {
    resistance,
    cardio: Math.min(requestedCardio, Math.max(0, 7 - resistance)),
    requestedTotal: resistance + requestedCardio,
  };
}

function selectedWeekdays(profile: FitnessProfile, count: number): number[] {
  const preferred = profile.preferred_weekdays.filter(
    (weekday, index, values) =>
      Number.isInteger(weekday) &&
      weekday >= 0 &&
      weekday <= 6 &&
      values.indexOf(weekday) === index,
  );
  const result = preferred.slice(0, count);
  for (const weekday of WEEKDAY_FILL_ORDER) {
    if (result.length >= count) break;
    if (!result.includes(weekday)) result.push(weekday);
  }
  return result;
}

function focusPatterns(split: FitnessSplit, dayIndex: number): readonly MovementPattern[] {
  if (split === "upper_lower") {
    return dayIndex % 2 === 0
      ? ["horizontal_push", "horizontal_pull", "vertical_push", "vertical_pull", "isolation"]
      : ["squat", "hinge", "lunge", "core", "carry"];
  }
  if (split === "push_pull_legs") {
    const rotation: readonly (readonly MovementPattern[])[] = [
      ["horizontal_push", "vertical_push", "isolation", "core"],
      ["horizontal_pull", "vertical_pull", "hinge", "isolation"],
      ["squat", "hinge", "lunge", "carry", "core"],
    ];
    return rotation[dayIndex % rotation.length];
  }
  const rotation: readonly (readonly MovementPattern[])[] = [
    ["squat", "horizontal_push", "horizontal_pull", "hinge", "core"],
    ["hinge", "vertical_push", "vertical_pull", "lunge", "core"],
    ["lunge", "horizontal_push", "horizontal_pull", "squat", "carry"],
  ];
  return rotation[dayIndex % rotation.length];
}

function resistanceDayName(split: FitnessSplit, dayIndex: number): string {
  if (split === "upper_lower") return dayIndex % 2 === 0 ? "上肢" : "下肢";
  if (split === "push_pull_legs") return ["推", "拉", "腿"][dayIndex % 3];
  if (split === "full_body") return `全身 ${String.fromCharCode(65 + dayIndex % 3)}`;
  return `训练 ${dayIndex + 1}`;
}

function createResistanceItem(
  exercise: FitnessExercise,
  orderIndex: number,
  goal: FitnessGoal,
  context: FitnessPlannerContext,
): DraftItem | null {
  const resources = resourcesForExercise(exercise, context);
  if (!resources) return null;
  const primary = primaryEquipment(resources);
  const load = resolveExactLoad(exercise, primary, resources, context);
  const substitutions = feasibleExercisesForPattern(exercise.pattern, context)
    .filter((candidate) => candidate.id !== exercise.id)
    .slice(0, 3)
    .map((candidate) => candidate.id);
  const prescription = prescriptionForGoal(goal, context.profile);

  return {
    exercise_id: exercise.id,
    equipment_id: primary?.id ?? null,
    resource_equipment_ids: resources.map((entry) => entry.id),
    order_index: orderIndex,
    ...prescription,
    duration_seconds: null,
    load_grams: load,
    load_guidance: load === null
      ? "重量留待现场确认；选择动作可控、仍能保留目标 RIR 的真实档位。"
      : `沿用同一器械近期记录可实现的 ${load / 1000} kg；当天状态不合适时可以保持或降低。`,
    rationale: `覆盖${exercise.name_zh}对应的${exercise.pattern}动作模式，并使用当前场地已记录器械。`,
    substitution_exercise_ids: substitutions,
    equipment_snapshot: resources.map((entry) => entry.name).join(" · "),
  };
}

function buildResistanceDay(
  dayIndex: number,
  weekday: number,
  goal: FitnessGoal,
  split: FitnessSplit,
  sessionMinutes: number,
  context: FitnessPlannerContext,
  warnings: string[],
): FitnessPlanDraft["days"][number] | null {
  const items: DraftItem[] = [];
  const patterns = focusPatterns(split, dayIndex);
  let stoppedForTime = false;

  for (const pattern of patterns) {
    const candidates = feasibleExercisesForPattern(pattern, context);
    if (candidates.length === 0) {
      warnings.push(`当前场地没有满足限制的${PATTERN_LABELS[pattern]}动作，本次不会用不确定动作补位。`);
      continue;
    }
    const exercise = candidates[dayIndex % candidates.length];
    const item = createResistanceItem(exercise, items.length, goal, context);
    if (!item) continue;
    const candidateSeconds = estimateDaySeconds("resistance", [...items, item]);
    if (candidateSeconds > sessionMinutes * 60) {
      stoppedForTime = true;
      break;
    }
    items.push(item);
  }

  if (stoppedForTime) {
    warnings.push(`每场按 ${sessionMinutes} 分钟保留原休息时间，低优先动作已从草稿中省略。`);
  }
  if (items.length === 0) {
    warnings.push(`星期 ${weekday} 暂无能在 ${sessionMinutes} 分钟内完成的阻力训练草稿。`);
    return null;
  }

  return {
    weekday,
    kind: "resistance",
    name: resistanceDayName(split, dayIndex),
    focus: patterns.map((pattern) => PATTERN_LABELS[pattern]).join(" · "),
    estimated_minutes: Math.ceil(estimateDaySeconds("resistance", items) / 60),
    items,
  };
}

function buildCardioDay(
  dayIndex: number,
  weekday: number,
  sessionMinutes: number,
  context: FitnessPlannerContext,
  warnings: string[],
): FitnessPlanDraft["days"][number] | null {
  const candidates = feasibleExercisesForPattern("cardio", context);
  const exercise = candidates[dayIndex % Math.max(1, candidates.length)];
  if (!exercise) {
    warnings.push("当前场地没有已确认可用的心肺器械，未生成心肺训练占位。");
    return null;
  }
  const resources = resourcesForExercise(exercise, context);
  if (!resources) return null;
  const primary = primaryEquipment(resources);
  const usableSeconds = sessionMinutes * 60 - CARDIO_SETUP_SECONDS -
    EXERCISE_SETUP_SECONDS - EXERCISE_TRANSITION_SECONDS;
  if (usableSeconds < 5 * 60) {
    warnings.push(`星期 ${weekday} 的时间不足以放入包含设置缓冲的心肺训练。`);
    return null;
  }
  const item: DraftItem = {
    exercise_id: exercise.id,
    equipment_id: primary?.id ?? null,
    resource_equipment_ids: resources.map((entry) => entry.id),
    order_index: 0,
    sets: 1,
    rep_min: null,
    rep_max: null,
    duration_seconds: usableSeconds,
    target_rir: null,
    rest_seconds: 0,
    load_grams: null,
    load_guidance: "使用舒适、可持续的主观强度；不自动推算心率区间。",
    rationale: "使用当前场地已确认的心肺器械，并为设置和结束保留时间。",
    substitution_exercise_ids: candidates
      .filter((candidate) => candidate.id !== exercise.id)
      .slice(0, 3)
      .map((candidate) => candidate.id),
    equipment_snapshot: resources.map((entry) => entry.name).join(" · "),
  };
  return {
    weekday,
    kind: "cardio",
    name: `舒适心肺 ${dayIndex + 1}`,
    focus: "按可持续主观强度完成",
    estimated_minutes: Math.ceil(estimateDaySeconds("cardio", [item]) / 60),
    items: [item],
  };
}

export function buildFitnessPlanDraft(input: FitnessPlannerInput): FitnessPlanDraft {
  const frequencies = effectiveFrequencies(input.profile);
  const split = resolvedSplit(
    input.split ?? input.profile.split,
    frequencies.resistance,
  );
  const goal = input.goal ?? input.profile.goals[0] ?? "general_health";
  const sessionMinutes = integerInRange(
    input.session_minutes ?? input.profile.session_minutes ??
      input.venue.default_session_minutes,
    5,
    240,
  );
  const assumptions = [
    `计划只使用「${input.venue.name}」中标记为可用或受限的器械。`,
    `每场按 ${sessionMinutes} 分钟计算，休息时间不会为塞入更多动作而缩短。`,
    "没有同动作、同器械的可比较记录时，重量保持为空并在现场确认。",
  ];
  const warnings: string[] = [];

  if (input.venue.status !== "active") {
    warnings.push("当前场地已归档，因此没有生成训练草稿。");
  }
  if (frequencies.requestedTotal > 7) {
    warnings.push("力量与心肺频次合计超过一周七天；草稿先保留力量日，再放入可容纳的心肺日。");
  }
  const avoided = activeAvoidConstraints(input);
  if (avoided.length > 0) {
    assumptions.push(`已按 ${avoided.length} 条“避免”限制过滤动作与替代项。`);
  }

  const limited = availableEquipment(input).filter((entry) => entry.status === "limited");
  if (limited.length > 0) {
    warnings.push(
      `${limited.map((entry) => `「${entry.name}」`).join("、")}当前标记为受限，开始前可再次确认。`,
    );
  }

  const days: FitnessPlanDraft["days"][number][] = [];
  if (input.venue.status === "active") {
    const weekdays = selectedWeekdays(
      input.profile,
      frequencies.resistance + frequencies.cardio,
    );
    for (let index = 0; index < frequencies.resistance; index += 1) {
      const day = buildResistanceDay(
        index,
        weekdays[index],
        goal,
        split,
        sessionMinutes,
        input,
        warnings,
      );
      if (day) days.push(day);
    }
    for (let index = 0; index < frequencies.cardio; index += 1) {
      const day = buildCardioDay(
        index,
        weekdays[frequencies.resistance + index],
        sessionMinutes,
        input,
        warnings,
      );
      if (day) days.push(day);
    }
  }

  return {
    name: input.name?.trim() || `${GOAL_LABELS[goal]} · ${SPLIT_LABELS[split]}`,
    venue_id: input.venue.id,
    goal,
    split,
    assumptions: uniqueStrings(assumptions),
    warnings: uniqueStrings(warnings),
    days,
  };
}

function resourcesSatisfyExercise(
  exercise: FitnessExercise,
  resources: readonly FitnessEquipment[],
  context: FitnessPlannerContext,
): boolean {
  return exercise.requirements.every((requirement) => {
    if (requirement.optional) return true;
    return resources.some(
      (equipment) =>
        equipment.kind === requirement.kind &&
        candidateSupportsExercise(exercise, equipment, context.equipmentLoads),
    );
  });
}

function contextWithResources(
  resources: readonly FitnessEquipment[],
  context: FitnessPlannerContext,
): FitnessPlannerContext {
  return { ...context, equipment: resources };
}

export function validateFitnessPlanDraft(
  draft: FitnessPlanDraft,
  context: FitnessPlannerContext,
): FitnessPlanValidation {
  const errors: string[] = [];
  const warnings = [...draft.warnings];
  const sessionMinutes = integerInRange(
    context.session_minutes ?? context.profile.session_minutes,
    5,
    240,
  );
  const seenWeekdays = new Set<number>();

  if (draft.venue_id !== context.venue.id) {
    errors.push("草稿场地与当前校验场地不一致。");
  }
  if (context.venue.status !== "active") {
    errors.push("当前场地已归档，不能启用这份草稿。");
  }
  if (draft.days.length === 0) {
    errors.push("当前场地与身体边界下还没有可执行的训练日。");
  }

  for (const day of draft.days) {
    if (day.weekday === null || day.weekday < 0 || day.weekday > 6) {
      errors.push(`${day.name}没有有效的星期信息。`);
    } else if (seenWeekdays.has(day.weekday)) {
      errors.push(`星期 ${day.weekday} 出现了重复训练安排。`);
    } else {
      seenWeekdays.add(day.weekday);
    }
    if (day.kind === "rest") {
      if (day.items.length > 0) errors.push(`${day.name}是休息日，但仍包含训练动作。`);
      continue;
    }
    if (day.items.length === 0) errors.push(`${day.name}没有可执行动作。`);
    const expectedSeconds = estimateDaySeconds(day.kind, day.items);
    if (expectedSeconds > sessionMinutes * 60 || day.estimated_minutes > sessionMinutes) {
      errors.push(`${day.name}超过 ${sessionMinutes} 分钟的会话预算。`);
    }
    if (day.estimated_minutes * 60 < expectedSeconds) {
      errors.push(`${day.name}的预计时长没有包含完整执行和休息时间。`);
    }

    day.items.forEach((item, itemIndex) => {
      const exercise = exerciseById(item.exercise_id, context);
      if (!exercise) {
        errors.push(`${day.name}包含未知动作 ${item.exercise_id}。`);
        return;
      }
      if (exerciseIsAvoided(exercise, context)) {
        errors.push(`${exercise.name_zh}命中当前“避免”限制。`);
      }
      if (day.kind === "cardio" && exercise.pattern !== "cardio") {
        errors.push(`${day.name}的心肺日包含了非心肺动作 ${exercise.name_zh}。`);
      }
      if (day.kind === "resistance" && exercise.pattern === "cardio") {
        errors.push(`${day.name}的阻力训练包含了心肺动作 ${exercise.name_zh}。`);
      }
      if (item.order_index !== itemIndex) {
        errors.push(`${day.name}的动作顺序索引不连续。`);
      }
      if (item.sets < 1 || !Number.isInteger(item.sets)) {
        errors.push(`${exercise.name_zh}的组数无效。`);
      }
      if (
        exercise.pattern !== "cardio" &&
        item.rest_seconds < integerInRange(context.profile.rest_seconds, 30, 600)
      ) {
        errors.push(`${exercise.name_zh}压缩了用户设定的组间休息。`);
      }

      const resourceIds = uniqueStrings(item.resource_equipment_ids);
      if (resourceIds.length !== item.resource_equipment_ids.length) {
        errors.push(`${exercise.name_zh}的器械资源列表包含重复项。`);
      }
      const resources = resourceIds.flatMap((id) => {
        const equipment = context.equipment.find((entry) => entry.id === id);
        if (!equipment) {
          errors.push(`${exercise.name_zh}引用了未知器械 ${id}。`);
          return [];
        }
        if (equipment.venue_id !== context.venue.id) {
          errors.push(`${exercise.name_zh}引用了其他场地的器械 ${equipment.name}。`);
        }
        if (!AVAILABLE_STATUSES.has(equipment.status)) {
          errors.push(`${exercise.name_zh}引用的${equipment.name}当前不可用。`);
        }
        return [equipment];
      });
      if (!resourcesSatisfyExercise(exercise, resources, context)) {
        errors.push(`${exercise.name_zh}没有列齐完成动作所需的当前场地器械。`);
      }
      if (item.equipment_id !== null && !resourceIds.includes(item.equipment_id)) {
        errors.push(`${exercise.name_zh}的主要器械没有包含在资源列表中。`);
      }

      if (item.load_grams !== null) {
        if (item.equipment_id === null) {
          errors.push(`${exercise.name_zh}有精确重量，但没有主要器械。`);
        } else {
          const primary = resources.find((entry) => entry.id === item.equipment_id);
          if (!primary) {
            errors.push(`${exercise.name_zh}的主要器械无法用于重量校验。`);
          } else {
            const history = comparableHistory(exercise.id, primary.id, context);
            if (!history) {
              errors.push(`${exercise.name_zh}没有同器械历史，因此不能填写精确重量。`);
            }
            const loads = loadOptionsForExercise(
              exercise,
              primary,
              resources,
              contextWithResources(resources, context),
            );
            if (!loads.includes(item.load_grams)) {
              errors.push(`${exercise.name_zh}的重量不在当前器械可实现档位中。`);
            }
          }
        }
      }

      for (const substitutionId of item.substitution_exercise_ids) {
        const substitution = exerciseById(substitutionId, context);
        if (!substitution) {
          errors.push(`${exercise.name_zh}包含未知替代动作 ${substitutionId}。`);
          continue;
        }
        if (substitution.pattern !== exercise.pattern) {
          errors.push(`${substitution.name_zh}与${exercise.name_zh}不是同一动作模式。`);
        }
        if (
          exerciseIsAvoided(substitution, context) ||
          resourcesForExercise(substitution, context) === null
        ) {
          errors.push(`${substitution.name_zh}不是当前场地可执行的替代动作。`);
        }
      }
    });
  }

  const frequencies = effectiveFrequencies(context.profile);
  const resistanceDays = draft.days.filter((day) => day.kind === "resistance").length;
  const cardioDays = draft.days.filter((day) => day.kind === "cardio").length;
  if (resistanceDays !== frequencies.resistance) {
    errors.push(`草稿包含 ${resistanceDays} 个阻力训练日，与当前设定不一致。`);
  }
  if (cardioDays !== frequencies.cardio) {
    errors.push(`草稿包含 ${cardioDays} 个心肺训练日，与当前设定不一致。`);
  }

  return {
    valid: errors.length === 0,
    errors: uniqueStrings(errors),
    warnings: uniqueStrings(warnings),
  };
}
