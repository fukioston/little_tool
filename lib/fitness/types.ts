export type FitnessView =
  | "today"
  | "plan"
  | "calendar"
  | "venues"
  | "history"
  | "exercises"
  | "profile"
  | "settings";

export type FitnessGoal =
  | "strength"
  | "muscle"
  | "cardio"
  | "general_health"
  | "sport"
  | "mobility";

export type FitnessExperience = "new" | "returning" | "consistent" | "advanced";
export type FitnessSplit =
  | "auto"
  | "full_body"
  | "upper_lower"
  | "push_pull_legs"
  | "custom";

export type EquipmentKind =
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

export type EquipmentStatus = "available" | "limited" | "maintenance" | "removed";
export type EquipmentLoadMode = "none" | "discrete" | "range" | "plate_loaded";
export type EquipmentLoadSemantics =
  | "total"
  | "per_hand"
  | "per_side"
  | "stack_label"
  | "resistance_level";

export type MovementPattern =
  | "squat"
  | "hinge"
  | "horizontal_push"
  | "vertical_push"
  | "horizontal_pull"
  | "vertical_pull"
  | "lunge"
  | "carry"
  | "core"
  | "isolation"
  | "cardio";

export type FitnessProfile = Readonly<{
  id: "profile";
  goals: readonly FitnessGoal[];
  experience: FitnessExperience;
  resistance_days_per_week: number;
  cardio_days_per_week: number;
  session_minutes: number;
  split: FitnessSplit;
  preferred_weekdays: readonly number[];
  preferred_rir: number;
  rest_seconds: number;
  unit: "kg" | "lb";
  notes: string;
  created_at: number;
  updated_at: number;
}>;

export type FitnessVenue = Readonly<{
  id: string;
  name: string;
  venue_type: "commercial" | "home" | "office" | "hotel" | "outdoor" | "other";
  location: string;
  area_notes: string;
  busy_notes: string;
  default_session_minutes: number;
  supersets_allowed: boolean;
  is_default: boolean;
  status: "active" | "archived";
  last_verified_at: number | null;
  created_at: number;
  updated_at: number;
}>;

export type FitnessEquipment = Readonly<{
  id: string;
  venue_id: string;
  name: string;
  kind: EquipmentKind;
  area: string;
  quantity: number;
  status: EquipmentStatus;
  load_mode: EquipmentLoadMode;
  load_semantics: EquipmentLoadSemantics;
  min_load_grams: number | null;
  max_load_grams: number | null;
  increment_grams: number | null;
  bar_weight_grams: number | null;
  unilateral: boolean;
  busy_level: "unknown" | "low" | "medium" | "high";
  settings: Readonly<Record<string, string | number | boolean>>;
  attachments: readonly string[];
  notes: string;
  created_at: number;
  updated_at: number;
}>;

export type FitnessEquipmentLoad = Readonly<{
  id: string;
  equipment_id: string;
  load_grams: number;
  quantity: number;
  label: string;
  available: boolean;
  created_at: number;
}>;

export type FitnessConstraint = Readonly<{
  id: string;
  label: string;
  body_area: string;
  severity: "monitor" | "modify" | "avoid";
  movement_patterns: readonly MovementPattern[];
  exercise_ids: readonly string[];
  note: string;
  active: boolean;
  created_at: number;
  updated_at: number;
}>;

export type ExerciseRequirement = Readonly<{
  kind: EquipmentKind;
  optional?: boolean;
}>;

export type FitnessExercise = Readonly<{
  id: string;
  name_zh: string;
  name_en: string;
  pattern: MovementPattern;
  primary_muscles: readonly string[];
  secondary_muscles: readonly string[];
  requirements: readonly ExerciseRequirement[];
  difficulty: "beginner" | "intermediate" | "advanced";
  setup_cues: readonly string[];
  safety_note: string;
  is_custom?: boolean;
}>;

export type ProgramStatus = "draft" | "active" | "archived";
export type ProgramDayKind = "resistance" | "cardio" | "rest";

export type FitnessProgram = Readonly<{
  id: string;
  name: string;
  venue_id: string;
  goal: FitnessGoal;
  split: FitnessSplit;
  status: ProgramStatus;
  version: number;
  source: "local" | "ai_draft" | "manual";
  assumptions: readonly string[];
  created_at: number;
  updated_at: number;
}>;

export type FitnessProgramDay = Readonly<{
  id: string;
  program_id: string;
  day_index: number;
  weekday: number | null;
  kind: ProgramDayKind;
  name: string;
  focus: string;
  estimated_minutes: number;
  variant: "standard" | "short" | "low_fatigue" | "busy_gym";
  created_at: number;
}>;

export type FitnessProgramItem = Readonly<{
  id: string;
  program_day_id: string;
  exercise_id: string;
  equipment_id: string | null;
  resource_equipment_ids: readonly string[];
  order_index: number;
  sets: number;
  rep_min: number | null;
  rep_max: number | null;
  duration_seconds: number | null;
  target_rir: number | null;
  rest_seconds: number;
  load_grams: number | null;
  load_guidance: string;
  rationale: string;
  substitution_exercise_ids: readonly string[];
  equipment_snapshot: string;
  created_at: number;
}>;

export type CalendarEventStatus =
  | "planned"
  | "in_progress"
  | "completed"
  | "not_performed"
  | "cancelled";

export type FitnessCalendarEvent = Readonly<{
  id: string;
  program_day_id: string | null;
  venue_id: string | null;
  title: string;
  kind: ProgramDayKind | "note";
  starts_at: number;
  occurrence_key: string | null;
  planned_minutes: number;
  status: CalendarEventStatus;
  rescheduled_from_id: string | null;
  note: string;
  created_at: number;
  updated_at: number;
}>;

export type FitnessSession = Readonly<{
  id: string;
  event_id: string | null;
  venue_id: string;
  program_day_id: string | null;
  started_at: number;
  ended_at: number | null;
  status: "active" | "completed" | "ended_early";
  available_minutes: number | null;
  energy_note: "" | "lower" | "usual" | "higher";
  soreness_note: string;
  reflection: string;
  created_at: number;
  updated_at: number;
}>;

export type FitnessSessionExercise = Readonly<{
  id: string;
  session_id: string;
  exercise_id: string;
  equipment_id: string | null;
  planned_item_id: string | null;
  order_index: number;
  status: "pending" | "active" | "completed" | "skipped" | "substituted";
  substituted_for_exercise_id: string | null;
  substitution_reason: string;
  equipment_snapshot: string;
  note: string;
  created_at: number;
  updated_at: number;
}>;

export type FitnessSet = Readonly<{
  id: string;
  session_exercise_id: string;
  set_index: number;
  set_kind: "warmup" | "work" | "drop" | "amrap";
  load_grams: number | null;
  reps: number | null;
  duration_seconds: number | null;
  rir: number | null;
  rpe: number | null;
  completed: boolean;
  pain_note: string;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}>;

export type FitnessCardioEntry = Readonly<{
  id: string;
  session_id: string;
  equipment_id: string | null;
  mode: string;
  duration_seconds: number;
  distance_meters: number | null;
  resistance: string;
  average_heart_rate: number | null;
  effort: "easy" | "moderate" | "hard" | "";
  note: string;
  created_at: number;
}>;

export type FitnessCapability = Readonly<{
  id: string;
  exercise_id: string;
  equipment_id: string | null;
  source_set_id: string | null;
  load_grams: number | null;
  reps: number | null;
  rir: number | null;
  rpe: number | null;
  confidence: "observed" | "user_entered";
  recorded_at: number;
  created_at: number;
}>;

export type FitnessFile = Readonly<{
  id: string;
  entity_type: "venue" | "equipment" | "exercise" | "session";
  entity_id: string;
  purpose: "photo" | "instruction" | "other";
  file_key: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  status: "ready" | "missing" | "deleting";
  created_at: number;
  updated_at: number;
}>;

export type FitnessSettings = Readonly<{
  unit: "kg" | "lb";
  rest_timer_enabled: boolean;
  sound_enabled: boolean;
  ai_enabled: boolean;
}>;

export type FitnessSnapshot = Readonly<{
  profile: FitnessProfile | null;
  venues: readonly FitnessVenue[];
  equipment: readonly FitnessEquipment[];
  equipmentLoads: readonly FitnessEquipmentLoad[];
  constraints: readonly FitnessConstraint[];
  programs: readonly FitnessProgram[];
  programDays: readonly FitnessProgramDay[];
  programItems: readonly FitnessProgramItem[];
  events: readonly FitnessCalendarEvent[];
  sessions: readonly FitnessSession[];
  sessionExercises: readonly FitnessSessionExercise[];
  sets: readonly FitnessSet[];
  cardioEntries: readonly FitnessCardioEntry[];
  capabilities: readonly FitnessCapability[];
  files: readonly FitnessFile[];
  settings: FitnessSettings;
}>;

export type FitnessPlanDraft = Readonly<{
  name: string;
  venue_id: string;
  goal: FitnessGoal;
  split: FitnessSplit;
  assumptions: readonly string[];
  warnings: readonly string[];
  days: readonly Readonly<{
    weekday: number | null;
    kind: ProgramDayKind;
    name: string;
    focus: string;
    estimated_minutes: number;
    items: readonly Omit<FitnessProgramItem, "id" | "program_day_id" | "created_at">[];
  }>[];
}>;
