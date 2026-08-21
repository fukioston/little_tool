import type {
  EquipmentKind,
  FitnessEquipment,
  FitnessEquipmentLoad,
  FitnessExercise,
  MovementPattern,
} from "./types";

export const EQUIPMENT_KIND_LABELS: Readonly<Record<EquipmentKind, string>> = {
  barbell: "杠铃",
  plates: "杠铃片",
  rack: "深蹲架",
  bench: "训练凳",
  dumbbell: "哑铃",
  kettlebell: "壶铃",
  cable: "绳索器械",
  fixed_machine: "固定器械",
  smith_machine: "史密斯机",
  pullup_bar: "引体杆",
  dip_station: "双杠",
  bands: "弹力带",
  mat: "地垫",
  treadmill: "跑步机",
  bike: "健身单车",
  rower: "划船机",
  elliptical: "椭圆机",
  stair_climber: "爬楼机",
  open_space: "开放空间",
  other: "其他",
};

export const MOVEMENT_PATTERN_LABELS: Readonly<Record<MovementPattern, string>> = {
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

export type EquipmentTemplate = Readonly<{
  kind: EquipmentKind;
  label: string;
  suggestedName: string;
  loadMode: FitnessEquipment["load_mode"];
  loadSemantics: FitnessEquipment["load_semantics"];
  asksForDiscreteLoads: boolean;
  hint: string;
}>;

export const EQUIPMENT_TEMPLATES: readonly EquipmentTemplate[] = [
  { kind: "dumbbell", label: "哑铃", suggestedName: "固定哑铃", loadMode: "discrete", loadSemantics: "per_hand", asksForDiscreteLoads: true, hint: "录入每只哑铃的重量；数量少于 2 时不会用于双手动作。" },
  { kind: "barbell", label: "杠铃", suggestedName: "奥杆", loadMode: "plate_loaded", loadSemantics: "total", asksForDiscreteLoads: false, hint: "记录空杆重量；还需要同场地的杠铃片。" },
  { kind: "plates", label: "杠铃片", suggestedName: "杠铃片组", loadMode: "discrete", loadSemantics: "per_side", asksForDiscreteLoads: true, hint: "录入单片重量和总片数，计划只组合左右对称且库存足够的重量。" },
  { kind: "rack", label: "深蹲架", suggestedName: "深蹲架", loadMode: "none", loadSemantics: "total", asksForDiscreteLoads: false, hint: "记录数量、安全杆和常见排队情况。" },
  { kind: "bench", label: "训练凳", suggestedName: "可调训练凳", loadMode: "none", loadSemantics: "total", asksForDiscreteLoads: false, hint: "可在备注记录可用角度。" },
  { kind: "cable", label: "绳索", suggestedName: "可调双滑轮", loadMode: "discrete", loadSemantics: "stack_label", asksForDiscreteLoads: true, hint: "按器械标牌录入真实插片档位；不同倍率不跨器械比较。" },
  { kind: "fixed_machine", label: "固定器械", suggestedName: "固定器械", loadMode: "discrete", loadSemantics: "stack_label", asksForDiscreteLoads: true, hint: "写清动作名称、座椅设置和真实档位。" },
  { kind: "smith_machine", label: "史密斯机", suggestedName: "史密斯机", loadMode: "plate_loaded", loadSemantics: "total", asksForDiscreteLoads: false, hint: "机器杆重若未知就留空，不猜测。" },
  { kind: "kettlebell", label: "壶铃", suggestedName: "壶铃组", loadMode: "discrete", loadSemantics: "total", asksForDiscreteLoads: true, hint: "录入每个可用重量与数量。" },
  { kind: "pullup_bar", label: "引体设施", suggestedName: "引体杆", loadMode: "none", loadSemantics: "total", asksForDiscreteLoads: false, hint: "如有辅助弹力带，请另录弹力带。" },
  { kind: "dip_station", label: "双杠", suggestedName: "双杠设施", loadMode: "none", loadSemantics: "total", asksForDiscreteLoads: false, hint: "记录高度、间距和是否有辅助装置。" },
  { kind: "bands", label: "弹力带", suggestedName: "弹力带", loadMode: "discrete", loadSemantics: "resistance_level", asksForDiscreteLoads: true, hint: "可以使用轻/中/重等相对档位，不伪装成公斤数。" },
  { kind: "mat", label: "地垫", suggestedName: "训练地垫", loadMode: "none", loadSemantics: "total", asksForDiscreteLoads: false, hint: "用于地面核心、活动度和热身。" },
  { kind: "treadmill", label: "跑步机", suggestedName: "跑步机", loadMode: "range", loadSemantics: "resistance_level", asksForDiscreteLoads: false, hint: "可在备注记录速度、坡度范围。" },
  { kind: "bike", label: "健身单车", suggestedName: "健身单车", loadMode: "range", loadSemantics: "resistance_level", asksForDiscreteLoads: false, hint: "记录设备数量与阻力标度。" },
  { kind: "rower", label: "划船机", suggestedName: "划船机", loadMode: "range", loadSemantics: "resistance_level", asksForDiscreteLoads: false, hint: "记录数量与阻尼标度。" },
  { kind: "elliptical", label: "椭圆机", suggestedName: "椭圆机", loadMode: "range", loadSemantics: "resistance_level", asksForDiscreteLoads: false, hint: "记录数量、阻力和坡度的可用范围。" },
  { kind: "stair_climber", label: "爬楼机", suggestedName: "爬楼机", loadMode: "range", loadSemantics: "resistance_level", asksForDiscreteLoads: false, hint: "记录数量与速度档位，计划会保留未知值。" },
  { kind: "open_space", label: "开放空间", suggestedName: "自重训练区", loadMode: "none", loadSemantics: "total", asksForDiscreteLoads: false, hint: "足够完成徒手蹲、俯卧撑和移动热身的空间。" },
  { kind: "other", label: "其他器材", suggestedName: "自定义器材", loadMode: "none", loadSemantics: "total", asksForDiscreteLoads: false, hint: "记下真实名称、数量和用法；在动作类型明确前不会自动排进计划。" },
];

const exercise = (
  id: string,
  nameZh: string,
  nameEn: string,
  pattern: MovementPattern,
  muscles: readonly string[],
  requirements: readonly EquipmentKind[],
  difficulty: FitnessExercise["difficulty"] = "beginner",
  cues: readonly string[] = [],
): FitnessExercise => ({
  id,
  name_zh: nameZh,
  name_en: nameEn,
  pattern,
  primary_muscles: muscles,
  secondary_muscles: [],
  requirements: requirements.map((kind) => ({ kind })),
  difficulty,
  setup_cues: cues,
  safety_note: "保持可控动作幅度；出现疼痛或异常不适时停止，并寻求合格专业人士意见。",
});

export const FITNESS_EXERCISES: readonly FitnessExercise[] = [
  exercise("bodyweight-squat", "徒手深蹲", "Bodyweight squat", "squat", ["股四头肌", "臀肌"], ["open_space"], "beginner", ["脚掌稳定", "保留舒适动作幅度"]),
  exercise("goblet-squat", "高脚杯深蹲", "Goblet squat", "squat", ["股四头肌", "臀肌"], ["dumbbell"]),
  exercise("barbell-back-squat", "杠铃深蹲", "Barbell back squat", "squat", ["股四头肌", "臀肌"], ["barbell", "plates", "rack"], "intermediate"),
  exercise("smith-squat", "史密斯深蹲", "Smith machine squat", "squat", ["股四头肌", "臀肌"], ["smith_machine"], "intermediate"),
  exercise("machine-leg-press", "坐姿腿举", "Machine leg press", "squat", ["股四头肌", "臀肌"], ["fixed_machine"]),
  exercise("dumbbell-rdl", "哑铃罗马尼亚硬拉", "Dumbbell Romanian deadlift", "hinge", ["腘绳肌", "臀肌"], ["dumbbell"]),
  exercise("barbell-rdl", "杠铃罗马尼亚硬拉", "Barbell Romanian deadlift", "hinge", ["腘绳肌", "臀肌"], ["barbell", "plates"], "intermediate"),
  exercise("kettlebell-deadlift", "壶铃硬拉", "Kettlebell deadlift", "hinge", ["臀肌", "腘绳肌"], ["kettlebell"]),
  exercise("push-up", "俯卧撑", "Push-up", "horizontal_push", ["胸肌", "肱三头肌"], ["open_space"]),
  exercise("dumbbell-bench", "哑铃卧推", "Dumbbell bench press", "horizontal_push", ["胸肌", "肱三头肌"], ["dumbbell", "bench"]),
  exercise("barbell-bench", "杠铃卧推", "Barbell bench press", "horizontal_push", ["胸肌", "肱三头肌"], ["barbell", "plates", "rack", "bench"], "intermediate"),
  exercise("cable-chest-press", "绳索胸推", "Cable chest press", "horizontal_push", ["胸肌", "肱三头肌"], ["cable"]),
  exercise("machine-chest-press", "固定器械胸推", "Machine chest press", "horizontal_push", ["胸肌", "肱三头肌"], ["fixed_machine"]),
  exercise("parallel-bar-dip", "双杠屈臂撑", "Parallel bar dip", "horizontal_push", ["胸肌", "肱三头肌"], ["dip_station"], "intermediate"),
  exercise("dumbbell-shoulder-press", "哑铃肩推", "Dumbbell shoulder press", "vertical_push", ["三角肌", "肱三头肌"], ["dumbbell"]),
  exercise("barbell-overhead-press", "杠铃肩上推举", "Barbell overhead press", "vertical_push", ["三角肌", "肱三头肌"], ["barbell", "plates", "rack"], "intermediate"),
  exercise("one-arm-dumbbell-row", "单臂哑铃划船", "One-arm dumbbell row", "horizontal_pull", ["背阔肌", "菱形肌"], ["dumbbell", "bench"]),
  exercise("cable-row", "坐姿绳索划船", "Seated cable row", "horizontal_pull", ["背阔肌", "菱形肌"], ["cable"]),
  exercise("band-row", "弹力带划船", "Resistance band row", "horizontal_pull", ["背阔肌", "菱形肌"], ["bands"]),
  exercise("barbell-row", "杠铃划船", "Barbell row", "horizontal_pull", ["背阔肌", "菱形肌"], ["barbell", "plates"], "intermediate"),
  exercise("pull-up", "引体向上", "Pull-up", "vertical_pull", ["背阔肌", "肱二头肌"], ["pullup_bar"], "intermediate"),
  exercise("cable-pulldown", "高位下拉", "Cable lat pulldown", "vertical_pull", ["背阔肌", "肱二头肌"], ["cable"]),
  exercise("reverse-lunge", "反向弓步", "Reverse lunge", "lunge", ["股四头肌", "臀肌"], ["open_space"]),
  exercise("dumbbell-split-squat", "哑铃分腿蹲", "Dumbbell split squat", "lunge", ["股四头肌", "臀肌"], ["dumbbell"]),
  exercise("farmer-carry", "农夫行走", "Farmer carry", "carry", ["握力", "核心"], ["dumbbell", "open_space"]),
  exercise("dead-bug", "死虫式", "Dead bug", "core", ["核心"], ["mat"]),
  exercise("plank", "平板支撑", "Plank", "core", ["核心"], ["mat"]),
  exercise("cable-face-pull", "绳索面拉", "Cable face pull", "isolation", ["后三角", "上背"], ["cable"]),
  exercise("machine-leg-curl", "固定器械腿弯举", "Machine leg curl", "isolation", ["腘绳肌"], ["fixed_machine"]),
  exercise("band-pull-apart", "弹力带拉开", "Band pull-apart", "isolation", ["后三角", "上背"], ["bands"]),
  exercise("dumbbell-lateral-raise", "哑铃侧平举", "Dumbbell lateral raise", "isolation", ["三角肌"], ["dumbbell"]),
  exercise("treadmill-steady", "跑步机舒适心肺", "Treadmill steady cardio", "cardio", ["心肺"], ["treadmill"]),
  exercise("bike-steady", "单车舒适心肺", "Bike steady cardio", "cardio", ["心肺"], ["bike"]),
  exercise("rower-steady", "划船机舒适心肺", "Rower steady cardio", "cardio", ["心肺"], ["rower"]),
  exercise("elliptical-steady", "椭圆机舒适心肺", "Elliptical steady cardio", "cardio", ["心肺"], ["elliptical"]),
  exercise("stairs-steady", "爬楼机舒适心肺", "Stair climber steady cardio", "cardio", ["心肺"], ["stair_climber"]),
];

export function getFitnessExercise(id: string): FitnessExercise | null {
  return FITNESS_EXERCISES.find((entry) => entry.id === id) ?? null;
}

export function requiredEquipmentQuantity(
  exerciseDefinition: FitnessExercise,
  equipment: FitnessEquipment,
): number {
  if (equipment.unilateral || equipment.kind !== "dumbbell") return 1;
  return exerciseDefinition.id.includes("one-arm") ||
      exerciseDefinition.id.includes("goblet")
    ? 1
    : 2;
}

export function equipmentSupportsExercise(
  exerciseDefinition: FitnessExercise,
  equipment: FitnessEquipment,
  loads?: readonly FitnessEquipmentLoad[],
): boolean {
  if (equipment.status !== "available" && equipment.status !== "limited") return false;
  const requiredQuantity = requiredEquipmentQuantity(exerciseDefinition, equipment);
  if (equipment.quantity < requiredQuantity) return false;
  if (equipment.load_mode !== "discrete" || loads === undefined) return true;

  const recordedLoads = loads.filter((entry) => entry.equipment_id === equipment.id);
  if (recordedLoads.length === 0) return true;
  const quantityByLoad = new Map<number, number>();
  for (const load of recordedLoads) {
    if (!load.available) continue;
    quantityByLoad.set(
      load.load_grams,
      (quantityByLoad.get(load.load_grams) ?? 0) + load.quantity,
    );
  }
  return [...quantityByLoad.values()].some((quantity) => quantity >= requiredQuantity);
}

export function equipmentResourcesForExercise(
  exerciseDefinition: FitnessExercise,
  equipment: readonly FitnessEquipment[],
  loads?: readonly FitnessEquipmentLoad[],
): readonly FitnessEquipment[] | null {
  const resources: FitnessEquipment[] = [];
  for (const requirement of exerciseDefinition.requirements) {
    const resource = equipment.find(
      (entry) =>
        entry.kind === requirement.kind &&
        equipmentSupportsExercise(exerciseDefinition, entry, loads),
    );
    if (!resource) {
      if (requirement.optional) continue;
      return null;
    }
    if (!resources.some((entry) => entry.id === resource.id)) resources.push(resource);
  }
  return resources;
}

export function exerciseFitsEquipment(
  exerciseDefinition: FitnessExercise,
  equipment: readonly FitnessEquipment[],
  loads?: readonly FitnessEquipmentLoad[],
): boolean {
  return equipmentResourcesForExercise(exerciseDefinition, equipment, loads) !== null;
}

export function exercisesForVenue(
  equipment: readonly FitnessEquipment[],
  loads?: readonly FitnessEquipmentLoad[],
): readonly FitnessExercise[] {
  return FITNESS_EXERCISES.filter((entry) => exerciseFitsEquipment(entry, equipment, loads));
}
