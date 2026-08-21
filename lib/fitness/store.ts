import { localDb } from "@/lib/local-db/client";
import type { SqlParams, SqlStatement } from "@/lib/local-db/types";
import {
  SHILIAN_APPLICATION_ID,
  SHILIAN_INDEXES,
  SHILIAN_OBJECT_SQL,
  SHILIAN_OCCURRENCE_KEY_SQL,
  SHILIAN_SCHEMA_STATEMENTS,
  SHILIAN_TABLE_COLUMNS,
  SHILIAN_TABLES,
  SHILIAN_USER_VERSION,
  SHILIAN_V1_INDEXES,
  SHILIAN_V1_MIGRATION_NAME,
  SHILIAN_V1_OBJECT_SQL,
  SHILIAN_V1_TABLE_COLUMNS,
  SHILIAN_V2_MIGRATION_NAME,
  SHILIAN_V2_SCHEMA_MIGRATION_STATEMENTS,
} from "@/lib/schemas/shilian";
import {
  equipmentSupportsExercise,
  getFitnessExercise,
  requiredEquipmentQuantity,
} from "./catalog";
import {
  broadcastFitnessChange,
  withFitnessReadLock,
  withFitnessWriteLock,
} from "./lock";
import type {
  FitnessCalendarEvent,
  FitnessCardioEntry,
  FitnessConstraint,
  FitnessEquipment,
  FitnessEquipmentLoad,
  FitnessExercise,
  FitnessFile,
  FitnessPlanDraft,
  FitnessProfile,
  FitnessProgram,
  FitnessProgramDay,
  FitnessProgramItem,
  FitnessSession,
  FitnessSessionExercise,
  FitnessSet,
  FitnessSettings,
  FitnessSnapshot,
  FitnessVenue,
  FitnessCapability,
} from "./types";

const DB = "fitness" as const;
export const FITNESS_APPLICATION_ID = SHILIAN_APPLICATION_ID;
export const FITNESS_USER_VERSION = SHILIAN_USER_VERSION;

const defaultSettings: FitnessSettings = {
  unit: "kg",
  rest_timer_enabled: true,
  sound_enabled: false,
  ai_enabled: true,
};
const FITNESS_GOALS = new Set([
  "strength",
  "muscle",
  "cardio",
  "general_health",
  "sport",
  "mobility",
]);
const MOVEMENT_PATTERNS = new Set([
  "squat",
  "hinge",
  "horizontal_push",
  "vertical_push",
  "horizontal_pull",
  "vertical_pull",
  "lunge",
  "carry",
  "core",
  "isolation",
  "cardio",
]);
const FITNESS_EQUIPMENT_KINDS = new Set([
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
]);

type Row = Record<string, unknown>;

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function requireNonEmpty(value: string, label: string, maximum = 160): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new TypeError(`${label}不能为空且不能超过 ${maximum} 个字符`);
  }
  return normalized;
}

function requireInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label}不在可接受范围`);
  }
  return value;
}

function requireUniqueStrings(values: readonly string[], label: string): void {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new TypeError(`${label}格式不正确`);
  }
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value, index) => !value || value !== values[index])) {
    throw new TypeError(`${label}包含空值或多余空白`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label}包含重复项`);
  }
}

function asBoolean(value: unknown) {
  return Number(value) === 1;
}

function parseArray<Value>(value: unknown): readonly Value[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as Value[] : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown): Readonly<Record<string, string | number | boolean>> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, string | number | boolean>
      : {};
  } catch {
    return {};
  }
}

async function rawQuery<Result extends object>(sql: string, params?: SqlParams) {
  return (await localDb.query<Result>(DB, sql, params)).rows;
}

async function rawBatch(statements: readonly SqlStatement[]) {
  return localDb.batch(DB, statements, { transaction: true });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizedSchemaSql(value: string): string {
  return value.trim().replace(/;$/, "").replace(/\s+/g, " ");
}

async function assertRuntimeContract(version: 1 | 2) {
  const identity = (await rawQuery<{ application_id: number; user_version: number }>(
    "SELECT (SELECT application_id FROM pragma_application_id) application_id, (SELECT user_version FROM pragma_user_version) user_version",
  ))[0];
  if (!identity) throw new Error("无法读取适练数据库身份");
  if (identity.application_id !== FITNESS_APPLICATION_ID || identity.user_version !== version) {
    throw new Error("适练数据库身份或版本不受支持；当前数据没有被改动");
  }
  const expectedIndexes = version === 1 ? SHILIAN_V1_INDEXES : SHILIAN_INDEXES;
  const expectedObjectSql = version === 1 ? SHILIAN_V1_OBJECT_SQL : SHILIAN_OBJECT_SQL;
  const expectedTableColumns: Readonly<Record<string, readonly string[]>> =
    version === 1 ? SHILIAN_V1_TABLE_COLUMNS : SHILIAN_TABLE_COLUMNS;
  const objects = await rawQuery<{ type: string; name: string; sql: string | null }>(
    `SELECT type,name,sql FROM sqlite_schema
      WHERE type IN ('table','index','view','trigger')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY type,name`,
  );
  const actualTables = objects.filter(({ type }) => type === "table").map(({ name }) => name);
  const actualIndexes = objects.filter(({ type }) => type === "index").map(({ name }) => name);
  const unsafeObjects = objects.filter(({ type }) => type === "view" || type === "trigger");
  if (
    !sameStrings(actualTables, [...SHILIAN_TABLES].sort()) ||
    !sameStrings(actualIndexes, [...expectedIndexes].sort()) ||
    unsafeObjects.length > 0
  ) {
    throw new Error("适练数据库结构与当前版本不一致；已停止打开以保护数据");
  }
  for (const object of objects) {
    const expected = expectedObjectSql[object.name];
    if (
      !expected || object.sql === null ||
      normalizedSchemaSql(object.sql) !== normalizedSchemaSql(expected)
    ) {
      throw new Error(`适练数据库对象 ${object.name} 的定义与当前版本不一致`);
    }
  }
  for (const table of SHILIAN_TABLES) {
    const escaped = table.replaceAll('"', '""');
    const columns = await rawQuery<{ name: string }>(`PRAGMA table_info("${escaped}")`);
    if (!sameStrings(columns.map(({ name }) => name), expectedTableColumns[table] ?? [])) {
      throw new Error(`适练数据库表 ${table} 的列结构不完整；已停止打开以保护数据`);
    }
  }
  const ledger = await rawQuery<{ version: number; name: string }>(
    "SELECT version,name FROM fitness_schema_migrations ORDER BY version",
  );
  const expectedLedger = version === 1
    ? [{ version: 1, name: SHILIAN_V1_MIGRATION_NAME }]
    : [
      { version: 1, name: SHILIAN_V1_MIGRATION_NAME },
      { version: 2, name: SHILIAN_V2_MIGRATION_NAME },
    ];
  if (ledger.length !== expectedLedger.length || ledger.some((entry, index) =>
    Number(entry.version) !== expectedLedger[index]?.version ||
    entry.name !== expectedLedger[index]?.name
  )) {
    throw new Error("适练数据库迁移记录不完整；已停止打开以保护数据");
  }
  const integrity = await rawQuery<{ integrity_check: string }>("PRAGMA integrity_check");
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("适练数据库完整性检查失败；已停止打开以保护数据");
  }
  if ((await rawQuery<Row>("PRAGMA foreign_key_check")).length > 0) {
    throw new Error("适练数据库存在断开的关联；已停止打开以保护数据");
  }
}

async function migrateFitnessV1ToV2(): Promise<void> {
  await assertRuntimeContract(1);
  const conflicts = await rawQuery<{ program_day_id: string; occurrence_key: string; count: number }>(
    `SELECT program_day_id,${SHILIAN_OCCURRENCE_KEY_SQL} occurrence_key,COUNT(*) count
      FROM fitness_calendar_events
      WHERE program_day_id IS NOT NULL
      GROUP BY program_day_id,${SHILIAN_OCCURRENCE_KEY_SQL}
      HAVING COUNT(*)>1
      ORDER BY program_day_id,occurrence_key
      LIMIT 1`,
  );
  if (conflicts.length > 0) {
    throw new Error("旧版日历中同一计划日存在重复日期；迁移已停止，原数据没有被改动");
  }
  const now = Date.now();
  await rawBatch([
    ...SHILIAN_V2_SCHEMA_MIGRATION_STATEMENTS,
    {
      sql: "INSERT INTO fitness_schema_migrations(version,name,applied_at) VALUES(?,?,?)",
      params: [2, SHILIAN_V2_MIGRATION_NAME, now],
    },
    { sql: `PRAGMA user_version=${FITNESS_USER_VERSION}` },
  ]);
}

export async function initializeFitnessDatabase(): Promise<void> {
  await withFitnessWriteLock(async () => {
    await localDb.init(DB);
    const identity = (await rawQuery<{ application_id: number; user_version: number }>(
      "SELECT (SELECT application_id FROM pragma_application_id) application_id, (SELECT user_version FROM pragma_user_version) user_version",
    ))[0];
    if (!identity) throw new Error("无法读取适练数据库身份");
    if (identity.application_id === 0 && identity.user_version === 0) {
      const existing = await rawQuery<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'",
      );
      if (existing.length) {
        throw new Error("发现无法确认来源的旧数据库；为保护数据，适练没有猜测式接管");
      }
      const now = Date.now();
      await rawBatch([
        ...SHILIAN_SCHEMA_STATEMENTS,
        {
          sql: "INSERT INTO fitness_schema_migrations(version,name,applied_at) VALUES(?,?,?)",
          params: [1, SHILIAN_V1_MIGRATION_NAME, now],
        },
        {
          sql: "INSERT INTO fitness_schema_migrations(version,name,applied_at) VALUES(?,?,?)",
          params: [2, SHILIAN_V2_MIGRATION_NAME, now],
        },
        { sql: `PRAGMA application_id=${FITNESS_APPLICATION_ID}` },
        { sql: `PRAGMA user_version=${FITNESS_USER_VERSION}` },
      ]);
    } else if (
      identity.application_id === FITNESS_APPLICATION_ID &&
      identity.user_version === 1
    ) {
      await migrateFitnessV1ToV2();
    } else if (
      identity.application_id !== FITNESS_APPLICATION_ID ||
      identity.user_version !== FITNESS_USER_VERSION
    ) {
      throw new Error("适练数据库身份或版本不受支持；当前数据没有被改动");
    }
    await assertRuntimeContract(2);
  });
}

function mapProfile(row: Row | undefined): FitnessProfile | null {
  if (!row) return null;
  const { goals_json: goalsJson, preferred_weekdays_json: weekdaysJson, ...profile } = row;
  return {
    ...profile,
    id: "profile",
    goals: parseArray<FitnessProfile["goals"][number]>(goalsJson),
    preferred_weekdays: parseArray<number>(weekdaysJson),
  } as unknown as FitnessProfile;
}

function mapVenue(row: Row): FitnessVenue {
  return {
    ...row,
    supersets_allowed: asBoolean(row.supersets_allowed),
    is_default: asBoolean(row.is_default),
  } as unknown as FitnessVenue;
}

function mapEquipment(row: Row): FitnessEquipment {
  const { settings_json: settingsJson, attachments_json: attachmentsJson, ...equipment } = row;
  return {
    ...equipment,
    unilateral: asBoolean(row.unilateral),
    settings: parseObject(settingsJson),
    attachments: parseArray<string>(attachmentsJson),
  } as unknown as FitnessEquipment;
}

function mapEquipmentLoad(row: Row): FitnessEquipmentLoad {
  return { ...row, available: asBoolean(row.available) } as unknown as FitnessEquipmentLoad;
}

function mapConstraint(row: Row): FitnessConstraint {
  const {
    movement_patterns_json: movementPatternsJson,
    exercise_ids_json: exerciseIdsJson,
    ...constraint
  } = row;
  return {
    ...constraint,
    movement_patterns: parseArray<FitnessConstraint["movement_patterns"][number]>(movementPatternsJson),
    exercise_ids: parseArray<string>(exerciseIdsJson),
    active: asBoolean(row.active),
  } as unknown as FitnessConstraint;
}

function exerciseIsAvoided(
  exercise: FitnessExercise,
  constraints: readonly FitnessConstraint[],
): boolean {
  return constraints.some((constraint) =>
    constraint.active && constraint.severity === "avoid" &&
    (constraint.exercise_ids.includes(exercise.id) ||
      constraint.movement_patterns.includes(exercise.pattern))
  );
}

async function loadActiveAvoidConstraints(): Promise<FitnessConstraint[]> {
  return (await rawQuery<Row>(
    "SELECT * FROM fitness_constraints WHERE active=1 AND severity='avoid'",
  )).map(mapConstraint);
}

async function assertExerciseIsAllowed(exercise: FitnessExercise): Promise<void> {
  const constraints = await loadActiveAvoidConstraints();
  if (exerciseIsAvoided(exercise, constraints)) {
    throw new Error(`动作「${exercise.name_zh}」与当前避用限制冲突`);
  }
}

function mapProgram(row: Row): FitnessProgram {
  const { assumptions_json: assumptionsJson, ...program } = row;
  return { ...program, assumptions: parseArray<string>(assumptionsJson) } as unknown as FitnessProgram;
}

function mapProgramItem(row: Row): FitnessProgramItem {
  const {
    resource_equipment_ids_json: resourceIdsJson,
    substitution_exercise_ids_json: substitutionIdsJson,
    ...item
  } = row;
  return {
    ...item,
    resource_equipment_ids: parseArray<string>(resourceIdsJson),
    substitution_exercise_ids: parseArray<string>(substitutionIdsJson),
  } as unknown as FitnessProgramItem;
}

function settingsFromRows(rows: readonly { key: string; value: string }[]): FitnessSettings {
  const values: Record<string, string> = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    unit: values.unit === "lb" ? "lb" : defaultSettings.unit,
    rest_timer_enabled: values.rest_timer_enabled === undefined
      ? defaultSettings.rest_timer_enabled
      : values.rest_timer_enabled !== "false",
    sound_enabled: values.sound_enabled === undefined
      ? defaultSettings.sound_enabled
      : values.sound_enabled === "true",
    ai_enabled: values.ai_enabled === undefined
      ? defaultSettings.ai_enabled
      : values.ai_enabled !== "false",
  };
}

export async function loadFitnessSnapshot(): Promise<FitnessSnapshot> {
  return withFitnessReadLock(async () => {
    const [profileRows, venues, equipment, equipmentLoads, constraints, programs, programDays, programItems, events, sessions, sessionExercises, sets, cardioEntries, capabilities, files, settings] = await Promise.all([
      rawQuery<Row>("SELECT * FROM fitness_profiles WHERE id='profile'"),
      rawQuery<Row>("SELECT * FROM fitness_venues ORDER BY is_default DESC,updated_at DESC"),
      rawQuery<Row>("SELECT * FROM fitness_equipment ORDER BY venue_id,status,name"),
      rawQuery<Row>("SELECT * FROM fitness_equipment_loads ORDER BY equipment_id,load_grams"),
      rawQuery<Row>("SELECT * FROM fitness_constraints ORDER BY active DESC,updated_at DESC"),
      rawQuery<Row>("SELECT * FROM fitness_programs ORDER BY status='active' DESC,updated_at DESC"),
      rawQuery<FitnessProgramDay>("SELECT * FROM fitness_program_days ORDER BY program_id,day_index"),
      rawQuery<Row>("SELECT * FROM fitness_program_items ORDER BY program_day_id,order_index"),
      rawQuery<FitnessCalendarEvent>("SELECT * FROM fitness_calendar_events ORDER BY starts_at"),
      rawQuery<FitnessSession>("SELECT * FROM fitness_sessions ORDER BY started_at DESC"),
      rawQuery<FitnessSessionExercise>("SELECT * FROM fitness_session_exercises ORDER BY session_id,order_index"),
      rawQuery<Row>("SELECT id,session_exercise_id,set_index,set_kind,load_grams,reps,duration_seconds,rir,rpe,completed,pain_note,completed_at,created_at,updated_at FROM fitness_sets ORDER BY session_exercise_id,set_index"),
      rawQuery<FitnessCardioEntry>("SELECT * FROM fitness_cardio_entries ORDER BY created_at DESC"),
      rawQuery<FitnessCapability>("SELECT * FROM fitness_capabilities ORDER BY recorded_at DESC"),
      rawQuery<FitnessFile>("SELECT * FROM fitness_files ORDER BY updated_at DESC"),
      rawQuery<{ key: string; value: string }>("SELECT key,value FROM fitness_settings"),
    ]);
    return {
      profile: mapProfile(profileRows[0]),
      venues: venues.map(mapVenue),
      equipment: equipment.map(mapEquipment),
      equipmentLoads: equipmentLoads.map(mapEquipmentLoad),
      constraints: constraints.map(mapConstraint),
      programs: programs.map(mapProgram),
      programDays,
      programItems: programItems.map(mapProgramItem),
      events,
      sessions,
      sessionExercises,
      sets: sets.map((row) => ({ ...row, completed: asBoolean(row.completed) } as unknown as FitnessSet)),
      cardioEntries,
      capabilities,
      files,
      settings: settingsFromRows(settings),
    };
  });
}

async function write<Result>(reason: string, operation: () => Promise<Result>) {
  return withFitnessWriteLock(async () => {
    const result = await operation();
    try {
      broadcastFitnessChange(reason);
    } catch {
      // Cross-view refresh is advisory; it cannot reverse a durable commit.
    }
    return result;
  });
}

export type SaveFitnessProfileInput = Omit<FitnessProfile, "id" | "created_at" | "updated_at">;

export async function saveFitnessProfile(input: SaveFitnessProfileInput) {
  return write("profile-saved", async () => {
    requireUniqueStrings(input.goals, "训练目标");
    if (input.goals.length === 0 || input.goals.some((goal) => !FITNESS_GOALS.has(goal))) {
      throw new TypeError("请选择至少一个可识别的训练目标");
    }
    requireInteger(input.resistance_days_per_week, "每周无氧次数", 0, 7);
    requireInteger(input.cardio_days_per_week, "每周有氧次数", 0, 7);
    requireInteger(input.session_minutes, "单次训练时长", 10, 240);
    requireInteger(input.preferred_rir, "目标 RIR", 0, 5);
    requireInteger(input.rest_seconds, "组间休息", 15, 600);
    const weekdays = [...input.preferred_weekdays];
    if (
      new Set(weekdays).size !== weekdays.length ||
      weekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 0 || weekday > 6)
    ) {
      throw new TypeError("常用训练日必须是互不重复的星期值");
    }
    const now = Date.now();
    await rawBatch([{
      sql: `INSERT INTO fitness_profiles(
        id,goals_json,experience,resistance_days_per_week,cardio_days_per_week,
        session_minutes,split,preferred_weekdays_json,preferred_rir,rest_seconds,
        unit,notes,created_at,updated_at
      ) VALUES('profile',?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        goals_json=excluded.goals_json,experience=excluded.experience,
        resistance_days_per_week=excluded.resistance_days_per_week,
        cardio_days_per_week=excluded.cardio_days_per_week,
        session_minutes=excluded.session_minutes,split=excluded.split,
        preferred_weekdays_json=excluded.preferred_weekdays_json,
        preferred_rir=excluded.preferred_rir,rest_seconds=excluded.rest_seconds,
        unit=excluded.unit,notes=excluded.notes,updated_at=excluded.updated_at`,
      params: [
        JSON.stringify(input.goals), input.experience, input.resistance_days_per_week,
        input.cardio_days_per_week, input.session_minutes, input.split,
        JSON.stringify(input.preferred_weekdays), input.preferred_rir,
        input.rest_seconds, input.unit, input.notes.trim(), now, now,
      ],
    }]);
  });
}

export type SaveVenueInput = Omit<FitnessVenue, "id" | "created_at" | "updated_at"> & { id?: string };

export async function saveVenue(input: SaveVenueInput): Promise<string> {
  return write("venue-saved", async () => {
    const id = input.id ?? uid("venue");
    const name = requireNonEmpty(input.name, "场地名称", 120);
    requireInteger(input.default_session_minutes, "场地默认训练时长", 10, 240);
    const now = Date.now();
    const statements: SqlStatement[] = [];
    if (input.is_default) {
      statements.push({ sql: "UPDATE fitness_venues SET is_default=0,updated_at=?", params: [now] });
    }
    statements.push({
      sql: `INSERT INTO fitness_venues(
        id,name,venue_type,location,area_notes,busy_notes,default_session_minutes,
        supersets_allowed,is_default,status,last_verified_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,venue_type=excluded.venue_type,
        location=excluded.location,area_notes=excluded.area_notes,busy_notes=excluded.busy_notes,
        default_session_minutes=excluded.default_session_minutes,
        supersets_allowed=excluded.supersets_allowed,is_default=excluded.is_default,
        status=excluded.status,last_verified_at=excluded.last_verified_at,updated_at=excluded.updated_at`,
      params: [id, name, input.venue_type, input.location.trim(), input.area_notes.trim(), input.busy_notes.trim(), input.default_session_minutes, Number(input.supersets_allowed), Number(input.is_default), input.status, input.last_verified_at, now, now],
    });
    await rawBatch(statements);
    return id;
  });
}

export async function archiveVenue(id: string) {
  return write("venue-archived", async () => {
    const venue = (await rawQuery<{ id: string }>(
      "SELECT id FROM fitness_venues WHERE id=? AND status='active'",
      [id],
    ))[0];
    if (!venue) throw new Error("只能归档当前可用的场地");
    const activeSession = (await rawQuery<{ id: string }>(
      "SELECT id FROM fitness_sessions WHERE venue_id=? AND status='active' LIMIT 1",
      [id],
    ))[0];
    if (activeSession) throw new Error("请先结束这个场地中正在进行的训练");
    const now = Date.now();
    await rawBatch([
      {
        sql: "UPDATE fitness_venues SET status='archived',is_default=0,updated_at=? WHERE id=?",
        params: [now, id],
      },
      {
        sql: "UPDATE fitness_programs SET status='archived',updated_at=? WHERE venue_id=? AND status IN ('active','draft')",
        params: [now, id],
      },
      {
        sql: `UPDATE fitness_calendar_events
          SET status='cancelled',updated_at=?
          WHERE venue_id=? AND status='planned'`,
        params: [now, id],
      },
    ]);
  });
}

export async function restoreVenue(id: string) {
  return write("venue-restored", async () => {
    const venue = (await rawQuery<{ status: FitnessVenue["status"] }>(
      "SELECT status FROM fitness_venues WHERE id=?",
      [id],
    ))[0];
    if (!venue) throw new Error("场地不存在");
    if (venue.status !== "archived") throw new Error("只能恢复已归档的场地");
    await rawBatch([{
      sql: "UPDATE fitness_venues SET status='active',updated_at=? WHERE id=? AND status='archived'",
      params: [Date.now(), id],
    }]);
  });
}

export type SaveEquipmentInput = Omit<FitnessEquipment, "id" | "created_at" | "updated_at"> & {
  id?: string;
  loads: readonly Omit<FitnessEquipmentLoad, "id" | "equipment_id" | "created_at">[];
};

export async function saveEquipmentWithLoads(input: SaveEquipmentInput): Promise<string> {
  return write("equipment-saved", async () => {
    const id = input.id ?? uid("equipment");
    const name = requireNonEmpty(input.name, "器材名称");
    requireInteger(input.quantity, "器材数量", 1, 1000);
    const venue = (await rawQuery<{ status: string }>(
      "SELECT status FROM fitness_venues WHERE id=?",
      [input.venue_id],
    ))[0];
    if (!venue || venue.status !== "active") throw new Error("只能向可用场地保存器材");
    if (input.min_load_grams !== null) {
      requireInteger(input.min_load_grams, "器材最低重量", 0, 10_000_000);
    }
    if (input.max_load_grams !== null) {
      requireInteger(input.max_load_grams, "器材最高重量", 0, 10_000_000);
    }
    if (input.increment_grams !== null) {
      requireInteger(input.increment_grams, "器材重量增量", 1, 10_000_000);
    }
    if (input.bar_weight_grams !== null) {
      requireInteger(input.bar_weight_grams, "空杆重量", 0, 10_000_000);
    }
    if (
      input.min_load_grams !== null && input.max_load_grams !== null &&
      input.max_load_grams < input.min_load_grams
    ) {
      throw new TypeError("器材重量范围前后颠倒");
    }
    if (input.load_mode !== "discrete" && input.loads.length > 0) {
      throw new TypeError("只有离散档位器材可以录入重量阶梯");
    }
    requireUniqueStrings(input.attachments, "器材附件");
    const now = Date.now();
    const loadKeys = new Set<string>();
    const loads = [...input.loads].map((load) => {
      requireInteger(load.load_grams, "器材重量", 0, 10_000_000);
      requireInteger(load.quantity, "该档位数量", 1, 1000);
      const label = requireNonEmpty(load.label, "重量档位名称", 120);
      if (
        (input.min_load_grams !== null && load.load_grams < input.min_load_grams) ||
        (input.max_load_grams !== null && load.load_grams > input.max_load_grams)
      ) {
        throw new TypeError("器材档位超出已记录的重量范围");
      }
      const key = `${load.load_grams}\u0000${label}`;
      if (loadKeys.has(key)) throw new TypeError("器材重量档位不能重复");
      loadKeys.add(key);
      return { ...load, label };
    }).sort((left, right) => left.load_grams - right.load_grams || left.label.localeCompare(right.label));
    const statements: SqlStatement[] = [{
      sql: `INSERT INTO fitness_equipment(
        id,venue_id,name,kind,area,quantity,status,load_mode,load_semantics,
        min_load_grams,max_load_grams,increment_grams,bar_weight_grams,unilateral,
        busy_level,settings_json,attachments_json,notes,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET venue_id=excluded.venue_id,name=excluded.name,
        kind=excluded.kind,area=excluded.area,quantity=excluded.quantity,status=excluded.status,
        load_mode=excluded.load_mode,load_semantics=excluded.load_semantics,
        min_load_grams=excluded.min_load_grams,max_load_grams=excluded.max_load_grams,
        increment_grams=excluded.increment_grams,bar_weight_grams=excluded.bar_weight_grams,
        unilateral=excluded.unilateral,busy_level=excluded.busy_level,
        settings_json=excluded.settings_json,attachments_json=excluded.attachments_json,
        notes=excluded.notes,updated_at=excluded.updated_at`,
      params: [id, input.venue_id, name, input.kind, input.area.trim(), input.quantity, input.status, input.load_mode, input.load_semantics, input.min_load_grams, input.max_load_grams, input.increment_grams, input.bar_weight_grams, Number(input.unilateral), input.busy_level, JSON.stringify(input.settings), JSON.stringify(input.attachments), input.notes.trim(), now, now],
    }, { sql: "DELETE FROM fitness_equipment_loads WHERE equipment_id=?", params: [id] }];
    loads.forEach((load) => statements.push({
      sql: "INSERT INTO fitness_equipment_loads(id,equipment_id,load_grams,quantity,label,available,created_at) VALUES(?,?,?,?,?,?,?)",
      params: [uid("load"), id, load.load_grams, load.quantity, load.label, Number(load.available), now],
    }));
    await rawBatch(statements);
    return id;
  });
}

export async function setEquipmentStatus(id: string, status: FitnessEquipment["status"]) {
  return write("equipment-status", async () => {
    const present = (await rawQuery<{ id: string }>(
      "SELECT id FROM fitness_equipment WHERE id=?",
      [id],
    ))[0];
    if (!present) throw new Error("器材不存在");
    await rawBatch([{ sql: "UPDATE fitness_equipment SET status=?,updated_at=? WHERE id=?", params: [status, Date.now(), id] }]);
  });
}

export type SaveConstraintInput = Omit<FitnessConstraint, "id" | "created_at" | "updated_at"> & { id?: string };

export async function saveConstraint(input: SaveConstraintInput): Promise<string> {
  return write("constraint-saved", async () => {
    const id = input.id ?? uid("constraint");
    const label = requireNonEmpty(input.label, "身体限制名称");
    requireUniqueStrings(input.movement_patterns, "受影响动作模式");
    requireUniqueStrings(input.exercise_ids, "受影响动作");
    if (
      input.active &&
      input.movement_patterns.length === 0 &&
      input.exercise_ids.length === 0
    ) {
      throw new TypeError("启用的身体边界必须至少包含一个受影响的动作模式或动作");
    }
    if (input.movement_patterns.some((pattern) => !MOVEMENT_PATTERNS.has(pattern))) {
      throw new TypeError("身体限制包含未知的动作模式");
    }
    if (input.exercise_ids.some((exerciseId) => !getFitnessExercise(exerciseId))) {
      throw new TypeError("身体限制包含未知动作");
    }
    const now = Date.now();
    await rawBatch([{
      sql: `INSERT INTO fitness_constraints(
        id,label,body_area,severity,movement_patterns_json,exercise_ids_json,
        note,active,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label,body_area=excluded.body_area,
        severity=excluded.severity,movement_patterns_json=excluded.movement_patterns_json,
        exercise_ids_json=excluded.exercise_ids_json,note=excluded.note,
        active=excluded.active,updated_at=excluded.updated_at`,
      params: [id, label, input.body_area.trim(), input.severity, JSON.stringify(input.movement_patterns), JSON.stringify(input.exercise_ids), input.note.trim(), Number(input.active), now, now],
    }]);
    return id;
  });
}

export async function setFitnessConstraintActive(
  constraintId: string,
  active: boolean,
): Promise<void> {
  return write(active ? "constraint-activated" : "constraint-deactivated", async () => {
    const id = requireNonEmpty(constraintId, "身体边界标识");
    if (typeof active !== "boolean") throw new TypeError("身体边界状态必须是布尔值");
    const constraint = (await rawQuery<{
      active: number;
      movement_patterns_json: string;
      exercise_ids_json: string;
    }>(
      `SELECT active,movement_patterns_json,exercise_ids_json
        FROM fitness_constraints WHERE id=?`,
      [id],
    ))[0];
    if (!constraint) throw new Error("身体边界不存在");
    const current = asBoolean(constraint.active);
    if (current === active) {
      throw new Error(active ? "身体边界已经处于启用状态" : "身体边界已经处于暂停状态");
    }
    if (
      active &&
      parseArray(constraint.movement_patterns_json).length === 0 &&
      parseArray(constraint.exercise_ids_json).length === 0
    ) {
      throw new Error("这条身体边界没有受影响范围，补充范围后才能启用");
    }
    await rawBatch([{
      sql: "UPDATE fitness_constraints SET active=?,updated_at=? WHERE id=? AND active=?",
      params: [Number(active), Date.now(), id, Number(current)],
    }]);
  });
}

type FitnessConfigTransition = Readonly<{
  id: string;
  status: string;
  updated_at: number;
}>;

export type FitnessEquipmentWriteSnapshot = Readonly<{
  equipment: FitnessEquipment;
  loads: readonly FitnessEquipmentLoad[];
}>;

type FitnessConfigReceiptBase<Kind extends string> = Readonly<{
  purpose: "fitness-config-write";
  version: 1;
  operationId: string;
  generationId: string;
  generationSequence: number;
  kind: Kind;
  projectionSha256: string;
}>;

export type FitnessProfileSaveReceipt = FitnessConfigReceiptBase<"profile-save"> & Readonly<{
  before: FitnessProfile | null;
  after: FitnessProfile;
}>;

export type FitnessVenueSaveReceipt = FitnessConfigReceiptBase<"venue-save"> & Readonly<{
  before: FitnessVenue | null;
  after: FitnessVenue;
  defaultResets: readonly Readonly<{ before: FitnessVenue; after: FitnessVenue }>[];
}>;

export type FitnessVenueArchiveReceipt = FitnessConfigReceiptBase<"venue-archive"> & Readonly<{
  before: FitnessVenue;
  after: FitnessVenue;
  programs: readonly Readonly<{
    before: FitnessConfigTransition;
    after: FitnessConfigTransition;
  }>[];
  events: readonly Readonly<{
    before: FitnessConfigTransition;
    after: FitnessConfigTransition;
  }>[];
}>;

export type FitnessVenueRestoreReceipt = FitnessConfigReceiptBase<"venue-restore"> & Readonly<{
  before: FitnessVenue;
  after: FitnessVenue;
}>;

export type FitnessEquipmentSaveReceipt = FitnessConfigReceiptBase<"equipment-save"> & Readonly<{
  before: FitnessEquipmentWriteSnapshot | null;
  after: FitnessEquipmentWriteSnapshot;
  venue: Readonly<{ id: string; status: "active"; updated_at: number }>;
}>;

export type FitnessEquipmentStatusReceipt = FitnessConfigReceiptBase<"equipment-status"> & Readonly<{
  before: FitnessEquipment;
  after: FitnessEquipment;
}>;

export type FitnessConstraintSaveReceipt = FitnessConfigReceiptBase<"constraint-save"> & Readonly<{
  before: FitnessConstraint | null;
  after: FitnessConstraint;
}>;

export type FitnessConstraintActiveReceipt = FitnessConfigReceiptBase<"constraint-active"> & Readonly<{
  before: FitnessConstraint;
  after: FitnessConstraint;
}>;

export type FitnessConfigWriteReceipt =
  | FitnessProfileSaveReceipt
  | FitnessVenueSaveReceipt
  | FitnessVenueArchiveReceipt
  | FitnessVenueRestoreReceipt
  | FitnessEquipmentSaveReceipt
  | FitnessEquipmentStatusReceipt
  | FitnessConstraintSaveReceipt
  | FitnessConstraintActiveReceipt;

export type FitnessConfigWriteInspection =
  | "exact_saved"
  | "expected"
  | "changed"
  | "still_unknown"
  | "invalid_receipt";

export type FitnessConfigWriteResult =
  | Readonly<{
      outcome: "saved" | "already_saved";
      receipt: FitnessConfigWriteReceipt;
      entityId: string;
      updatedAt: number;
    }>
  | Readonly<{
      outcome: "changed";
      receipt: FitnessConfigWriteReceipt;
      entityId: string;
      retryable: false;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      receipt: FitnessConfigWriteReceipt;
      entityId: string;
      retryable: true;
    }>;

export type FitnessConfigMutationErrorCode =
  | "invalid_input"
  | "invalid_receipt"
  | "conflict"
  | "changed"
  | "inspect_failed"
  | "write_failed";

export class FitnessConfigMutationError extends Error {
  readonly name = "FitnessConfigMutationError";

  constructor(
    readonly code: FitnessConfigMutationErrorCode,
    message: string,
    readonly receipt?: FitnessConfigWriteReceipt,
  ) {
    super(message);
  }
}

type FitnessConfigQueryResult<Result extends object> = Readonly<{
  rows: readonly Result[];
}>;

export type FitnessConfigStorageRuntime = Readonly<{
  withExclusiveLock<Result>(operation: () => Promise<Result>): Promise<Result>;
  query<Result extends object>(
    sql: string,
    params?: SqlParams,
  ): Promise<FitnessConfigQueryResult<Result>>;
  batch(statements: readonly SqlStatement[]): Promise<Readonly<{ changes: number }>>;
  currentGeneration(): Promise<Readonly<{ generationId: string; sequence: number }>>;
  now(): number;
  randomUUID(): string;
  broadcast(reason: string): void;
}>;

export type SaveFitnessEquipmentSafelyInput = Omit<
  SaveEquipmentInput,
  "id" | "loads"
> & Readonly<{
  loads: readonly Omit<FitnessEquipmentLoad, "id" | "equipment_id" | "created_at">[];
}>;

const CONFIG_OPERATION_ID_PATTERN =
  /^fitness-operation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIG_HASH_PATTERN = /^[0-9a-f]{64}$/;
const CONFIG_MAX_ATOMIC_ROWS = 500;
const CONFIG_GENERATION_ID_PATTERN =
  /^(?:legacy|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const CONFIG_ID_PATTERN =
  /^(venue|equipment|constraint|load)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configError(
  code: FitnessConfigMutationErrorCode,
  message: string,
  receipt?: FitnessConfigWriteReceipt,
): FitnessConfigMutationError {
  return new FitnessConfigMutationError(code, message, receipt);
}

function exactObjectKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function safeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function safeOpaqueId(value: unknown): value is string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 512 ||
    value.trim().length === 0 || Array.from(value).length > 256
  ) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function safeString(value: unknown, maximum = 100_000): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function safeStringArray(value: unknown, maximum = 10_000): value is readonly string[] {
  return Array.isArray(value) && value.length <= maximum &&
    value.every((entry) => safeString(entry, 10_000));
}

function uniqueExactStrings(value: readonly string[]): boolean {
  return new Set(value).size === value.length &&
    value.every((entry) => entry.length > 0 && entry === entry.trim());
}

function generatedIdMatches(value: string, prefix: "venue" | "equipment" | "constraint" | "load") {
  return value.startsWith(`${prefix}-`) && CONFIG_ID_PATTERN.test(value);
}

function safePrimitiveObject(
  value: unknown,
): value is Readonly<Record<string, string | number | boolean>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as object).length <= 100 &&
    Object.entries(value as Record<string, unknown>).every(([key, entry]) =>
      key.length <= 256 && (
        (typeof entry === "string" && entry.length <= 10_000) || typeof entry === "boolean" ||
        (typeof entry === "number" && Number.isFinite(entry))
      )
    );
}

function isFitnessProfileRow(value: unknown): value is FitnessProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FitnessProfile>;
  return exactObjectKeys(value, [
    "id", "goals", "experience", "resistance_days_per_week",
    "cardio_days_per_week", "session_minutes", "split", "preferred_weekdays",
    "preferred_rir", "rest_seconds", "unit", "notes", "created_at", "updated_at",
  ]) && row.id === "profile" && safeStringArray(row.goals, 20) &&
    row.goals.length > 0 && uniqueExactStrings(row.goals) &&
    row.goals.every((goal) => FITNESS_GOALS.has(goal)) &&
    ["new", "returning", "consistent", "advanced"].includes(String(row.experience)) &&
    typeof row.resistance_days_per_week === "number" &&
    Number.isSafeInteger(row.resistance_days_per_week) && row.resistance_days_per_week >= 0 &&
    row.resistance_days_per_week <= 7 && Number.isSafeInteger(row.cardio_days_per_week) &&
    typeof row.cardio_days_per_week === "number" && row.cardio_days_per_week >= 0 &&
    row.cardio_days_per_week <= 7 && typeof row.session_minutes === "number" &&
    Number.isSafeInteger(row.session_minutes) && row.session_minutes >= 10 &&
    row.session_minutes <= 240 &&
    ["auto", "full_body", "upper_lower", "push_pull_legs", "custom"].includes(String(row.split)) &&
    Array.isArray(row.preferred_weekdays) && row.preferred_weekdays.length <= 7 &&
    row.preferred_weekdays.every((day) => Number.isSafeInteger(day) && day >= 0 && day <= 6) &&
    new Set(row.preferred_weekdays).size === row.preferred_weekdays.length &&
    typeof row.preferred_rir === "number" && Number.isSafeInteger(row.preferred_rir) &&
    row.preferred_rir >= 0 && row.preferred_rir <= 5 &&
    typeof row.rest_seconds === "number" && Number.isSafeInteger(row.rest_seconds) &&
    row.rest_seconds >= 15 && row.rest_seconds <= 600 &&
    (row.unit === "kg" || row.unit === "lb") && safeString(row.notes) &&
    safeTimestamp(row.created_at) && safeTimestamp(row.updated_at) &&
    row.updated_at >= row.created_at;
}

function isFitnessVenueRow(value: unknown): value is FitnessVenue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FitnessVenue>;
  return exactObjectKeys(value, [
    "id", "name", "venue_type", "location", "area_notes", "busy_notes",
    "default_session_minutes", "supersets_allowed", "is_default", "status",
    "last_verified_at", "created_at", "updated_at",
  ]) && safeOpaqueId(row.id) && safeString(row.name, 120) && row.name.length > 0 &&
    ["commercial", "home", "office", "hotel", "outdoor", "other"].includes(String(row.venue_type)) &&
    safeString(row.location) && safeString(row.area_notes) && safeString(row.busy_notes) &&
    typeof row.default_session_minutes === "number" &&
    Number.isSafeInteger(row.default_session_minutes) && row.default_session_minutes >= 10 &&
    row.default_session_minutes <= 240 &&
    typeof row.supersets_allowed === "boolean" && typeof row.is_default === "boolean" &&
    (row.status === "active" || row.status === "archived") &&
    (row.last_verified_at === null || safeTimestamp(row.last_verified_at)) &&
    safeTimestamp(row.created_at) && safeTimestamp(row.updated_at) &&
    row.updated_at >= row.created_at;
}

function isFitnessEquipmentRow(value: unknown): value is FitnessEquipment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FitnessEquipment>;
  return exactObjectKeys(value, [
    "id", "venue_id", "name", "kind", "area", "quantity", "status", "load_mode",
    "load_semantics", "min_load_grams", "max_load_grams", "increment_grams",
    "bar_weight_grams", "unilateral", "busy_level", "settings", "attachments",
    "notes", "created_at", "updated_at",
  ]) && safeOpaqueId(row.id) && safeOpaqueId(row.venue_id) && safeString(row.name, 160) &&
    row.name.length > 0 && safeString(row.area) && typeof row.quantity === "number" &&
    Number.isSafeInteger(row.quantity) &&
    row.quantity >= 1 && row.quantity <= 1_000 &&
    FITNESS_EQUIPMENT_KINDS.has(String(row.kind)) &&
    ["available", "limited", "maintenance", "removed"].includes(String(row.status)) &&
    ["none", "discrete", "range", "plate_loaded"].includes(String(row.load_mode)) &&
    ["total", "per_hand", "per_side", "stack_label", "resistance_level"].includes(String(row.load_semantics)) &&
    [row.min_load_grams, row.max_load_grams, row.bar_weight_grams]
      .every((entry) => entry === null || (
        Number.isSafeInteger(entry) && Number(entry) >= 0 && Number(entry) <= 10_000_000
    )) && (row.increment_grams === null || (
        typeof row.increment_grams === "number" && Number.isSafeInteger(row.increment_grams) &&
        row.increment_grams >= 1 &&
        row.increment_grams <= 10_000_000
      )) && (row.min_load_grams === null || row.max_load_grams === null ||
        (typeof row.min_load_grams === "number" && typeof row.max_load_grams === "number" &&
        row.max_load_grams >= row.min_load_grams)) &&
    typeof row.unilateral === "boolean" &&
    ["unknown", "low", "medium", "high"].includes(String(row.busy_level)) &&
    safePrimitiveObject(row.settings) && safeStringArray(row.attachments, 100) &&
    uniqueExactStrings(row.attachments) &&
    safeString(row.notes) && safeTimestamp(row.created_at) && safeTimestamp(row.updated_at) &&
    row.updated_at >= row.created_at;
}

function isFitnessEquipmentLoadRow(value: unknown): value is FitnessEquipmentLoad {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FitnessEquipmentLoad>;
  return exactObjectKeys(value, [
    "id", "equipment_id", "load_grams", "quantity", "label", "available", "created_at",
  ]) && safeOpaqueId(row.id) && safeOpaqueId(row.equipment_id) &&
    Number.isSafeInteger(row.load_grams) && Number(row.load_grams) >= 0 &&
    Number(row.load_grams) <= 10_000_000 && Number.isSafeInteger(row.quantity) &&
    Number(row.quantity) >= 1 && Number(row.quantity) <= 1_000 &&
    safeString(row.label, 120) && row.label.length > 0 &&
    row.label === row.label.trim() && typeof row.available === "boolean" &&
    safeTimestamp(row.created_at);
}

function isEquipmentSnapshot(value: unknown): value is FitnessEquipmentWriteSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<FitnessEquipmentWriteSnapshot>;
  return exactObjectKeys(value, ["equipment", "loads"]) &&
    isFitnessEquipmentRow(snapshot.equipment) && Array.isArray(snapshot.loads) &&
    snapshot.loads.length <= CONFIG_MAX_ATOMIC_ROWS &&
    snapshot.loads.every((load) =>
      isFitnessEquipmentLoadRow(load) && load.equipment_id === snapshot.equipment?.id
    ) && new Set(snapshot.loads.map(({ id }) => id)).size === snapshot.loads.length &&
    new Set(snapshot.loads.map(({ load_grams, label }) => `${load_grams}\u0000${label}`)).size ===
      snapshot.loads.length &&
    (snapshot.equipment.load_mode === "discrete" || snapshot.loads.length === 0) &&
    snapshot.loads.every(({ load_grams }) =>
      (snapshot.equipment!.min_load_grams === null ||
        load_grams >= snapshot.equipment!.min_load_grams) &&
      (snapshot.equipment!.max_load_grams === null ||
        load_grams <= snapshot.equipment!.max_load_grams)
    );
}

function isFitnessConstraintRow(value: unknown): value is FitnessConstraint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FitnessConstraint>;
  return exactObjectKeys(value, [
    "id", "label", "body_area", "severity", "movement_patterns", "exercise_ids",
    "note", "active", "created_at", "updated_at",
  ]) && safeOpaqueId(row.id) && safeString(row.label, 160) && row.label.length > 0 &&
    safeString(row.body_area) && ["monitor", "modify", "avoid"].includes(String(row.severity)) &&
    safeStringArray(row.movement_patterns, 20) && uniqueExactStrings(row.movement_patterns) &&
    row.movement_patterns.every((pattern) => MOVEMENT_PATTERNS.has(pattern)) &&
    safeStringArray(row.exercise_ids, 10_000) && uniqueExactStrings(row.exercise_ids) &&
    row.exercise_ids.every((id) => Boolean(getFitnessExercise(id))) && safeString(row.note) &&
    typeof row.active === "boolean" && safeTimestamp(row.created_at) &&
    safeTimestamp(row.updated_at) && row.updated_at >= row.created_at &&
    (!row.active || row.movement_patterns.length > 0 || row.exercise_ids.length > 0);
}

function isTransition(value: unknown): value is FitnessConfigTransition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const transition = value as Partial<FitnessConfigTransition>;
  return exactObjectKeys(value, ["id", "status", "updated_at"]) &&
    safeOpaqueId(transition.id) && safeString(transition.status, 32) &&
    safeTimestamp(transition.updated_at);
}

function isTransitionPair(value: unknown): value is Readonly<{
  before: FitnessConfigTransition;
  after: FitnessConfigTransition;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pair = value as { before?: unknown; after?: unknown };
  return exactObjectKeys(value, ["before", "after"]) &&
    isTransition(pair.before) && isTransition(pair.after) &&
    pair.before.id === pair.after.id;
}

function hasValidReceiptBase(
  value: object,
  kind: string,
  additionalKeys: readonly string[],
): boolean {
  const receipt = value as Partial<FitnessConfigWriteReceipt>;
  return exactObjectKeys(value, [
    "purpose", "version", "operationId", "generationId", "generationSequence",
    "kind", "projectionSha256", ...additionalKeys,
  ]) && receipt.purpose === "fitness-config-write" && receipt.version === 1 &&
    receipt.kind === kind && typeof receipt.operationId === "string" &&
    CONFIG_OPERATION_ID_PATTERN.test(receipt.operationId) &&
    typeof receipt.generationId === "string" &&
    CONFIG_GENERATION_ID_PATTERN.test(receipt.generationId) &&
    safeTimestamp(receipt.generationSequence) &&
    typeof receipt.projectionSha256 === "string" &&
    CONFIG_HASH_PATTERN.test(receipt.projectionSha256);
}

function isStrictTarget<Before extends { updated_at: number }>(
  before: Before,
  after: Before,
  changes: Partial<Before>,
): boolean {
  return after.updated_at > before.updated_at &&
    sameProjection(after, { ...before, ...changes, updated_at: after.updated_at });
}

function uniqueTransitionIds(
  pairs: readonly Readonly<{
    before: FitnessConfigTransition;
    after: FitnessConfigTransition;
  }>[],
): boolean {
  return new Set(pairs.map(({ before }) => before.id)).size === pairs.length;
}

function isFitnessConfigWriteReceiptUnchecked(
  value: unknown,
): value is FitnessConfigWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  switch (receipt.kind) {
    case "profile-save":
      return hasValidReceiptBase(value, receipt.kind, ["before", "after"]) &&
        (receipt.before === null || isFitnessProfileRow(receipt.before)) &&
        isFitnessProfileRow(receipt.after) &&
        (receipt.before === null
          ? receipt.after.created_at === receipt.after.updated_at
          : receipt.before.created_at === receipt.after.created_at &&
            receipt.after.updated_at > receipt.before.updated_at);
    case "venue-save": {
      const resets = receipt.defaultResets as readonly Readonly<{
        before: FitnessVenue;
        after: FitnessVenue;
      }>[];
      return hasValidReceiptBase(value, receipt.kind, ["before", "after", "defaultResets"]) &&
        (receipt.before === null || isFitnessVenueRow(receipt.before)) &&
        isFitnessVenueRow(receipt.after) && Array.isArray(receipt.defaultResets) &&
        receipt.defaultResets.length <= CONFIG_MAX_ATOMIC_ROWS &&
        ((receipt.after as FitnessVenue).is_default || resets.length === 0) &&
        new Set(resets.map(({ before }) => before.id)).size === resets.length &&
        resets.every((pair) =>
          Boolean(pair) && typeof pair === "object" && !Array.isArray(pair) &&
          exactObjectKeys(pair, ["before", "after"]) &&
          isFitnessVenueRow(pair.before) && isFitnessVenueRow(pair.after) &&
          pair.before.id !== (receipt.after as FitnessVenue).id &&
          pair.before.is_default &&
          isStrictTarget(pair.before, pair.after, { is_default: false })
        ) && (receipt.before === null
          ? generatedIdMatches((receipt.after as FitnessVenue).id, "venue") &&
            (receipt.after as FitnessVenue).status === "active" &&
            (receipt.after as FitnessVenue).created_at === (receipt.after as FitnessVenue).updated_at
          : (receipt.before as FitnessVenue).id === (receipt.after as FitnessVenue).id &&
            (receipt.before as FitnessVenue).status === (receipt.after as FitnessVenue).status &&
            (receipt.before as FitnessVenue).created_at === (receipt.after as FitnessVenue).created_at &&
            (receipt.after as FitnessVenue).updated_at > (receipt.before as FitnessVenue).updated_at);
    }
    case "venue-archive": {
      const programs = receipt.programs as readonly Readonly<{
        before: FitnessConfigTransition;
        after: FitnessConfigTransition;
      }>[];
      const events = receipt.events as readonly Readonly<{
        before: FitnessConfigTransition;
        after: FitnessConfigTransition;
      }>[];
      return hasValidReceiptBase(value, receipt.kind, ["before", "after", "programs", "events"]) &&
        isFitnessVenueRow(receipt.before) && isFitnessVenueRow(receipt.after) &&
        Array.isArray(receipt.programs) && Array.isArray(receipt.events) &&
        receipt.programs.length + receipt.events.length <= CONFIG_MAX_ATOMIC_ROWS &&
        programs.every(isTransitionPair) && events.every(isTransitionPair) &&
        uniqueTransitionIds(programs) && uniqueTransitionIds(events) &&
        receipt.before.status === "active" &&
        isStrictTarget(receipt.before, receipt.after, {
          status: "archived",
          is_default: false,
        }) && programs.every(({ before, after }) =>
          (before.status === "active" || before.status === "draft") &&
          after.status === "archived" && after.updated_at > before.updated_at
        ) && events.every(({ before, after }) =>
          before.status === "planned" && after.status === "cancelled" &&
          after.updated_at > before.updated_at
        );
    }
    case "venue-restore":
      return hasValidReceiptBase(value, receipt.kind, ["before", "after"]) &&
        isFitnessVenueRow(receipt.before) && isFitnessVenueRow(receipt.after) &&
        receipt.before.status === "archived" &&
        isStrictTarget(receipt.before, receipt.after, { status: "active" });
    case "equipment-save": {
      const venue = receipt.venue as Record<string, unknown> | undefined;
      const before = receipt.before as FitnessEquipmentWriteSnapshot | null;
      const after = receipt.after as FitnessEquipmentWriteSnapshot;
      return hasValidReceiptBase(value, receipt.kind, ["before", "after", "venue"]) &&
        (before === null || isEquipmentSnapshot(before)) &&
        isEquipmentSnapshot(after) && Boolean(venue) &&
        exactObjectKeys(venue!, ["id", "status", "updated_at"]) &&
        safeOpaqueId(venue!.id) && venue!.status === "active" && safeTimestamp(venue!.updated_at) &&
        venue!.id === after.equipment.venue_id &&
        after.loads.every(({ id, created_at, equipment_id }) =>
          generatedIdMatches(id, "load") && created_at === after.equipment.updated_at &&
          equipment_id === after.equipment.id
        ) && (before === null
          ? generatedIdMatches(after.equipment.id, "equipment") &&
            after.equipment.created_at === after.equipment.updated_at
          : before.equipment.id === after.equipment.id &&
            before.equipment.status === after.equipment.status &&
            before.equipment.created_at === after.equipment.created_at &&
            after.equipment.updated_at > before.equipment.updated_at);
    }
    case "equipment-status":
      return hasValidReceiptBase(value, receipt.kind, ["before", "after"]) &&
        isFitnessEquipmentRow(receipt.before) && isFitnessEquipmentRow(receipt.after) &&
        receipt.before.status !== receipt.after.status &&
        isStrictTarget(receipt.before, receipt.after, { status: receipt.after.status });
    case "constraint-save":
      return hasValidReceiptBase(value, receipt.kind, ["before", "after"]) &&
        (receipt.before === null || isFitnessConstraintRow(receipt.before)) &&
        isFitnessConstraintRow(receipt.after) &&
        (receipt.before === null
          ? generatedIdMatches(receipt.after.id, "constraint") &&
            receipt.after.created_at === receipt.after.updated_at
          : receipt.before.id === receipt.after.id &&
            receipt.before.active === receipt.after.active &&
            receipt.before.created_at === receipt.after.created_at &&
            receipt.after.updated_at > receipt.before.updated_at);
    case "constraint-active":
      return hasValidReceiptBase(value, receipt.kind, ["before", "after"]) &&
        isFitnessConstraintRow(receipt.before) && isFitnessConstraintRow(receipt.after) &&
        receipt.before.active !== receipt.after.active &&
        isStrictTarget(receipt.before, receipt.after, { active: receipt.after.active });
    default:
      return false;
  }
}

export function isFitnessConfigWriteReceipt(
  value: unknown,
): value is FitnessConfigWriteReceipt {
  try {
    return isFitnessConfigWriteReceiptUnchecked(value);
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    ).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw configError("invalid_receipt", "写入回执包含不可序列化的值。");
  return encoded;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sealConfigReceipt<Receipt extends FitnessConfigWriteReceipt>(
  draft: Omit<Receipt, "projectionSha256">,
): Promise<Receipt> {
  const projectionSha256 = await sha256Hex(canonicalJson(draft));
  return { ...draft, projectionSha256 } as Receipt;
}

async function receiptHashIsValid(receipt: FitnessConfigWriteReceipt): Promise<boolean> {
  const { projectionSha256, ...projection } = receipt;
  return projectionSha256 === await sha256Hex(canonicalJson(projection));
}

function sameProjection(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function nextConfigTimestamp(before: number | null, now: number): number {
  if (!safeTimestamp(now)) throw configError("invalid_input", "设备时间不在可接受范围。");
  const next = before === null ? now : Math.max(now, before + 1);
  if (!safeTimestamp(next)) {
    throw configError("invalid_input", "资料版本时间已经超出可接受范围。");
  }
  return next;
}

function generatedConfigId(runtime: FitnessConfigStorageRuntime, prefix: string): string {
  const id = `${prefix}-${runtime.randomUUID()}`;
  if (!CONFIG_ID_PATTERN.test(id)) {
    throw configError("invalid_input", "无法生成可靠的写入标识。");
  }
  return id;
}

function generatedOperationId(runtime: FitnessConfigStorageRuntime): string {
  const id = `fitness-operation-${runtime.randomUUID()}`;
  if (!CONFIG_OPERATION_ID_PATTERN.test(id)) {
    throw configError("invalid_input", "无法生成可靠的操作标识。");
  }
  return id;
}

function safeConfigBroadcast(runtime: FitnessConfigStorageRuntime, reason: string): void {
  try {
    runtime.broadcast(reason);
  } catch {
    // A refresh hint is advisory and cannot reverse a durable commit.
  }
}

async function configRows<Result extends object>(
  runtime: FitnessConfigStorageRuntime,
  sql: string,
  params: SqlParams = [],
): Promise<readonly Result[]> {
  return (await runtime.query<Result>(sql, params)).rows;
}

async function readConfigGeneration(
  runtime: FitnessConfigStorageRuntime,
): Promise<Readonly<{ generationId: string; generationSequence: number }>> {
  const current = await runtime.currentGeneration();
  if (
    !current || !CONFIG_GENERATION_ID_PATTERN.test(current.generationId) ||
    !safeTimestamp(current.sequence)
  ) throw new Error("无法确认当前适练数据库世代");
  return {
    generationId: current.generationId,
    generationSequence: current.sequence,
  };
}

async function readConfigProfile(
  runtime: FitnessConfigStorageRuntime,
): Promise<FitnessProfile | null> {
  return mapProfile((await configRows<Row>(
    runtime,
    "SELECT * FROM fitness_profiles WHERE id='profile' LIMIT 1",
  ))[0]);
}

async function readConfigVenue(
  runtime: FitnessConfigStorageRuntime,
  id: string,
): Promise<FitnessVenue | null> {
  const row = (await configRows<Row>(
    runtime,
    "SELECT * FROM fitness_venues WHERE id=? LIMIT 1",
    [id],
  ))[0];
  return row ? mapVenue(row) : null;
}

async function readDefaultConfigVenues(
  runtime: FitnessConfigStorageRuntime,
  exceptId: string,
): Promise<FitnessVenue[]> {
  return (await configRows<Row>(
    runtime,
    "SELECT * FROM fitness_venues WHERE is_default=1 AND id<>? ORDER BY id",
    [exceptId],
  )).map(mapVenue);
}

async function readConfigVenuesByIds(
  runtime: FitnessConfigStorageRuntime,
  ids: readonly string[],
): Promise<FitnessVenue[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return (await configRows<Row>(
    runtime,
    `SELECT * FROM fitness_venues WHERE id IN (${placeholders}) ORDER BY id`,
    ids,
  )).map(mapVenue);
}

async function readConfigEquipment(
  runtime: FitnessConfigStorageRuntime,
  id: string,
): Promise<FitnessEquipmentWriteSnapshot | null> {
  const row = (await configRows<Row>(
    runtime,
    "SELECT * FROM fitness_equipment WHERE id=? LIMIT 1",
    [id],
  ))[0];
  if (!row) return null;
  const loads = (await configRows<Row>(
    runtime,
    `SELECT * FROM fitness_equipment_loads
      WHERE equipment_id=? ORDER BY load_grams,label,id`,
    [id],
  )).map(mapEquipmentLoad);
  return { equipment: mapEquipment(row), loads };
}

async function readConfigConstraint(
  runtime: FitnessConfigStorageRuntime,
  id: string,
): Promise<FitnessConstraint | null> {
  const row = (await configRows<Row>(
    runtime,
    "SELECT * FROM fitness_constraints WHERE id=? LIMIT 1",
    [id],
  ))[0];
  return row ? mapConstraint(row) : null;
}

async function readConfigVenueGuard(
  runtime: FitnessConfigStorageRuntime,
  id: string,
): Promise<Readonly<{ id: string; status: "active"; updated_at: number }> | null> {
  const row = (await configRows<{
    id: string;
    status: string;
    updated_at: number;
  }>(
    runtime,
    "SELECT id,status,updated_at FROM fitness_venues WHERE id=? LIMIT 1",
    [id],
  ))[0];
  return row?.status === "active"
    ? { id: row.id, status: "active", updated_at: Number(row.updated_at) }
    : null;
}

async function readVenueProgramTransitions(
  runtime: FitnessConfigStorageRuntime,
  venueId: string,
  statuses: readonly string[],
): Promise<FitnessConfigTransition[]> {
  const placeholders = statuses.map(() => "?").join(",");
  return (await configRows<FitnessConfigTransition>(
    runtime,
    `SELECT id,status,updated_at FROM fitness_programs
      WHERE venue_id=? AND status IN (${placeholders}) ORDER BY id`,
    [venueId, ...statuses],
  )).map((entry) => ({
    id: entry.id,
    status: entry.status,
    updated_at: Number(entry.updated_at),
  }));
}

async function readVenueEventTransitions(
  runtime: FitnessConfigStorageRuntime,
  venueId: string,
  statuses: readonly string[],
): Promise<FitnessConfigTransition[]> {
  const placeholders = statuses.map(() => "?").join(",");
  return (await configRows<FitnessConfigTransition>(
    runtime,
    `SELECT id,status,updated_at FROM fitness_calendar_events
      WHERE venue_id=? AND status IN (${placeholders}) ORDER BY id`,
    [venueId, ...statuses],
  )).map((entry) => ({
    id: entry.id,
    status: entry.status,
    updated_at: Number(entry.updated_at),
  }));
}

function cloneChecked<RowType>(
  value: RowType,
  guard: (candidate: unknown) => candidate is RowType,
  label: string,
): RowType {
  try {
    if (!guard(value)) throw configError("invalid_input", `${label}快照格式不正确。`);
    const cloned = JSON.parse(JSON.stringify(value)) as unknown;
    if (!guard(cloned)) throw configError("invalid_input", `${label}快照不能安全保存。`);
    return cloned;
  } catch (error) {
    if (error instanceof FitnessConfigMutationError) throw error;
    throw configError("invalid_input", `${label}快照格式不正确。`);
  }
}

function cloneExpectedEquipment(
  value: FitnessEquipmentWriteSnapshot | null,
): FitnessEquipmentWriteSnapshot | null {
  return value === null
    ? null
    : cloneChecked(value, isEquipmentSnapshot, "器材");
}

function normalizedProfileTarget(
  input: SaveFitnessProfileInput,
  before: FitnessProfile | null,
  timestamp: number,
): FitnessProfile {
  requireUniqueStrings(input.goals, "训练目标");
  if (input.goals.length === 0 || input.goals.some((goal) => !FITNESS_GOALS.has(goal))) {
    throw configError("invalid_input", "请选择至少一个可识别的训练目标。");
  }
  requireInteger(input.resistance_days_per_week, "每周无氧次数", 0, 7);
  requireInteger(input.cardio_days_per_week, "每周有氧次数", 0, 7);
  requireInteger(input.session_minutes, "单次训练时长", 10, 240);
  requireInteger(input.preferred_rir, "目标 RIR", 0, 5);
  requireInteger(input.rest_seconds, "组间休息", 15, 600);
  const weekdays = [...input.preferred_weekdays];
  if (
    new Set(weekdays).size !== weekdays.length ||
    weekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 0 || weekday > 6)
  ) throw configError("invalid_input", "常用训练日格式不正确。");
  const target: FitnessProfile = {
    id: "profile",
    goals: [...input.goals],
    experience: input.experience,
    resistance_days_per_week: input.resistance_days_per_week,
    cardio_days_per_week: input.cardio_days_per_week,
    session_minutes: input.session_minutes,
    split: input.split,
    preferred_weekdays: weekdays,
    preferred_rir: input.preferred_rir,
    rest_seconds: input.rest_seconds,
    unit: input.unit,
    notes: input.notes.trim(),
    created_at: before?.created_at ?? timestamp,
    updated_at: timestamp,
  };
  if (!isFitnessProfileRow(target)) throw configError("invalid_input", "训练偏好格式不正确。");
  return target;
}

function normalizedVenueTarget(
  input: Omit<SaveVenueInput, "id">,
  id: string,
  before: FitnessVenue | null,
  timestamp: number,
): FitnessVenue {
  const target: FitnessVenue = {
    id,
    name: requireNonEmpty(input.name, "场地名称", 120),
    venue_type: input.venue_type,
    location: input.location.trim(),
    area_notes: input.area_notes.trim(),
    busy_notes: input.busy_notes.trim(),
    default_session_minutes: requireInteger(
      input.default_session_minutes,
      "场地默认训练时长",
      10,
      240,
    ),
    supersets_allowed: input.supersets_allowed,
    is_default: input.is_default,
    status: input.status,
    last_verified_at: input.last_verified_at,
    created_at: before?.created_at ?? timestamp,
    updated_at: timestamp,
  };
  if (!isFitnessVenueRow(target)) throw configError("invalid_input", "场地内容格式不正确。");
  if (target.is_default && target.status !== "active") {
    throw configError("invalid_input", "已归档场地不能设为默认场地。");
  }
  return target;
}

function normalizedEquipmentTarget(
  runtime: FitnessConfigStorageRuntime,
  input: SaveFitnessEquipmentSafelyInput,
  id: string,
  before: FitnessEquipmentWriteSnapshot | null,
  timestamp: number,
): FitnessEquipmentWriteSnapshot {
  requireInteger(input.quantity, "器材数量", 1, 1000);
  for (const [value, label, minimum] of [
    [input.min_load_grams, "器材最低重量", 0],
    [input.max_load_grams, "器材最高重量", 0],
    [input.increment_grams, "器材重量增量", 1],
    [input.bar_weight_grams, "空杆重量", 0],
  ] as const) {
    if (value !== null) requireInteger(value, label, minimum, 10_000_000);
  }
  if (
    input.min_load_grams !== null && input.max_load_grams !== null &&
    input.max_load_grams < input.min_load_grams
  ) throw configError("invalid_input", "器材重量范围前后颠倒。");
  if (input.load_mode !== "discrete" && input.loads.length > 0) {
    throw configError("invalid_input", "只有离散档位器材可以录入重量阶梯。");
  }
  if (input.loads.length > CONFIG_MAX_ATOMIC_ROWS) {
    throw configError("invalid_input", "器材重量档位过多，无法一次安全保存。");
  }
  requireUniqueStrings(input.attachments, "器材附件");
  const keys = new Set<string>();
  const loads = input.loads.map((load) => {
    const loadGrams = requireInteger(load.load_grams, "器材重量", 0, 10_000_000);
    const quantity = requireInteger(load.quantity, "该档位数量", 1, 1000);
    const label = requireNonEmpty(load.label, "重量档位名称", 120);
    if (
      (input.min_load_grams !== null && loadGrams < input.min_load_grams) ||
      (input.max_load_grams !== null && loadGrams > input.max_load_grams)
    ) throw configError("invalid_input", "器材档位超出已记录的重量范围。");
    const key = `${loadGrams}\u0000${label}`;
    if (keys.has(key)) throw configError("invalid_input", "器材重量档位不能重复。");
    keys.add(key);
    return {
      id: generatedConfigId(runtime, "load"),
      equipment_id: id,
      load_grams: loadGrams,
      quantity,
      label,
      available: load.available,
      created_at: timestamp,
    } satisfies FitnessEquipmentLoad;
  }).sort((left, right) =>
    left.load_grams - right.load_grams || left.label.localeCompare(right.label) ||
    left.id.localeCompare(right.id)
  );
  const equipment: FitnessEquipment = {
    id,
    venue_id: input.venue_id,
    name: requireNonEmpty(input.name, "器材名称"),
    kind: input.kind,
    area: input.area.trim(),
    quantity: input.quantity,
    status: input.status,
    load_mode: input.load_mode,
    load_semantics: input.load_semantics,
    min_load_grams: input.min_load_grams,
    max_load_grams: input.max_load_grams,
    increment_grams: input.increment_grams,
    bar_weight_grams: input.bar_weight_grams,
    unilateral: input.unilateral,
    busy_level: input.busy_level,
    settings: { ...input.settings },
    attachments: [...input.attachments],
    notes: input.notes.trim(),
    created_at: before?.equipment.created_at ?? timestamp,
    updated_at: timestamp,
  };
  const target = { equipment, loads };
  if (!isEquipmentSnapshot(target)) throw configError("invalid_input", "器材内容格式不正确。");
  return target;
}

function normalizedConstraintTarget(
  input: Omit<SaveConstraintInput, "id">,
  id: string,
  before: FitnessConstraint | null,
  timestamp: number,
): FitnessConstraint {
  const label = requireNonEmpty(input.label, "身体限制名称");
  requireUniqueStrings(input.movement_patterns, "受影响动作模式");
  requireUniqueStrings(input.exercise_ids, "受影响动作");
  if (input.active && input.movement_patterns.length === 0 && input.exercise_ids.length === 0) {
    throw configError("invalid_input", "启用的身体边界必须至少包含一个受影响范围。");
  }
  if (input.movement_patterns.some((pattern) => !MOVEMENT_PATTERNS.has(pattern))) {
    throw configError("invalid_input", "身体限制包含未知的动作模式。");
  }
  if (input.exercise_ids.some((exerciseId) => !getFitnessExercise(exerciseId))) {
    throw configError("invalid_input", "身体限制包含未知动作。");
  }
  const target: FitnessConstraint = {
    id,
    label,
    body_area: input.body_area.trim(),
    severity: input.severity,
    movement_patterns: [...input.movement_patterns],
    exercise_ids: [...input.exercise_ids],
    note: input.note.trim(),
    active: input.active,
    created_at: before?.created_at ?? timestamp,
    updated_at: timestamp,
  };
  if (!isFitnessConstraintRow(target)) {
    throw configError("invalid_input", "身体边界内容格式不正确。");
  }
  return target;
}

async function readTransitionsByIds(
  runtime: FitnessConfigStorageRuntime,
  table: "fitness_programs" | "fitness_calendar_events",
  ids: readonly string[],
): Promise<FitnessConfigTransition[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return (await configRows<FitnessConfigTransition>(
    runtime,
    `SELECT id,status,updated_at FROM ${table} WHERE id IN (${placeholders}) ORDER BY id`,
    ids,
  )).map((entry) => ({
    id: entry.id,
    status: entry.status,
    updated_at: Number(entry.updated_at),
  }));
}

async function receiptStateUnlocked(
  runtime: FitnessConfigStorageRuntime,
  receipt: FitnessConfigWriteReceipt,
): Promise<Exclude<FitnessConfigWriteInspection, "still_unknown" | "invalid_receipt">> {
  const generation = await readConfigGeneration(runtime);
  if (
    generation.generationId !== receipt.generationId ||
    generation.generationSequence !== receipt.generationSequence
  ) return "changed";
  switch (receipt.kind) {
    case "profile-save": {
      const current = await readConfigProfile(runtime);
      if (sameProjection(current, receipt.after)) return "exact_saved";
      return sameProjection(current, receipt.before) ? "expected" : "changed";
    }
    case "venue-save": {
      const current = await readConfigVenue(runtime, receipt.after.id);
      const beforeDefaults = receipt.defaultResets.map(({ before }) => before);
      const afterDefaults = receipt.defaultResets.map(({ after }) => after);
      const [resetRows, currentDefaults] = receipt.after.is_default
        ? await Promise.all([
            readConfigVenuesByIds(
              runtime,
              receipt.defaultResets.map(({ before }) => before.id),
            ),
            readDefaultConfigVenues(runtime, receipt.after.id),
          ])
        : [[], []];
      if (
        sameProjection(current, receipt.after) &&
        sameProjection(resetRows, afterDefaults) &&
        currentDefaults.length === 0
      ) return "exact_saved";
      return sameProjection(current, receipt.before) &&
          sameProjection(resetRows, beforeDefaults) &&
          sameProjection(currentDefaults, beforeDefaults)
        ? "expected"
        : "changed";
    }
    case "venue-archive": {
      const current = await readConfigVenue(runtime, receipt.before.id);
      const programIds = receipt.programs.map(({ before }) => before.id);
      const eventIds = receipt.events.map(({ before }) => before.id);
      const [programs, events, activePrograms, plannedEvents, activeSessions] = await Promise.all([
        readTransitionsByIds(runtime, "fitness_programs", programIds),
        readTransitionsByIds(runtime, "fitness_calendar_events", eventIds),
        readVenueProgramTransitions(runtime, receipt.before.id, ["active", "draft"]),
        readVenueEventTransitions(runtime, receipt.before.id, ["planned"]),
        configRows<{ id: string }>(
          runtime,
          "SELECT id FROM fitness_sessions WHERE venue_id=? AND status='active' ORDER BY id",
          [receipt.before.id],
        ),
      ]);
      const expectedPrograms = receipt.programs.map(({ before }) => before);
      const expectedEvents = receipt.events.map(({ before }) => before);
      const targetPrograms = receipt.programs.map(({ after }) => after);
      const targetEvents = receipt.events.map(({ after }) => after);
      if (
        sameProjection(current, receipt.after) &&
        sameProjection(programs, targetPrograms) &&
        sameProjection(events, targetEvents) &&
        activePrograms.length === 0 && plannedEvents.length === 0 &&
        activeSessions.length === 0
      ) return "exact_saved";
      return sameProjection(current, receipt.before) && activeSessions.length === 0 &&
          sameProjection(programs, expectedPrograms) &&
          sameProjection(events, expectedEvents) &&
          sameProjection(activePrograms, expectedPrograms) &&
          sameProjection(plannedEvents, expectedEvents)
        ? "expected"
        : "changed";
    }
    case "venue-restore": {
      const current = await readConfigVenue(runtime, receipt.before.id);
      if (sameProjection(current, receipt.after)) return "exact_saved";
      return sameProjection(current, receipt.before) ? "expected" : "changed";
    }
    case "equipment-save": {
      const current = await readConfigEquipment(runtime, receipt.after.equipment.id);
      if (sameProjection(current, receipt.after)) return "exact_saved";
      const venue = await readConfigVenueGuard(runtime, receipt.venue.id);
      return sameProjection(current, receipt.before) && sameProjection(venue, receipt.venue)
        ? "expected"
        : "changed";
    }
    case "equipment-status": {
      const current = (await readConfigEquipment(runtime, receipt.before.id))?.equipment ?? null;
      if (sameProjection(current, receipt.after)) return "exact_saved";
      return sameProjection(current, receipt.before) ? "expected" : "changed";
    }
    case "constraint-save": {
      const current = await readConfigConstraint(runtime, receipt.after.id);
      if (sameProjection(current, receipt.after)) return "exact_saved";
      return sameProjection(current, receipt.before) ? "expected" : "changed";
    }
    case "constraint-active": {
      const current = await readConfigConstraint(runtime, receipt.before.id);
      if (sameProjection(current, receipt.after)) return "exact_saved";
      return sameProjection(current, receipt.before) ? "expected" : "changed";
    }
  }
}

async function inspectReceiptUnlocked(
  runtime: FitnessConfigStorageRuntime,
  receipt: FitnessConfigWriteReceipt,
): Promise<FitnessConfigWriteInspection> {
  try {
    return await receiptStateUnlocked(runtime, receipt);
  } catch {
    return "still_unknown";
  }
}

function snapshotInput<Input>(value: Input): Input {
  try {
    return JSON.parse(JSON.stringify(value)) as Input;
  } catch {
    throw configError("invalid_input", "写入内容不能安全复制。");
  }
}

function assertPreparedExpected(
  current: unknown,
  expected: unknown,
  label: string,
): void {
  if (!sameProjection(current, expected)) {
    throw configError("changed", `${label}已在别处变化；没有准备这次写入。`);
  }
}

function receiptEntity(receipt: FitnessConfigWriteReceipt): {
  id: string;
  updatedAt: number;
  reason: string;
} {
  switch (receipt.kind) {
    case "profile-save":
      return { id: "profile", updatedAt: receipt.after.updated_at, reason: "profile-saved" };
    case "venue-save":
      return { id: receipt.after.id, updatedAt: receipt.after.updated_at, reason: "venue-saved" };
    case "venue-archive":
      return { id: receipt.after.id, updatedAt: receipt.after.updated_at, reason: "venue-archived" };
    case "venue-restore":
      return { id: receipt.after.id, updatedAt: receipt.after.updated_at, reason: "venue-restored" };
    case "equipment-save":
      return {
        id: receipt.after.equipment.id,
        updatedAt: receipt.after.equipment.updated_at,
        reason: "equipment-saved",
      };
    case "equipment-status":
      return { id: receipt.after.id, updatedAt: receipt.after.updated_at, reason: "equipment-status" };
    case "constraint-save":
      return { id: receipt.after.id, updatedAt: receipt.after.updated_at, reason: "constraint-saved" };
    case "constraint-active":
      return {
        id: receipt.after.id,
        updatedAt: receipt.after.updated_at,
        reason: receipt.after.active ? "constraint-activated" : "constraint-deactivated",
      };
  }
}

export function createFitnessConfigStorageService(
  runtime: FitnessConfigStorageRuntime = {
    withExclusiveLock: (operation) => withFitnessWriteLock(operation, { requireSupport: true }),
    query: async <Result extends object>(sql: string, params?: SqlParams) => ({
      rows: await rawQuery<Result>(sql, params),
    }),
    batch: (statements) => rawBatch(statements),
    currentGeneration: () => localDb.currentGeneration(DB),
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    broadcast: broadcastFitnessChange,
  },
) {
  async function prepareLocked<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await runtime.withExclusiveLock(operation);
    } catch (error) {
      if (error instanceof FitnessConfigMutationError) throw error;
      if (error instanceof TypeError) {
        throw configError("invalid_input", error.message);
      }
      throw configError("inspect_failed", "暂时无法核对最新资料；没有开始写入。");
    }
  }

  async function prepareProfileSave(
    inputValue: SaveFitnessProfileInput,
    expectedValue: FitnessProfile | null,
  ): Promise<FitnessProfileSaveReceipt> {
    const input = snapshotInput(inputValue);
    const expected = expectedValue === null
      ? null
      : cloneChecked(expectedValue, isFitnessProfileRow, "训练偏好");
    return prepareLocked(async () => {
      const generation = await readConfigGeneration(runtime);
      const current = await readConfigProfile(runtime);
      assertPreparedExpected(current, expected, "训练偏好");
      const timestamp = nextConfigTimestamp(expected?.updated_at ?? null, runtime.now());
      const after = normalizedProfileTarget(input, expected, timestamp);
      return sealConfigReceipt<FitnessProfileSaveReceipt>({
        purpose: "fitness-config-write",
        version: 1,
        operationId: generatedOperationId(runtime),
        ...generation,
        kind: "profile-save",
        before: expected,
        after,
      });
    });
  }

  async function prepareVenueSave(
    inputValue: Omit<SaveVenueInput, "id">,
    expectedValue: FitnessVenue | null,
  ): Promise<FitnessVenueSaveReceipt> {
    const input = snapshotInput(inputValue);
    const expected = expectedValue === null
      ? null
      : cloneChecked(expectedValue, isFitnessVenueRow, "场地");
    if (
      (expected === null && input.status !== "active") ||
      (expected !== null && input.status !== expected.status)
    ) {
      throw configError("invalid_input", "场地状态请通过归档或恢复操作修改。");
    }
    return prepareLocked(async () => {
      const generation = await readConfigGeneration(runtime);
      const id = expected?.id ?? generatedConfigId(runtime, "venue");
      const current = await readConfigVenue(runtime, id);
      if (expected === null && current !== null) {
        throw configError("conflict", "新场地标识已经对应另一份内容；没有覆盖原资料。");
      }
      assertPreparedExpected(current, expected, "场地");
      const now = runtime.now();
      const timestamp = nextConfigTimestamp(expected?.updated_at ?? null, now);
      const after = normalizedVenueTarget(input, id, expected, timestamp);
      const defaults = after.is_default
        ? await readDefaultConfigVenues(runtime, id)
        : [];
      if (defaults.length > CONFIG_MAX_ATOMIC_ROWS) {
        throw configError("invalid_input", "默认场地状态异常，无法一次安全整理。");
      }
      const defaultResets = defaults.map((before) => ({
        before,
        after: {
          ...before,
          is_default: false,
          updated_at: nextConfigTimestamp(before.updated_at, now),
        },
      }));
      return sealConfigReceipt<FitnessVenueSaveReceipt>({
        purpose: "fitness-config-write",
        version: 1,
        operationId: generatedOperationId(runtime),
        ...generation,
        kind: "venue-save",
        before: expected,
        after,
        defaultResets,
      });
    });
  }

  async function prepareVenueArchive(
    expectedValue: FitnessVenue,
  ): Promise<FitnessVenueArchiveReceipt> {
    const expected = cloneChecked(expectedValue, isFitnessVenueRow, "场地");
    if (expected.status !== "active") {
      throw configError("invalid_input", "只能归档当前可用的场地。");
    }
    return prepareLocked(async () => {
      const generation = await readConfigGeneration(runtime);
      const current = await readConfigVenue(runtime, expected.id);
      assertPreparedExpected(current, expected, "场地");
      const activeSessions = await configRows<{ id: string }>(
        runtime,
        "SELECT id FROM fitness_sessions WHERE venue_id=? AND status='active' LIMIT 1",
        [expected.id],
      );
      if (activeSessions.length > 0) {
        throw configError("changed", "这个场地仍有正在进行的训练；没有准备归档。");
      }
      const [programBefore, eventBefore] = await Promise.all([
        readVenueProgramTransitions(runtime, expected.id, ["active", "draft"]),
        readVenueEventTransitions(runtime, expected.id, ["planned"]),
      ]);
      if (programBefore.length + eventBefore.length > CONFIG_MAX_ATOMIC_ROWS) {
        throw configError("invalid_input", "这个场地关联的待处理安排过多，无法一次安全归档。");
      }
      const now = runtime.now();
      const after: FitnessVenue = {
        ...expected,
        status: "archived",
        is_default: false,
        updated_at: nextConfigTimestamp(expected.updated_at, now),
      };
      const programs = programBefore.map((before) => ({
        before,
        after: {
          ...before,
          status: "archived",
          updated_at: nextConfigTimestamp(before.updated_at, now),
        },
      }));
      const events = eventBefore.map((before) => ({
        before,
        after: {
          ...before,
          status: "cancelled",
          updated_at: nextConfigTimestamp(before.updated_at, now),
        },
      }));
      return sealConfigReceipt<FitnessVenueArchiveReceipt>({
        purpose: "fitness-config-write",
        version: 1,
        operationId: generatedOperationId(runtime),
        ...generation,
        kind: "venue-archive",
        before: expected,
        after,
        programs,
        events,
      });
    });
  }

  async function prepareVenueRestore(
    expectedValue: FitnessVenue,
  ): Promise<FitnessVenueRestoreReceipt> {
    const expected = cloneChecked(expectedValue, isFitnessVenueRow, "场地");
    if (expected.status !== "archived") {
      throw configError("invalid_input", "只能恢复已归档的场地。");
    }
    return prepareLocked(async () => {
      const generation = await readConfigGeneration(runtime);
      const current = await readConfigVenue(runtime, expected.id);
      assertPreparedExpected(current, expected, "场地");
      const after: FitnessVenue = {
        ...expected,
        status: "active",
        updated_at: nextConfigTimestamp(expected.updated_at, runtime.now()),
      };
      return sealConfigReceipt<FitnessVenueRestoreReceipt>({
        purpose: "fitness-config-write",
        version: 1,
        operationId: generatedOperationId(runtime),
        ...generation,
        kind: "venue-restore",
        before: expected,
        after,
      });
    });
  }

  async function prepareEquipmentSave(
    inputValue: SaveFitnessEquipmentSafelyInput,
    expectedValue: FitnessEquipmentWriteSnapshot | null,
  ): Promise<FitnessEquipmentSaveReceipt> {
    const input = snapshotInput(inputValue);
    const expected = cloneExpectedEquipment(expectedValue);
    if (expected !== null && input.status !== expected.equipment.status) {
      throw configError("invalid_input", "器材状态请通过状态操作修改。");
    }
    return prepareLocked(async () => {
      const generation = await readConfigGeneration(runtime);
      const id = expected?.equipment.id ?? generatedConfigId(runtime, "equipment");
      const current = await readConfigEquipment(runtime, id);
      if (expected === null && current !== null) {
        throw configError("conflict", "新器材标识已经对应另一份内容；没有覆盖原资料。");
      }
      assertPreparedExpected(current, expected, "器材");
      const venue = await readConfigVenueGuard(runtime, input.venue_id);
      if (!venue) {
        throw configError("changed", "目标场地不存在或已经归档；没有准备器材写入。");
      }
      const timestamp = nextConfigTimestamp(
        expected?.equipment.updated_at ?? null,
        runtime.now(),
      );
      const after = normalizedEquipmentTarget(runtime, input, id, expected, timestamp);
      return sealConfigReceipt<FitnessEquipmentSaveReceipt>({
        purpose: "fitness-config-write",
        version: 1,
        operationId: generatedOperationId(runtime),
        ...generation,
        kind: "equipment-save",
        before: expected,
        after,
        venue,
      });
    });
  }

  async function prepareEquipmentStatus(
    expectedValue: FitnessEquipment,
    status: FitnessEquipment["status"],
  ): Promise<FitnessEquipmentStatusReceipt> {
    const expected = cloneChecked(expectedValue, isFitnessEquipmentRow, "器材");
    if (!["available", "limited", "maintenance", "removed"].includes(status)) {
      throw configError("invalid_input", "器材状态不受支持。");
    }
    if (expected.status === status) {
      throw configError("invalid_input", "器材已经处于目标状态。");
    }
    return prepareLocked(async () => {
      const generation = await readConfigGeneration(runtime);
      const current = (await readConfigEquipment(runtime, expected.id))?.equipment ?? null;
      assertPreparedExpected(current, expected, "器材");
      const after: FitnessEquipment = {
        ...expected,
        status,
        updated_at: nextConfigTimestamp(expected.updated_at, runtime.now()),
      };
      return sealConfigReceipt<FitnessEquipmentStatusReceipt>({
        purpose: "fitness-config-write",
        version: 1,
        operationId: generatedOperationId(runtime),
        ...generation,
        kind: "equipment-status",
        before: expected,
        after,
      });
    });
  }

  async function prepareConstraintSave(
    inputValue: Omit<SaveConstraintInput, "id">,
    expectedValue: FitnessConstraint | null,
  ): Promise<FitnessConstraintSaveReceipt> {
    const input = snapshotInput(inputValue);
    const expected = expectedValue === null
      ? null
      : cloneChecked(expectedValue, isFitnessConstraintRow, "身体边界");
    if (expected !== null && input.active !== expected.active) {
      throw configError("invalid_input", "身体边界启用状态请通过状态操作修改。");
    }
    return prepareLocked(async () => {
      const generation = await readConfigGeneration(runtime);
      const id = expected?.id ?? generatedConfigId(runtime, "constraint");
      const current = await readConfigConstraint(runtime, id);
      if (expected === null && current !== null) {
        throw configError("conflict", "新身体边界标识已经对应另一份内容；没有覆盖原资料。");
      }
      assertPreparedExpected(current, expected, "身体边界");
      const timestamp = nextConfigTimestamp(expected?.updated_at ?? null, runtime.now());
      const after = normalizedConstraintTarget(input, id, expected, timestamp);
      return sealConfigReceipt<FitnessConstraintSaveReceipt>({
        purpose: "fitness-config-write",
        version: 1,
        operationId: generatedOperationId(runtime),
        ...generation,
        kind: "constraint-save",
        before: expected,
        after,
      });
    });
  }

  async function prepareConstraintActive(
    expectedValue: FitnessConstraint,
    active: boolean,
  ): Promise<FitnessConstraintActiveReceipt> {
    const expected = cloneChecked(expectedValue, isFitnessConstraintRow, "身体边界");
    if (typeof active !== "boolean" || expected.active === active) {
      throw configError("invalid_input", "身体边界已经处于目标状态。");
    }
    if (active && expected.movement_patterns.length === 0 && expected.exercise_ids.length === 0) {
      throw configError("invalid_input", "这条身体边界没有受影响范围，不能启用。");
    }
    return prepareLocked(async () => {
      const generation = await readConfigGeneration(runtime);
      const current = await readConfigConstraint(runtime, expected.id);
      assertPreparedExpected(current, expected, "身体边界");
      const after: FitnessConstraint = {
        ...expected,
        active,
        updated_at: nextConfigTimestamp(expected.updated_at, runtime.now()),
      };
      return sealConfigReceipt<FitnessConstraintActiveReceipt>({
        purpose: "fitness-config-write",
        version: 1,
        operationId: generatedOperationId(runtime),
        ...generation,
        kind: "constraint-active",
        before: expected,
        after,
      });
    });
  }

  type ConfigPredicate = Readonly<{ sql: string; params: readonly unknown[] }>;

  function joinedPredicate(predicates: readonly ConfigPredicate[]): ConfigPredicate {
    return {
      sql: predicates.length === 0
        ? "1"
        : predicates.map(({ sql }) => `(${sql})`).join(" AND "),
      params: predicates.flatMap(({ params }) => [...params]),
    };
  }

  function absentPredicate(table: string, id: string): ConfigPredicate {
    return {
      sql: `NOT EXISTS(SELECT 1 FROM ${table} WHERE id=?)`,
      params: [id],
    };
  }

  function profilePredicate(row: FitnessProfile): ConfigPredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_profiles WHERE id='profile'
        AND json(goals_json)=json(?) AND experience IS ?
        AND resistance_days_per_week IS ? AND cardio_days_per_week IS ?
        AND session_minutes IS ? AND split IS ?
        AND json(preferred_weekdays_json)=json(?) AND preferred_rir IS ?
        AND rest_seconds IS ? AND unit IS ? AND notes IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        JSON.stringify(row.goals), row.experience, row.resistance_days_per_week,
        row.cardio_days_per_week, row.session_minutes, row.split,
        JSON.stringify(row.preferred_weekdays), row.preferred_rir, row.rest_seconds,
        row.unit, row.notes, row.created_at, row.updated_at,
      ],
    };
  }

  function venuePredicate(row: FitnessVenue): ConfigPredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_venues WHERE id=? AND name IS ?
        AND venue_type IS ? AND location IS ? AND area_notes IS ? AND busy_notes IS ?
        AND default_session_minutes IS ? AND supersets_allowed IS ?
        AND is_default IS ? AND status IS ? AND last_verified_at IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id, row.name, row.venue_type, row.location, row.area_notes, row.busy_notes,
        row.default_session_minutes, Number(row.supersets_allowed), Number(row.is_default),
        row.status, row.last_verified_at, row.created_at, row.updated_at,
      ],
    };
  }

  function equipmentPredicate(row: FitnessEquipment): ConfigPredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_equipment WHERE id=? AND venue_id IS ?
        AND name IS ? AND kind IS ? AND area IS ? AND quantity IS ? AND status IS ?
        AND load_mode IS ? AND load_semantics IS ? AND min_load_grams IS ?
        AND max_load_grams IS ? AND increment_grams IS ? AND bar_weight_grams IS ?
        AND unilateral IS ? AND busy_level IS ? AND json(settings_json)=json(?)
        AND json(attachments_json)=json(?) AND notes IS ? AND created_at IS ?
        AND updated_at IS ?)`,
      params: [
        row.id, row.venue_id, row.name, row.kind, row.area, row.quantity, row.status,
        row.load_mode, row.load_semantics, row.min_load_grams, row.max_load_grams,
        row.increment_grams, row.bar_weight_grams, Number(row.unilateral), row.busy_level,
        JSON.stringify(row.settings), JSON.stringify(row.attachments), row.notes,
        row.created_at, row.updated_at,
      ],
    };
  }

  function constraintPredicate(row: FitnessConstraint): ConfigPredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_constraints WHERE id=? AND label IS ?
        AND body_area IS ? AND severity IS ? AND json(movement_patterns_json)=json(?)
        AND json(exercise_ids_json)=json(?) AND note IS ? AND active IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id, row.label, row.body_area, row.severity,
        JSON.stringify(row.movement_patterns), JSON.stringify(row.exercise_ids),
        row.note, Number(row.active), row.created_at, row.updated_at,
      ],
    };
  }

  function loadSetPredicate(
    equipmentId: string,
    loads: readonly FitnessEquipmentLoad[],
  ): ConfigPredicate {
    const predicates: ConfigPredicate[] = [{
      sql: "(SELECT COUNT(*) FROM fitness_equipment_loads WHERE equipment_id=?)=?",
      params: [equipmentId, loads.length],
    }];
    for (const load of loads) {
      predicates.push({
        sql: `EXISTS(SELECT 1 FROM fitness_equipment_loads WHERE id=?
          AND equipment_id IS ? AND load_grams IS ? AND quantity IS ?
          AND label IS ? AND available IS ? AND created_at IS ?)`,
        params: [
          load.id, load.equipment_id, load.load_grams, load.quantity, load.label,
          Number(load.available), load.created_at,
        ],
      });
    }
    return joinedPredicate(predicates);
  }

  function transitionSetPredicate(
    table: "fitness_programs" | "fitness_calendar_events",
    venueId: string,
    affectedStatuses: readonly string[],
    rows: readonly FitnessConfigTransition[],
  ): ConfigPredicate {
    const placeholders = affectedStatuses.map(() => "?").join(",");
    const predicates: ConfigPredicate[] = [{
      sql: `(SELECT COUNT(*) FROM ${table} WHERE venue_id=?
        AND status IN (${placeholders}))=?`,
      params: [venueId, ...affectedStatuses, rows.length],
    }];
    for (const row of rows) {
      predicates.push({
        sql: `EXISTS(SELECT 1 FROM ${table} WHERE id=? AND venue_id=?
          AND status IS ? AND updated_at IS ?)`,
        params: [row.id, venueId, row.status, row.updated_at],
      });
    }
    return joinedPredicate(predicates);
  }

  function defaultSetPredicate(
    targetId: string,
    defaults: readonly FitnessVenue[],
  ): ConfigPredicate {
    return joinedPredicate([
      {
        sql: "(SELECT COUNT(*) FROM fitness_venues WHERE is_default=1 AND id<>?)=?",
        params: [targetId, defaults.length],
      },
      ...defaults.map(venuePredicate),
    ]);
  }

  function configCasSentinel(predicate: ConfigPredicate): SqlStatement {
    return {
      sql: `INSERT INTO fitness_settings(key,value,updated_at)
        SELECT '__fitness_config_cas_abort__',NULL,0 WHERE NOT (${predicate.sql})`,
      params: predicate.params,
    };
  }

  function insertProfile(row: FitnessProfile): SqlStatement {
    return {
      sql: `INSERT INTO fitness_profiles(
        id,goals_json,experience,resistance_days_per_week,cardio_days_per_week,
        session_minutes,split,preferred_weekdays_json,preferred_rir,rest_seconds,
        unit,notes,created_at,updated_at
      ) VALUES('profile',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        JSON.stringify(row.goals), row.experience, row.resistance_days_per_week,
        row.cardio_days_per_week, row.session_minutes, row.split,
        JSON.stringify(row.preferred_weekdays), row.preferred_rir, row.rest_seconds,
        row.unit, row.notes, row.created_at, row.updated_at,
      ],
    };
  }

  function updateProfile(row: FitnessProfile): SqlStatement {
    return {
      sql: `UPDATE fitness_profiles SET goals_json=?,experience=?,
        resistance_days_per_week=?,cardio_days_per_week=?,session_minutes=?,split=?,
        preferred_weekdays_json=?,preferred_rir=?,rest_seconds=?,unit=?,notes=?,updated_at=?
        WHERE id='profile'`,
      params: [
        JSON.stringify(row.goals), row.experience, row.resistance_days_per_week,
        row.cardio_days_per_week, row.session_minutes, row.split,
        JSON.stringify(row.preferred_weekdays), row.preferred_rir, row.rest_seconds,
        row.unit, row.notes, row.updated_at,
      ],
    };
  }

  function insertVenue(row: FitnessVenue): SqlStatement {
    return {
      sql: `INSERT INTO fitness_venues(
        id,name,venue_type,location,area_notes,busy_notes,default_session_minutes,
        supersets_allowed,is_default,status,last_verified_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        row.id, row.name, row.venue_type, row.location, row.area_notes, row.busy_notes,
        row.default_session_minutes, Number(row.supersets_allowed), Number(row.is_default),
        row.status, row.last_verified_at, row.created_at, row.updated_at,
      ],
    };
  }

  function updateVenue(row: FitnessVenue): SqlStatement {
    return {
      sql: `UPDATE fitness_venues SET name=?,venue_type=?,location=?,area_notes=?,
        busy_notes=?,default_session_minutes=?,supersets_allowed=?,is_default=?,
        status=?,last_verified_at=?,updated_at=? WHERE id=?`,
      params: [
        row.name, row.venue_type, row.location, row.area_notes, row.busy_notes,
        row.default_session_minutes, Number(row.supersets_allowed), Number(row.is_default),
        row.status, row.last_verified_at, row.updated_at, row.id,
      ],
    };
  }

  function insertEquipment(row: FitnessEquipment): SqlStatement {
    return {
      sql: `INSERT INTO fitness_equipment(
        id,venue_id,name,kind,area,quantity,status,load_mode,load_semantics,
        min_load_grams,max_load_grams,increment_grams,bar_weight_grams,unilateral,
        busy_level,settings_json,attachments_json,notes,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        row.id, row.venue_id, row.name, row.kind, row.area, row.quantity, row.status,
        row.load_mode, row.load_semantics, row.min_load_grams, row.max_load_grams,
        row.increment_grams, row.bar_weight_grams, Number(row.unilateral), row.busy_level,
        JSON.stringify(row.settings), JSON.stringify(row.attachments), row.notes,
        row.created_at, row.updated_at,
      ],
    };
  }

  function updateEquipment(row: FitnessEquipment): SqlStatement {
    return {
      sql: `UPDATE fitness_equipment SET venue_id=?,name=?,kind=?,area=?,quantity=?,
        status=?,load_mode=?,load_semantics=?,min_load_grams=?,max_load_grams=?,
        increment_grams=?,bar_weight_grams=?,unilateral=?,busy_level=?,settings_json=?,
        attachments_json=?,notes=?,updated_at=? WHERE id=?`,
      params: [
        row.venue_id, row.name, row.kind, row.area, row.quantity, row.status,
        row.load_mode, row.load_semantics, row.min_load_grams, row.max_load_grams,
        row.increment_grams, row.bar_weight_grams, Number(row.unilateral), row.busy_level,
        JSON.stringify(row.settings), JSON.stringify(row.attachments), row.notes,
        row.updated_at, row.id,
      ],
    };
  }

  function insertLoad(row: FitnessEquipmentLoad): SqlStatement {
    return {
      sql: `INSERT INTO fitness_equipment_loads(
        id,equipment_id,load_grams,quantity,label,available,created_at
      ) VALUES(?,?,?,?,?,?,?)`,
      params: [
        row.id, row.equipment_id, row.load_grams, row.quantity, row.label,
        Number(row.available), row.created_at,
      ],
    };
  }

  function insertConstraint(row: FitnessConstraint): SqlStatement {
    return {
      sql: `INSERT INTO fitness_constraints(
        id,label,body_area,severity,movement_patterns_json,exercise_ids_json,
        note,active,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      params: [
        row.id, row.label, row.body_area, row.severity,
        JSON.stringify(row.movement_patterns), JSON.stringify(row.exercise_ids),
        row.note, Number(row.active), row.created_at, row.updated_at,
      ],
    };
  }

  function updateConstraint(row: FitnessConstraint): SqlStatement {
    return {
      sql: `UPDATE fitness_constraints SET label=?,body_area=?,severity=?,
        movement_patterns_json=?,exercise_ids_json=?,note=?,active=?,updated_at=? WHERE id=?`,
      params: [
        row.label, row.body_area, row.severity, JSON.stringify(row.movement_patterns),
        JSON.stringify(row.exercise_ids), row.note, Number(row.active), row.updated_at, row.id,
      ],
    };
  }

  function receiptCasPredicate(receipt: FitnessConfigWriteReceipt): ConfigPredicate {
    switch (receipt.kind) {
      case "profile-save":
        return receipt.before
          ? profilePredicate(receipt.before)
          : absentPredicate("fitness_profiles", "profile");
      case "venue-save":
        return joinedPredicate([
          receipt.before
            ? venuePredicate(receipt.before)
            : absentPredicate("fitness_venues", receipt.after.id),
          ...(receipt.after.is_default
            ? [defaultSetPredicate(
                receipt.after.id,
                receipt.defaultResets.map(({ before }) => before),
              )]
            : []),
        ]);
      case "venue-archive":
        return joinedPredicate([
          venuePredicate(receipt.before),
          {
            sql: "NOT EXISTS(SELECT 1 FROM fitness_sessions WHERE venue_id=? AND status='active')",
            params: [receipt.before.id],
          },
          transitionSetPredicate(
            "fitness_programs",
            receipt.before.id,
            ["active", "draft"],
            receipt.programs.map(({ before }) => before),
          ),
          transitionSetPredicate(
            "fitness_calendar_events",
            receipt.before.id,
            ["planned"],
            receipt.events.map(({ before }) => before),
          ),
        ]);
      case "venue-restore":
        return venuePredicate(receipt.before);
      case "equipment-save":
        return joinedPredicate([
          receipt.before
            ? joinedPredicate([
                equipmentPredicate(receipt.before.equipment),
                loadSetPredicate(receipt.before.equipment.id, receipt.before.loads),
              ])
            : absentPredicate("fitness_equipment", receipt.after.equipment.id),
          {
            sql: `EXISTS(SELECT 1 FROM fitness_venues
              WHERE id=? AND status='active' AND updated_at=?)`,
            params: [receipt.venue.id, receipt.venue.updated_at],
          },
        ]);
      case "equipment-status":
        return equipmentPredicate(receipt.before);
      case "constraint-save":
        return receipt.before
          ? constraintPredicate(receipt.before)
          : absentPredicate("fitness_constraints", receipt.after.id);
      case "constraint-active":
        return constraintPredicate(receipt.before);
    }
  }

  function receiptStatements(receipt: FitnessConfigWriteReceipt): SqlStatement[] {
    const statements: SqlStatement[] = [configCasSentinel(receiptCasPredicate(receipt))];
    switch (receipt.kind) {
      case "profile-save":
        statements.push(receipt.before ? updateProfile(receipt.after) : insertProfile(receipt.after));
        break;
      case "venue-save":
        for (const reset of receipt.defaultResets) {
          statements.push({
            sql: "UPDATE fitness_venues SET is_default=0,updated_at=? WHERE id=?",
            params: [reset.after.updated_at, reset.after.id],
          });
        }
        statements.push(receipt.before ? updateVenue(receipt.after) : insertVenue(receipt.after));
        break;
      case "venue-archive":
        for (const program of receipt.programs) {
          statements.push({
            sql: "UPDATE fitness_programs SET status='archived',updated_at=? WHERE id=?",
            params: [program.after.updated_at, program.after.id],
          });
        }
        for (const event of receipt.events) {
          statements.push({
            sql: "UPDATE fitness_calendar_events SET status='cancelled',updated_at=? WHERE id=?",
            params: [event.after.updated_at, event.after.id],
          });
        }
        statements.push({
          sql: "UPDATE fitness_venues SET status='archived',is_default=0,updated_at=? WHERE id=?",
          params: [receipt.after.updated_at, receipt.after.id],
        });
        break;
      case "venue-restore":
        statements.push({
          sql: "UPDATE fitness_venues SET status='active',updated_at=? WHERE id=?",
          params: [receipt.after.updated_at, receipt.after.id],
        });
        break;
      case "equipment-save":
        statements.push(receipt.before
          ? updateEquipment(receipt.after.equipment)
          : insertEquipment(receipt.after.equipment));
        if (receipt.before) {
          statements.push({
            sql: "DELETE FROM fitness_equipment_loads WHERE equipment_id=?",
            params: [receipt.after.equipment.id],
          });
        }
        statements.push(...receipt.after.loads.map(insertLoad));
        break;
      case "equipment-status":
        statements.push({
          sql: "UPDATE fitness_equipment SET status=?,updated_at=? WHERE id=?",
          params: [receipt.after.status, receipt.after.updated_at, receipt.after.id],
        });
        break;
      case "constraint-save":
        statements.push(receipt.before
          ? updateConstraint(receipt.after)
          : insertConstraint(receipt.after));
        break;
      case "constraint-active":
        statements.push({
          sql: "UPDATE fitness_constraints SET active=?,updated_at=? WHERE id=?",
          params: [Number(receipt.after.active), receipt.after.updated_at, receipt.after.id],
        });
        break;
    }
    return statements;
  }

  async function inspectWrite(value: unknown): Promise<FitnessConfigWriteInspection> {
    if (!isFitnessConfigWriteReceipt(value)) return "invalid_receipt";
    try {
      if (!await receiptHashIsValid(value)) return "invalid_receipt";
    } catch {
      return "invalid_receipt";
    }
    try {
      return await runtime.withExclusiveLock(() => inspectReceiptUnlocked(runtime, value));
    } catch {
      return "still_unknown";
    }
  }

  async function commitWrite(value: unknown): Promise<FitnessConfigWriteResult> {
    if (!isFitnessConfigWriteReceipt(value)) {
      throw configError("invalid_receipt", "写入回执无效；没有改动任何资料。");
    }
    try {
      if (!await receiptHashIsValid(value)) {
        throw configError("invalid_receipt", "写入回执无效；没有改动任何资料。");
      }
    } catch (error) {
      if (error instanceof FitnessConfigMutationError) throw error;
      throw configError("invalid_receipt", "写入回执无法验证；没有改动任何资料。");
    }
    const receipt = value;
    const entity = receiptEntity(receipt);
    try {
      return await runtime.withExclusiveLock(async () => {
        const before = await inspectReceiptUnlocked(runtime, receipt);
        if (before === "exact_saved") {
          safeConfigBroadcast(runtime, entity.reason);
          return {
            outcome: "already_saved",
            receipt,
            entityId: entity.id,
            updatedAt: entity.updatedAt,
          };
        }
        if (before === "changed") {
          return { outcome: "changed", receipt, entityId: entity.id, retryable: false };
        }
        if (before === "still_unknown") {
          return {
            outcome: "outcome_uncertain",
            receipt,
            entityId: entity.id,
            retryable: true,
          };
        }
        try {
          await runtime.batch(receiptStatements(receipt));
        } catch {
          // The transaction may have committed even though its response was lost.
        }
        const after = await inspectReceiptUnlocked(runtime, receipt);
        if (after === "exact_saved") {
          safeConfigBroadcast(runtime, entity.reason);
          return {
            outcome: "saved",
            receipt,
            entityId: entity.id,
            updatedAt: entity.updatedAt,
          };
        }
        if (after === "expected") {
          throw configError(
            "write_failed",
            "这次资料确定没有写入；保留当前内容后可以重试。",
            receipt,
          );
        }
        if (after === "changed") {
          return { outcome: "changed", receipt, entityId: entity.id, retryable: false };
        }
        return {
          outcome: "outcome_uncertain",
          receipt,
          entityId: entity.id,
          retryable: true,
        };
      });
    } catch (error) {
      if (error instanceof FitnessConfigMutationError) throw error;
      return {
        outcome: "outcome_uncertain",
        receipt,
        entityId: entity.id,
        retryable: true,
      };
    }
  }

  return {
    prepareFitnessProfileSave: prepareProfileSave,
    prepareFitnessVenueSave: prepareVenueSave,
    prepareFitnessVenueArchive: prepareVenueArchive,
    prepareFitnessVenueRestore: prepareVenueRestore,
    prepareFitnessEquipmentSave: prepareEquipmentSave,
    prepareFitnessEquipmentStatus: prepareEquipmentStatus,
    prepareFitnessConstraintSave: prepareConstraintSave,
    prepareFitnessConstraintActive: prepareConstraintActive,
    inspectFitnessConfigWrite: inspectWrite,
    commitFitnessConfigWrite: commitWrite,
  } as const;
}

const defaultFitnessConfigStorageService = createFitnessConfigStorageService();

export const prepareFitnessProfileSave =
  defaultFitnessConfigStorageService.prepareFitnessProfileSave;
export const prepareFitnessVenueSave =
  defaultFitnessConfigStorageService.prepareFitnessVenueSave;
export const prepareFitnessVenueArchive =
  defaultFitnessConfigStorageService.prepareFitnessVenueArchive;
export const prepareFitnessVenueRestore =
  defaultFitnessConfigStorageService.prepareFitnessVenueRestore;
export const prepareFitnessEquipmentSave =
  defaultFitnessConfigStorageService.prepareFitnessEquipmentSave;
export const prepareFitnessEquipmentStatus =
  defaultFitnessConfigStorageService.prepareFitnessEquipmentStatus;
export const prepareFitnessConstraintSave =
  defaultFitnessConfigStorageService.prepareFitnessConstraintSave;
export const prepareFitnessConstraintActive =
  defaultFitnessConfigStorageService.prepareFitnessConstraintActive;
export const inspectFitnessConfigWrite =
  defaultFitnessConfigStorageService.inspectFitnessConfigWrite;
export const commitFitnessConfigWrite =
  defaultFitnessConfigStorageService.commitFitnessConfigWrite;

export type FitnessLiveSetSnapshot = Readonly<{
  id: string;
  session_exercise_id: string;
  set_index: number;
  set_kind: FitnessSet["set_kind"];
  load_grams: number | null;
  reps: number | null;
  duration_seconds: number | null;
  rir: number | null;
  rpe: number | null;
  completed: boolean;
  pain_note: string;
  completed_at: number | null;
  client_mutation_id: string;
  created_at: number;
  updated_at: number;
}>;

export type FitnessLiveExerciseExpectation = Readonly<{
  session: FitnessSession;
  exercise: FitnessSessionExercise;
  sets: readonly FitnessSet[];
  nextSetIndex: number;
}>;

export type FitnessLiveSessionExpectation = Readonly<{
  session: FitnessSession;
  exercises: readonly FitnessSessionExercise[];
  sets: readonly FitnessSet[];
  cardioEntries: readonly FitnessCardioEntry[];
  event: FitnessCalendarEvent | null;
  capabilities: readonly FitnessCapability[];
}>;

export type FitnessLiveExerciseProjection = Readonly<{
  session: FitnessSession;
  exercise: FitnessSessionExercise;
  sets: readonly FitnessLiveSetSnapshot[];
}>;

export type FitnessLiveSessionProjection = Readonly<{
  session: FitnessSession | null;
  exercises: readonly FitnessSessionExercise[];
  sets: readonly FitnessLiveSetSnapshot[];
  cardioEntries: readonly FitnessCardioEntry[];
  event: FitnessCalendarEvent | null;
  capabilities: readonly FitnessCapability[];
}>;

type FitnessLiveReceiptBase<Kind extends string> = Readonly<{
  purpose: "fitness-live-write";
  version: 1;
  operationId: string;
  generationId: string;
  generationSequence: number;
  preparedAt: number;
  kind: Kind;
  projectionSha256: string;
}>;

export type FitnessSetRecordReceipt = FitnessLiveReceiptBase<"set-record"> & Readonly<{
  before: FitnessLiveExerciseProjection;
  after: FitnessLiveExerciseProjection;
}>;

export type FitnessSetUndoReceipt = FitnessLiveReceiptBase<"set-undo"> & Readonly<{
  before: FitnessLiveExerciseProjection;
  after: FitnessLiveExerciseProjection;
}>;

export type FitnessSessionFinishReceipt = FitnessLiveReceiptBase<"session-finish"> & Readonly<{
  before: FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>;
  after: FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>;
}>;

export type FitnessEmptySessionCancelReceipt = FitnessLiveReceiptBase<"session-cancel"> & Readonly<{
  before: FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>;
  after: FitnessLiveSessionProjection & Readonly<{ session: null }>;
}>;

export type FitnessLiveWriteReceipt =
  | FitnessSetRecordReceipt
  | FitnessSetUndoReceipt
  | FitnessSessionFinishReceipt
  | FitnessEmptySessionCancelReceipt;

export type FitnessLiveWriteInspection =
  | "exact_saved"
  | "expected"
  | "changed"
  | "still_unknown"
  | "invalid_receipt";

export type FitnessLiveWriteResult =
  | Readonly<{
      outcome: "saved" | "already_saved";
      receipt: FitnessLiveWriteReceipt;
      entityId: string;
      updatedAt: number;
    }>
  | Readonly<{
      outcome: "changed";
      receipt: FitnessLiveWriteReceipt;
      entityId: string;
      retryable: false;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      receipt: FitnessLiveWriteReceipt;
      entityId: string;
      retryable: true;
    }>;

export type FitnessLiveMutationErrorCode =
  | "invalid_input"
  | "invalid_receipt"
  | "changed"
  | "inspect_failed"
  | "write_failed";

export class FitnessLiveMutationError extends Error {
  readonly name = "FitnessLiveMutationError";

  constructor(
    readonly code: FitnessLiveMutationErrorCode,
    message: string,
    readonly receipt?: FitnessLiveWriteReceipt,
  ) {
    super(message);
  }
}

export type FitnessLiveStorageRuntime = FitnessConfigStorageRuntime;

const LIVE_OPERATION_ID_PATTERN =
  /^fitness-live-operation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIVE_SET_ID_PATTERN =
  /^set-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIVE_MUTATION_ID_PATTERN =
  /^fitness-live-mutation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIVE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIVE_MAX_ATOMIC_ROWS = 500;
const LIVE_MAX_RECEIPT_JSON_UNITS = 1_000_000;
const LIVE_MAX_EXPECTATION_JSON_UNITS = 500_000;

function jsonWithinUnits(value: unknown, maximum: number): boolean {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" && encoded.length <= maximum;
  } catch {
    return false;
  }
}

function liveError(
  code: FitnessLiveMutationErrorCode,
  message: string,
  receipt?: FitnessLiveWriteReceipt,
): FitnessLiveMutationError {
  return new FitnessLiveMutationError(code, message, receipt);
}

function snapshotLiveInput<Input>(value: Input): Input {
  try {
    return JSON.parse(JSON.stringify(value)) as Input;
  } catch {
    throw liveError("invalid_input", "训练写入内容不能安全复制。");
  }
}

function compareLiveId(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function sortedByIndexAndId<Value extends { set_index: number; id: string }>(
  rows: readonly Value[],
): Value[] {
  return [...rows].sort((left, right) =>
    left.set_index - right.set_index || compareLiveId(left.id, right.id)
  );
}

function sortedExercises(rows: readonly FitnessSessionExercise[]): FitnessSessionExercise[] {
  return [...rows].sort((left, right) =>
    left.order_index - right.order_index || compareLiveId(left.id, right.id)
  );
}

function sortedCardio(rows: readonly FitnessCardioEntry[]): FitnessCardioEntry[] {
  return [...rows].sort((left, right) => left.created_at - right.created_at ||
    compareLiveId(left.id, right.id));
}

function sortedCapabilities(rows: readonly FitnessCapability[]): FitnessCapability[] {
  return [...rows].sort((left, right) => left.recorded_at - right.recorded_at ||
    compareLiveId(left.id, right.id));
}

function publicLiveSet(row: FitnessLiveSetSnapshot): FitnessSet {
  return {
    id: row.id,
    session_exercise_id: row.session_exercise_id,
    set_index: row.set_index,
    set_kind: row.set_kind,
    load_grams: row.load_grams,
    reps: row.reps,
    duration_seconds: row.duration_seconds,
    rir: row.rir,
    rpe: row.rpe,
    completed: row.completed,
    pain_note: row.pain_note,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function fitnessLiveExerciseExpectationFromSnapshot(
  snapshot: FitnessSnapshot,
  sessionExerciseId: string,
): FitnessLiveExerciseExpectation {
  const exercise = snapshot.sessionExercises.find(({ id }) => id === sessionExerciseId);
  if (!exercise) throw liveError("invalid_input", "当前动作不在这份训练画面里。");
  const session = snapshot.sessions.find(({ id }) => id === exercise.session_id);
  if (!session) throw liveError("invalid_input", "当前训练不在这份训练画面里。");
  const sets = sortedByIndexAndId(snapshot.sets.filter(
    ({ session_exercise_id }) => session_exercise_id === exercise.id,
  ));
  const nextSetIndex = sets.reduce(
    (maximum, set) => Math.max(maximum, set.set_index + 1),
    0,
  );
  return snapshotLiveInput({ session, exercise, sets, nextSetIndex });
}

export function fitnessLiveSessionExpectationFromSnapshot(
  snapshot: FitnessSnapshot,
  sessionId: string,
): FitnessLiveSessionExpectation {
  const session = snapshot.sessions.find(({ id }) => id === sessionId);
  if (!session) throw liveError("invalid_input", "当前训练不在这份训练画面里。");
  const exercises = sortedExercises(snapshot.sessionExercises.filter(
    ({ session_id }) => session_id === session.id,
  ));
  const exerciseIds = new Set(exercises.map(({ id }) => id));
  const sets = sortedByIndexAndId(snapshot.sets.filter(
    ({ session_exercise_id }) => exerciseIds.has(session_exercise_id),
  ));
  const setIds = new Set(sets.map(({ id }) => id));
  const cardioEntries = sortedCardio(snapshot.cardioEntries.filter(
    ({ session_id }) => session_id === session.id,
  ));
  const event = session.event_id === null
    ? null
    : snapshot.events.find(({ id }) => id === session.event_id) ?? null;
  const capabilities = sortedCapabilities(snapshot.capabilities.filter(({ source_set_id }) =>
    source_set_id !== null && setIds.has(source_set_id)
  ));
  return snapshotLiveInput({ session, exercises, sets, cardioEntries, event, capabilities });
}

function liveInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= minimum && value <= maximum;
}

function liveNullableInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number | null {
  return value === null || liveInteger(value, minimum, maximum);
}

function isFitnessLiveSession(value: unknown): value is FitnessSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FitnessSession>;
  return exactObjectKeys(value, [
    "id", "event_id", "venue_id", "program_day_id", "started_at", "ended_at",
    "status", "available_minutes", "energy_note", "soreness_note", "reflection",
    "created_at", "updated_at",
  ]) && safeOpaqueId(row.id) && (row.event_id === null || safeOpaqueId(row.event_id)) &&
    safeOpaqueId(row.venue_id) &&
    (row.program_day_id === null || safeOpaqueId(row.program_day_id)) &&
    safeTimestamp(row.started_at) && liveNullableInteger(row.ended_at, 0, Number.MAX_SAFE_INTEGER) &&
    (row.ended_at === null || row.ended_at >= row.started_at) &&
    ["active", "completed", "ended_early"].includes(String(row.status)) &&
    (row.available_minutes === null || liveInteger(row.available_minutes, 1, 1_440)) &&
    ["", "lower", "usual", "higher"].includes(String(row.energy_note)) &&
    safeString(row.soreness_note, 20_000) && safeString(row.reflection, 20_000) &&
    safeTimestamp(row.created_at) && safeTimestamp(row.updated_at) &&
    row.updated_at >= row.created_at;
}

function isFitnessLiveExercise(value: unknown): value is FitnessSessionExercise {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FitnessSessionExercise>;
  return exactObjectKeys(value, [
    "id", "session_id", "exercise_id", "equipment_id", "planned_item_id",
    "order_index", "status", "substituted_for_exercise_id", "substitution_reason",
    "equipment_snapshot", "note", "created_at", "updated_at",
  ]) && safeOpaqueId(row.id) && safeOpaqueId(row.session_id) &&
    safeOpaqueId(row.exercise_id) &&
    (row.equipment_id === null || safeOpaqueId(row.equipment_id)) &&
    (row.planned_item_id === null || safeOpaqueId(row.planned_item_id)) &&
    liveInteger(row.order_index, 0, 100_000) &&
    ["pending", "active", "completed", "skipped", "substituted"].includes(String(row.status)) &&
    (row.substituted_for_exercise_id === null || safeOpaqueId(row.substituted_for_exercise_id)) &&
    safeString(row.substitution_reason, 10_000) && safeString(row.equipment_snapshot, 100_000) &&
    safeString(row.note, 10_000) && safeTimestamp(row.created_at) && safeTimestamp(row.updated_at) &&
    row.updated_at >= row.created_at;
}

function isFitnessLiveSet(
  value: unknown,
  includeMutationId: boolean,
): value is FitnessLiveSetSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FitnessLiveSetSnapshot>;
  const keys = [
    "id", "session_exercise_id", "set_index", "set_kind", "load_grams", "reps",
    "duration_seconds", "rir", "rpe", "completed", "pain_note", "completed_at",
    ...(includeMutationId ? ["client_mutation_id"] : []), "created_at", "updated_at",
  ];
  return exactObjectKeys(value, keys) && safeOpaqueId(row.id) &&
    safeOpaqueId(row.session_exercise_id) && liveInteger(row.set_index, 0, 100_000) &&
    ["warmup", "work", "drop", "amrap"].includes(String(row.set_kind)) &&
    liveNullableInteger(row.load_grams, 0, 10_000_000) &&
    liveNullableInteger(row.reps, 0, 10_000) &&
    liveNullableInteger(row.duration_seconds, 0, 86_400) &&
    liveNullableInteger(row.rir, 0, 5) && liveNullableInteger(row.rpe, 1, 10) &&
    (row.reps !== null || row.duration_seconds !== null) &&
    typeof row.completed === "boolean" && safeString(row.pain_note, 10_000) &&
    liveNullableInteger(row.completed_at, 0, Number.MAX_SAFE_INTEGER) &&
    (!includeMutationId || (
      typeof row.client_mutation_id === "string" && row.client_mutation_id.length >= 1 &&
      row.client_mutation_id.length <= 160 && row.client_mutation_id === row.client_mutation_id.trim()
    )) && safeTimestamp(row.created_at) && safeTimestamp(row.updated_at) &&
    row.updated_at >= row.created_at;
}

function isFitnessLiveCardio(value: unknown): value is FitnessCardioEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FitnessCardioEntry>;
  return exactObjectKeys(value, [
    "id", "session_id", "equipment_id", "mode", "duration_seconds", "distance_meters",
    "resistance", "average_heart_rate", "effort", "note", "created_at",
  ]) && safeOpaqueId(row.id) && safeOpaqueId(row.session_id) &&
    (row.equipment_id === null || safeOpaqueId(row.equipment_id)) &&
    safeString(row.mode, 10_000) && liveInteger(row.duration_seconds, 1, 86_400) &&
    liveNullableInteger(row.distance_meters, 0, Number.MAX_SAFE_INTEGER) &&
    safeString(row.resistance, 10_000) &&
    liveNullableInteger(row.average_heart_rate, 20, 260) &&
    ["", "easy", "moderate", "hard"].includes(String(row.effort)) &&
    safeString(row.note, 10_000) && safeTimestamp(row.created_at);
}

function isFitnessLiveEvent(value: unknown): value is FitnessCalendarEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FitnessCalendarEvent>;
  return exactObjectKeys(value, [
    "id", "program_day_id", "venue_id", "title", "kind", "starts_at",
    "occurrence_key", "planned_minutes", "status", "rescheduled_from_id", "note",
    "created_at", "updated_at",
  ]) && safeOpaqueId(row.id) &&
    (row.program_day_id === null || safeOpaqueId(row.program_day_id)) &&
    (row.venue_id === null || safeOpaqueId(row.venue_id)) && safeString(row.title, 10_000) &&
    ["resistance", "cardio", "rest", "note"].includes(String(row.kind)) &&
    safeTimestamp(row.starts_at) &&
    (row.occurrence_key === null || safeString(row.occurrence_key, 100)) &&
    liveInteger(row.planned_minutes, 0, 1_440) &&
    ["planned", "in_progress", "completed", "not_performed", "cancelled"].includes(String(row.status)) &&
    (row.rescheduled_from_id === null || safeOpaqueId(row.rescheduled_from_id)) &&
    safeString(row.note, 10_000) && safeTimestamp(row.created_at) && safeTimestamp(row.updated_at) &&
    row.updated_at >= row.created_at;
}

function isFitnessLiveCapability(value: unknown): value is FitnessCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FitnessCapability>;
  return exactObjectKeys(value, [
    "id", "exercise_id", "equipment_id", "source_set_id", "load_grams", "reps",
    "rir", "rpe", "confidence", "recorded_at", "created_at",
  ]) && safeOpaqueId(row.id) && safeOpaqueId(row.exercise_id) &&
    (row.equipment_id === null || safeOpaqueId(row.equipment_id)) &&
    (row.source_set_id === null || safeOpaqueId(row.source_set_id)) &&
    liveNullableInteger(row.load_grams, 0, 10_000_000) &&
    liveNullableInteger(row.reps, 0, 10_000) && liveNullableInteger(row.rir, 0, 5) &&
    liveNullableInteger(row.rpe, 1, 10) &&
    (row.confidence === "observed" || row.confidence === "user_entered") &&
    safeTimestamp(row.recorded_at) && safeTimestamp(row.created_at);
}

function uniqueIds(rows: readonly { id: string }[]): boolean {
  return new Set(rows.map(({ id }) => id)).size === rows.length;
}

function isSortedProjection<Value>(
  rows: readonly Value[],
  sorter: (values: readonly Value[]) => readonly Value[],
): boolean {
  return sameProjection(rows, sorter(rows));
}

function isLiveExerciseProjection(value: unknown): value is FitnessLiveExerciseProjection {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !exactObjectKeys(value, ["session", "exercise", "sets"])) return false;
  const projection = value as Partial<FitnessLiveExerciseProjection>;
  return isFitnessLiveSession(projection.session) && isFitnessLiveExercise(projection.exercise) &&
    projection.exercise.session_id === projection.session.id &&
    Array.isArray(projection.sets) && projection.sets.length <= LIVE_MAX_ATOMIC_ROWS &&
    projection.sets.every((set) => isFitnessLiveSet(set, true) &&
      set.session_exercise_id === projection.exercise?.id) &&
    uniqueIds(projection.sets) &&
    new Set(projection.sets.map(({ set_index }) => set_index)).size === projection.sets.length &&
    new Set(projection.sets.map(({ client_mutation_id }) => client_mutation_id)).size ===
      projection.sets.length && isSortedProjection(projection.sets, sortedByIndexAndId);
}

function isLiveSessionProjection(value: unknown): value is FitnessLiveSessionProjection {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactObjectKeys(value, [
    "session", "exercises", "sets", "cardioEntries", "event", "capabilities",
  ])) return false;
  const projection = value as Partial<FitnessLiveSessionProjection>;
  if (!(projection.session === null || isFitnessLiveSession(projection.session)) ||
      !Array.isArray(projection.exercises) || !Array.isArray(projection.sets) ||
      !Array.isArray(projection.cardioEntries) || !Array.isArray(projection.capabilities) ||
      !(projection.event === null || isFitnessLiveEvent(projection.event))) return false;
  const total = projection.exercises.length + projection.sets.length +
    projection.cardioEntries.length + projection.capabilities.length;
  if (total > LIVE_MAX_ATOMIC_ROWS || !uniqueIds(projection.exercises) ||
      !uniqueIds(projection.sets) || !uniqueIds(projection.cardioEntries) ||
      !uniqueIds(projection.capabilities) ||
      !projection.exercises.every(isFitnessLiveExercise) ||
      !projection.sets.every((set) => isFitnessLiveSet(set, true)) ||
      !projection.cardioEntries.every(isFitnessLiveCardio) ||
      !projection.capabilities.every(isFitnessLiveCapability) ||
      !isSortedProjection(projection.exercises, sortedExercises) ||
      !isSortedProjection(projection.sets, sortedByIndexAndId) ||
      !isSortedProjection(projection.cardioEntries, sortedCardio) ||
      !isSortedProjection(projection.capabilities, sortedCapabilities)) return false;
  if (projection.session === null) {
    return projection.exercises.length === 0 && projection.sets.length === 0 &&
      projection.cardioEntries.length === 0 && projection.capabilities.length === 0;
  }
  const exerciseIds = new Set(projection.exercises.map(({ id }) => id));
  const setIds = new Set(projection.sets.map(({ id }) => id));
  return projection.exercises.every(({ session_id }) => session_id === projection.session?.id) &&
    projection.sets.every(({ session_exercise_id }) => exerciseIds.has(session_exercise_id)) &&
    projection.cardioEntries.every(({ session_id }) => session_id === projection.session?.id) &&
    projection.capabilities.every(({ source_set_id }) =>
      source_set_id !== null && setIds.has(source_set_id)) &&
    (projection.session.event_id === null
      ? projection.event === null
      : projection.event?.id === projection.session.event_id);
}

function isLiveExerciseExpectation(value: unknown): value is FitnessLiveExerciseExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !jsonWithinUnits(value, LIVE_MAX_EXPECTATION_JSON_UNITS) ||
      !exactObjectKeys(value, ["session", "exercise", "sets", "nextSetIndex"])) return false;
  const expected = value as Partial<FitnessLiveExerciseExpectation>;
  if (!isFitnessLiveSession(expected.session) || !isFitnessLiveExercise(expected.exercise) ||
      expected.exercise.session_id !== expected.session.id || !Array.isArray(expected.sets) ||
      expected.sets.length > LIVE_MAX_ATOMIC_ROWS ||
      !expected.sets.every((set) => isFitnessLiveSet(set, false) &&
        set.session_exercise_id === expected.exercise?.id) || !uniqueIds(expected.sets) ||
      new Set(expected.sets.map(({ set_index }) => set_index)).size !== expected.sets.length ||
      !isSortedProjection(expected.sets, sortedByIndexAndId) ||
      !liveInteger(expected.nextSetIndex, 0, 100_000)) return false;
  const actualNext = expected.sets.reduce(
    (maximum, set) => Math.max(maximum, set.set_index + 1),
    0,
  );
  return expected.nextSetIndex === actualNext;
}

function isLiveSessionExpectation(value: unknown): value is FitnessLiveSessionExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !jsonWithinUnits(value, LIVE_MAX_EXPECTATION_JSON_UNITS) || !exactObjectKeys(value, [
    "session", "exercises", "sets", "cardioEntries", "event", "capabilities",
  ])) return false;
  const expected = value as Partial<FitnessLiveSessionExpectation>;
  if (!isFitnessLiveSession(expected.session) || !Array.isArray(expected.exercises) ||
      !Array.isArray(expected.sets) || !Array.isArray(expected.cardioEntries) ||
      !Array.isArray(expected.capabilities) ||
      !(expected.event === null || isFitnessLiveEvent(expected.event))) return false;
  const total = expected.exercises.length + expected.sets.length +
    expected.cardioEntries.length + expected.capabilities.length;
  if (total > LIVE_MAX_ATOMIC_ROWS || !uniqueIds(expected.exercises) ||
      !uniqueIds(expected.sets) || !uniqueIds(expected.cardioEntries) ||
      !uniqueIds(expected.capabilities) ||
      !expected.exercises.every((exercise) => isFitnessLiveExercise(exercise) &&
        exercise.session_id === expected.session?.id) ||
      !expected.sets.every((set) => isFitnessLiveSet(set, false)) ||
      !expected.cardioEntries.every((entry) => isFitnessLiveCardio(entry) &&
        entry.session_id === expected.session?.id) ||
      !expected.capabilities.every(isFitnessLiveCapability) ||
      !isSortedProjection(expected.exercises, sortedExercises) ||
      !isSortedProjection(expected.sets, sortedByIndexAndId) ||
      !isSortedProjection(expected.cardioEntries, sortedCardio) ||
      !isSortedProjection(expected.capabilities, sortedCapabilities)) return false;
  const exerciseIds = new Set(expected.exercises.map(({ id }) => id));
  const setIds = new Set(expected.sets.map(({ id }) => id));
  return expected.sets.every(({ session_exercise_id }) => exerciseIds.has(session_exercise_id)) &&
    expected.capabilities.every(({ source_set_id }) =>
      source_set_id !== null && setIds.has(source_set_id)) &&
    (expected.session.event_id === null
      ? expected.event === null
      : expected.event?.id === expected.session.event_id);
}

function sameLiveExerciseCore(
  before: FitnessLiveExerciseProjection,
  after: FitnessLiveExerciseProjection,
  preparedAt: number,
): boolean {
  return sameProjection(after.session, { ...before.session, updated_at: preparedAt }) &&
    sameProjection(after.exercise, {
      ...before.exercise,
      status: "active",
      updated_at: preparedAt,
    });
}

function exerciseProjectionVersions(projection: FitnessLiveExerciseProjection): number[] {
  return [
    projection.session.created_at,
    projection.session.started_at,
    projection.session.updated_at,
    projection.exercise.created_at,
    projection.exercise.updated_at,
    ...projection.sets.flatMap(({ created_at, updated_at, completed_at }) =>
      completed_at === null ? [created_at, updated_at] : [created_at, updated_at, completed_at]
    ),
  ];
}

function sessionProjectionVersions(
  projection: FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>,
): number[] {
  return [
    projection.session.created_at,
    projection.session.started_at,
    projection.session.updated_at,
    ...projection.exercises.flatMap(({ created_at, updated_at }) => [created_at, updated_at]),
    ...projection.sets.flatMap(({ created_at, updated_at, completed_at }) =>
      completed_at === null ? [created_at, updated_at] : [created_at, updated_at, completed_at]
    ),
    ...projection.cardioEntries.map(({ created_at }) => created_at),
    ...projection.capabilities.flatMap(({ created_at, recorded_at }) => [created_at, recorded_at]),
    ...(projection.event === null
      ? []
      : [projection.event.created_at, projection.event.updated_at]),
  ];
}

function strictlyAfterEvery(value: number, versions: readonly number[]): boolean {
  return versions.every((version) => value > version);
}

function isRecordTransition(receipt: FitnessSetRecordReceipt): boolean {
  const { before, after, preparedAt } = receipt;
  if (!isLiveExerciseProjection(before) || !isLiveExerciseProjection(after) ||
      before.session.status !== "active" || !sameLiveExerciseCore(before, after, preparedAt) ||
      !strictlyAfterEvery(preparedAt, exerciseProjectionVersions(before)) ||
      after.sets.length !== before.sets.length + 1) return false;
  const beforeById = new Map(before.sets.map((set) => [set.id, set]));
  const added = after.sets.filter(({ id }) => !beforeById.has(id));
  if (added.length !== 1 || !before.sets.every((set) =>
    sameProjection(after.sets.find(({ id }) => id === set.id), set)
  )) return false;
  const set = added[0]!;
  return LIVE_SET_ID_PATTERN.test(set.id) &&
    LIVE_MUTATION_ID_PATTERN.test(set.client_mutation_id) && set.completed &&
    set.created_at === preparedAt && set.updated_at === preparedAt &&
    set.completed_at === preparedAt &&
    !before.sets.some(({ set_index }) => set_index === set.set_index) &&
    !before.sets.some(({ client_mutation_id }) =>
      client_mutation_id === set.client_mutation_id);
}

function isUndoTransition(receipt: FitnessSetUndoReceipt): boolean {
  const { before, after, preparedAt } = receipt;
  if (!isLiveExerciseProjection(before) || !isLiveExerciseProjection(after) ||
      before.session.status !== "active" || !sameLiveExerciseCore(before, after, preparedAt) ||
      !strictlyAfterEvery(preparedAt, exerciseProjectionVersions(before)) ||
      after.sets.length !== before.sets.length - 1) return false;
  const afterById = new Map(after.sets.map((set) => [set.id, set]));
  const removed = before.sets.filter(({ id }) => !afterById.has(id));
  return removed.length === 1 && after.sets.every((set) =>
    sameProjection(before.sets.find(({ id }) => id === set.id), set)
  );
}

function transformedFinishedExercise(
  exercise: FitnessSessionExercise,
  sets: readonly FitnessLiveSetSnapshot[],
  preparedAt: number,
): FitnessSessionExercise {
  if (!["pending", "active", "substituted"].includes(exercise.status)) return exercise;
  return {
    ...exercise,
    status: sets.some((set) =>
      set.session_exercise_id === exercise.id && set.completed
    ) ? "completed" : "skipped",
    updated_at: preparedAt,
  };
}

function isFinishTransition(receipt: FitnessSessionFinishReceipt): boolean {
  const { before, after, preparedAt } = receipt;
  if (!isLiveSessionProjection(before) || !isLiveSessionProjection(after) ||
      before.session === null || after.session === null || before.session.status !== "active" ||
      !["completed", "ended_early"].includes(after.session.status) ||
      after.session.ended_at !== preparedAt || after.session.updated_at !== preparedAt ||
      !strictlyAfterEvery(preparedAt, sessionProjectionVersions(before)) ||
      !sameProjection(after.session, {
        ...before.session,
        status: after.session.status,
        ended_at: preparedAt,
        reflection: after.session.reflection,
        updated_at: preparedAt,
      }) || !sameProjection(after.sets, before.sets) ||
      !sameProjection(after.cardioEntries, before.cardioEntries) ||
      !sameProjection(after.exercises, sortedExercises(before.exercises.map((exercise) =>
        transformedFinishedExercise(exercise, before.sets, preparedAt)
      )))) return false;
  if (before.event === null) {
    if (after.event !== null) return false;
  } else if (
    before.event.status !== "in_progress" || after.event === null ||
    preparedAt <= before.event.updated_at ||
    !sameProjection(after.event, {
      ...before.event,
      status: "completed",
      updated_at: preparedAt,
    })
  ) return false;

  const beforeBySource = new Map(before.capabilities.map((capability) =>
    [capability.source_set_id, capability]
  ));
  const expected = [...before.capabilities];
  const exercises = new Map(before.exercises.map((exercise) => [exercise.id, exercise]));
  for (const set of before.sets) {
    if (!set.completed || set.set_kind !== "work" || set.pain_note !== "" ||
        set.completed_at === null || (set.reps === null && set.load_grams === null) ||
        beforeBySource.has(set.id)) continue;
    const exercise = exercises.get(set.session_exercise_id);
    const capability = after.capabilities.find(({ source_set_id }) => source_set_id === set.id);
    if (!exercise || !capability || !LIVE_UUID_PATTERN.test(capability.id) ||
        !sameProjection(capability, {
          id: capability.id,
          exercise_id: exercise.exercise_id,
          equipment_id: exercise.equipment_id,
          source_set_id: set.id,
          load_grams: set.load_grams,
          reps: set.reps,
          rir: set.rir,
          rpe: set.rpe,
          confidence: "observed",
          recorded_at: set.completed_at,
          created_at: preparedAt,
        })) return false;
    expected.push(capability);
  }
  return sameProjection(after.capabilities, sortedCapabilities(expected));
}

function isCancelTransition(receipt: FitnessEmptySessionCancelReceipt): boolean {
  const { before, after, preparedAt } = receipt;
  if (!isLiveSessionProjection(before) || !isLiveSessionProjection(after) ||
      before.session === null || after.session !== null || before.session.status !== "active" ||
      before.sets.length !== 0 || before.cardioEntries.length !== 0 ||
      before.capabilities.length !== 0 ||
      !strictlyAfterEvery(preparedAt, sessionProjectionVersions(before)) ||
      after.exercises.length !== 0 ||
      after.sets.length !== 0 || after.cardioEntries.length !== 0 ||
      after.capabilities.length !== 0) return false;
  if (before.event === null) return after.event === null;
  return before.event.status === "in_progress" && after.event !== null &&
    preparedAt > before.event.updated_at && sameProjection(after.event, {
      ...before.event,
      status: "planned",
      updated_at: preparedAt,
    });
}

function hasValidLiveReceiptBase(
  value: object,
  kind: FitnessLiveWriteReceipt["kind"],
): boolean {
  const receipt = value as Partial<FitnessLiveWriteReceipt>;
  return exactObjectKeys(value, [
    "purpose", "version", "operationId", "generationId", "generationSequence",
    "preparedAt", "kind", "projectionSha256", "before", "after",
  ]) && receipt.purpose === "fitness-live-write" && receipt.version === 1 &&
    receipt.kind === kind && typeof receipt.operationId === "string" &&
    LIVE_OPERATION_ID_PATTERN.test(receipt.operationId) &&
    typeof receipt.generationId === "string" &&
    CONFIG_GENERATION_ID_PATTERN.test(receipt.generationId) &&
    liveInteger(receipt.generationSequence, 0, Number.MAX_SAFE_INTEGER) &&
    liveInteger(receipt.preparedAt, 0, Number.MAX_SAFE_INTEGER) &&
    typeof receipt.projectionSha256 === "string" &&
    CONFIG_HASH_PATTERN.test(receipt.projectionSha256);
}

function isFitnessLiveWriteReceiptUnchecked(value: unknown): value is FitnessLiveWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !jsonWithinUnits(value, LIVE_MAX_RECEIPT_JSON_UNITS)) return false;
  const receipt = value as Partial<FitnessLiveWriteReceipt>;
  switch (receipt.kind) {
    case "set-record":
      return hasValidLiveReceiptBase(value, receipt.kind) &&
        isRecordTransition(receipt as FitnessSetRecordReceipt);
    case "set-undo":
      return hasValidLiveReceiptBase(value, receipt.kind) &&
        isUndoTransition(receipt as FitnessSetUndoReceipt);
    case "session-finish":
      return hasValidLiveReceiptBase(value, receipt.kind) &&
        isFinishTransition(receipt as FitnessSessionFinishReceipt);
    case "session-cancel":
      return hasValidLiveReceiptBase(value, receipt.kind) &&
        isCancelTransition(receipt as FitnessEmptySessionCancelReceipt);
    default:
      return false;
  }
}

export function isFitnessLiveWriteReceipt(value: unknown): value is FitnessLiveWriteReceipt {
  try {
    return isFitnessLiveWriteReceiptUnchecked(value);
  } catch {
    return false;
  }
}

async function sealLiveReceipt<Receipt extends FitnessLiveWriteReceipt>(
  draft: Omit<Receipt, "projectionSha256">,
): Promise<Receipt> {
  const projectionSha256 = await sha256Hex(canonicalJson(draft));
  return { ...draft, projectionSha256 } as Receipt;
}

async function liveReceiptHashIsValid(receipt: FitnessLiveWriteReceipt): Promise<boolean> {
  const { projectionSha256, ...projection } = receipt;
  return projectionSha256 === await sha256Hex(canonicalJson(projection));
}

function mapLiveSet(row: Row): FitnessLiveSetSnapshot {
  return {
    id: String(row.id),
    session_exercise_id: String(row.session_exercise_id),
    set_index: Number(row.set_index),
    set_kind: String(row.set_kind) as FitnessSet["set_kind"],
    load_grams: row.load_grams === null ? null : Number(row.load_grams),
    reps: row.reps === null ? null : Number(row.reps),
    duration_seconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    rir: row.rir === null ? null : Number(row.rir),
    rpe: row.rpe === null ? null : Number(row.rpe),
    completed: asBoolean(row.completed),
    pain_note: String(row.pain_note),
    completed_at: row.completed_at === null ? null : Number(row.completed_at),
    client_mutation_id: String(row.client_mutation_id),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

async function liveRows<Result extends object>(
  runtime: FitnessLiveStorageRuntime,
  sql: string,
  params: SqlParams = [],
): Promise<readonly Result[]> {
  return (await runtime.query<Result>(sql, params)).rows;
}

async function readLiveSession(
  runtime: FitnessLiveStorageRuntime,
  id: string,
): Promise<FitnessSession | null> {
  return (await liveRows<FitnessSession>(
    runtime,
    "SELECT * FROM fitness_sessions WHERE id=? LIMIT 1",
    [id],
  ))[0] ?? null;
}

async function readLiveExercise(
  runtime: FitnessLiveStorageRuntime,
  id: string,
): Promise<FitnessSessionExercise | null> {
  return (await liveRows<FitnessSessionExercise>(
    runtime,
    "SELECT * FROM fitness_session_exercises WHERE id=? LIMIT 1",
    [id],
  ))[0] ?? null;
}

async function readLiveSetsForExercise(
  runtime: FitnessLiveStorageRuntime,
  exerciseId: string,
): Promise<readonly FitnessLiveSetSnapshot[]> {
  return (await liveRows<Row>(runtime, `SELECT
      id,session_exercise_id,set_index,set_kind,load_grams,reps,duration_seconds,
      rir,rpe,completed,pain_note,completed_at,client_mutation_id,created_at,updated_at
    FROM fitness_sets WHERE session_exercise_id=? ORDER BY set_index,id LIMIT ?`, [
    exerciseId,
    LIVE_MAX_ATOMIC_ROWS + 1,
  ])).map(mapLiveSet).sort((left, right) =>
    left.set_index - right.set_index || compareLiveId(left.id, right.id)
  );
}

async function readLiveSet(
  runtime: FitnessLiveStorageRuntime,
  id: string,
): Promise<FitnessLiveSetSnapshot | null> {
  const row = (await liveRows<Row>(runtime, `SELECT
      id,session_exercise_id,set_index,set_kind,load_grams,reps,duration_seconds,
      rir,rpe,completed,pain_note,completed_at,client_mutation_id,created_at,updated_at
    FROM fitness_sets WHERE id=? LIMIT 1`, [id]))[0];
  return row ? mapLiveSet(row) : null;
}

async function readLiveExerciseProjection(
  runtime: FitnessLiveStorageRuntime,
  exerciseId: string,
): Promise<FitnessLiveExerciseProjection | null> {
  const exercise = await readLiveExercise(runtime, exerciseId);
  if (!exercise) return null;
  const [session, sets] = await Promise.all([
    readLiveSession(runtime, exercise.session_id),
    readLiveSetsForExercise(runtime, exercise.id),
  ]);
  if (!session) return null;
  return { session, exercise, sets };
}

async function readLiveSessionProjection(
  runtime: FitnessLiveStorageRuntime,
  sessionId: string,
  eventId: string | null,
): Promise<FitnessLiveSessionProjection> {
  const [session, exercises, setRows, cardioEntries, event, capabilities] = await Promise.all([
    readLiveSession(runtime, sessionId),
    liveRows<FitnessSessionExercise>(runtime,
      "SELECT * FROM fitness_session_exercises WHERE session_id=? ORDER BY order_index,id LIMIT ?",
      [sessionId, LIVE_MAX_ATOMIC_ROWS + 1]),
    liveRows<Row>(runtime, `SELECT recorded_set.id,recorded_set.session_exercise_id,
        recorded_set.set_index,recorded_set.set_kind,recorded_set.load_grams,
        recorded_set.reps,recorded_set.duration_seconds,recorded_set.rir,recorded_set.rpe,
        recorded_set.completed,recorded_set.pain_note,recorded_set.completed_at,
        recorded_set.client_mutation_id,recorded_set.created_at,recorded_set.updated_at
      FROM fitness_sets recorded_set
      JOIN fitness_session_exercises exercise
        ON exercise.id=recorded_set.session_exercise_id
      WHERE exercise.session_id=? ORDER BY recorded_set.set_index,recorded_set.id LIMIT ?`,
      [sessionId, LIVE_MAX_ATOMIC_ROWS + 1]),
    liveRows<FitnessCardioEntry>(runtime,
      "SELECT * FROM fitness_cardio_entries WHERE session_id=? ORDER BY created_at,id LIMIT ?",
      [sessionId, LIVE_MAX_ATOMIC_ROWS + 1]),
    eventId === null
      ? Promise.resolve([] as readonly FitnessCalendarEvent[])
      : liveRows<FitnessCalendarEvent>(runtime,
        "SELECT * FROM fitness_calendar_events WHERE id=? LIMIT 1", [eventId]),
    liveRows<FitnessCapability>(runtime, `SELECT capability.*
      FROM fitness_capabilities capability
      JOIN fitness_sets recorded_set ON recorded_set.id=capability.source_set_id
      JOIN fitness_session_exercises exercise
        ON exercise.id=recorded_set.session_exercise_id
      WHERE exercise.session_id=?
      ORDER BY capability.recorded_at,capability.id LIMIT ?`,
      [sessionId, LIVE_MAX_ATOMIC_ROWS + 1]),
  ]);
  return {
    session,
    exercises: sortedExercises(exercises),
    sets: sortedByIndexAndId(setRows.map(mapLiveSet)),
    cardioEntries: sortedCardio(cardioEntries),
    event: event[0] ?? null,
    capabilities: sortedCapabilities(capabilities),
  };
}

function publicExerciseExpectation(
  projection: FitnessLiveExerciseProjection,
): FitnessLiveExerciseExpectation {
  const sets = projection.sets.map(publicLiveSet);
  return {
    session: projection.session,
    exercise: projection.exercise,
    sets,
    nextSetIndex: sets.reduce(
      (maximum, set) => Math.max(maximum, set.set_index + 1),
      0,
    ),
  };
}

function publicSessionExpectation(
  projection: FitnessLiveSessionProjection,
): FitnessLiveSessionExpectation | null {
  if (projection.session === null) return null;
  return {
    session: projection.session,
    exercises: projection.exercises,
    sets: projection.sets.map(publicLiveSet),
    cardioEntries: projection.cardioEntries,
    event: projection.event,
    capabilities: projection.capabilities,
  };
}

function nextLiveTimestamp(now: number, values: readonly number[]): number {
  if (!safeTimestamp(now)) throw liveError("invalid_input", "设备时间不在可接受范围。");
  const greatest = values.reduce((maximum, value) => Math.max(maximum, value), -1);
  const next = Math.max(now, greatest + 1);
  if (!safeTimestamp(next)) throw liveError("invalid_input", "训练记录版本时间已经超出范围。");
  return next;
}

function generatedLiveUuid(runtime: FitnessLiveStorageRuntime, prefix = ""): string {
  const uuid = runtime.randomUUID();
  if (!LIVE_UUID_PATTERN.test(uuid)) {
    throw liveError("invalid_input", "无法生成可靠的训练写入标识。");
  }
  return `${prefix}${uuid}`;
}

export type PrepareFitnessSetRecordInput = Omit<RecordFitnessSetInput, "clientMutationId">;
export type PrepareFitnessSessionFinishInput = Readonly<{
  endedEarly?: boolean;
  reflection?: string;
}>;

export function createFitnessLiveStorageService(
  runtime: FitnessLiveStorageRuntime = {
    withExclusiveLock: (operation) => withFitnessWriteLock(operation, { requireSupport: true }),
    query: async <Result extends object>(sql: string, params?: SqlParams) => ({
      rows: await rawQuery<Result>(sql, params),
    }),
    batch: (statements) => rawBatch(statements),
    currentGeneration: () => localDb.currentGeneration(DB),
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    broadcast: broadcastFitnessChange,
  },
) {
  async function prepareLocked<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await runtime.withExclusiveLock(operation);
    } catch (error) {
      if (error instanceof FitnessLiveMutationError) throw error;
      if (error instanceof TypeError) throw liveError("invalid_input", error.message);
      throw liveError("inspect_failed", "暂时无法核对训练现场；没有开始写入。");
    }
  }

  async function prepareSetRecord(
    input: PrepareFitnessSetRecordInput,
    expected: FitnessLiveExerciseExpectation,
  ): Promise<FitnessSetRecordReceipt> {
    const stableInput = snapshotLiveInput(input);
    const stableExpected = snapshotLiveInput(expected);
    return prepareLocked(async () => {
      if (!isLiveExerciseExpectation(stableExpected)) {
        throw liveError("invalid_input", "训练画面快照无效；没有准备组记录。");
      }
      if (!safeOpaqueId(stableInput.sessionExerciseId) ||
          !liveInteger(stableInput.setIndex, 0, 10_000) ||
          stableInput.setIndex !== stableExpected.nextSetIndex) {
        throw liveError("invalid_input", "组序号与当前画面不一致；没有准备写入。");
      }
      const setKind = stableInput.setKind ?? "work";
      if (!["warmup", "work", "drop", "amrap"].includes(setKind)) {
        throw liveError("invalid_input", "组类型不受支持；没有准备写入。");
      }
      const loadGrams = stableInput.loadGrams ?? null;
      const reps = stableInput.reps ?? null;
      const durationSeconds = stableInput.durationSeconds ?? null;
      const rir = stableInput.rir ?? null;
      const rpe = stableInput.rpe ?? null;
      const painNote = stableInput.painNote?.trim() ?? "";
      if (!liveNullableInteger(loadGrams, 0, 10_000_000) ||
          !liveNullableInteger(reps, 0, 10_000) ||
          !liveNullableInteger(durationSeconds, 0, 86_400) ||
          !liveNullableInteger(rir, 0, 5) || !liveNullableInteger(rpe, 1, 10) ||
          (reps === null && durationSeconds === null) || !safeString(painNote, 10_000)) {
        throw liveError("invalid_input", "组记录内容不在可接受范围；没有准备写入。");
      }
      const current = await readLiveExerciseProjection(runtime, stableInput.sessionExerciseId);
      if (!current || !isLiveExerciseProjection(current) ||
          !sameProjection(publicExerciseExpectation(current), stableExpected)) {
        throw liveError("changed", "训练现场已在别处变化；没有准备这条组记录。");
      }
      if (current.session.status !== "active") {
        throw liveError("changed", "这场训练已经结束；没有准备这条组记录。");
      }
      if (current.exercise.status === "completed" || current.exercise.status === "skipped") {
        throw liveError("changed", "这个动作已经结束；没有准备这条组记录。");
      }
      const generation = await readConfigGeneration(runtime);
      const preparedAt = nextLiveTimestamp(runtime.now(), [
        ...exerciseProjectionVersions(current),
      ]);
      const setId = generatedLiveUuid(runtime, "set-");
      const clientMutationId = generatedLiveUuid(runtime, "fitness-live-mutation-");
      const operationId = generatedLiveUuid(runtime, "fitness-live-operation-");
      const set: FitnessLiveSetSnapshot = {
        id: setId,
        session_exercise_id: current.exercise.id,
        set_index: stableInput.setIndex,
        set_kind: setKind,
        load_grams: loadGrams,
        reps,
        duration_seconds: durationSeconds,
        rir,
        rpe,
        completed: true,
        pain_note: painNote,
        completed_at: preparedAt,
        client_mutation_id: clientMutationId,
        created_at: preparedAt,
        updated_at: preparedAt,
      };
      const receipt = await sealLiveReceipt<FitnessSetRecordReceipt>({
        purpose: "fitness-live-write",
        version: 1,
        operationId,
        ...generation,
        preparedAt,
        kind: "set-record",
        before: current,
        after: {
          session: { ...current.session, updated_at: preparedAt },
          exercise: { ...current.exercise, status: "active", updated_at: preparedAt },
          sets: sortedByIndexAndId([...current.sets, set]),
        },
      });
      if (!isFitnessLiveWriteReceipt(receipt)) {
        throw liveError("invalid_input", "无法构造可靠的组记录回执。");
      }
      return receipt;
    });
  }

  async function prepareSetUndo(
    setId: string,
    expected: FitnessLiveExerciseExpectation,
  ): Promise<FitnessSetUndoReceipt> {
    const stableSetId = snapshotLiveInput(setId);
    const stableExpected = snapshotLiveInput(expected);
    return prepareLocked(async () => {
      if (!safeOpaqueId(stableSetId) || !isLiveExerciseExpectation(stableExpected) ||
          !stableExpected.sets.some(({ id }) => id === stableSetId)) {
        throw liveError("invalid_input", "要撤销的组不在这份训练画面里。");
      }
      const current = await readLiveExerciseProjection(runtime, stableExpected.exercise.id);
      if (!current || !isLiveExerciseProjection(current) ||
          !sameProjection(publicExerciseExpectation(current), stableExpected) ||
          current.session.status !== "active" ||
          !current.sets.some(({ id }) => id === stableSetId)) {
        throw liveError("changed", "这条组记录或训练现场已变化；没有准备撤销。");
      }
      const generation = await readConfigGeneration(runtime);
      const preparedAt = nextLiveTimestamp(runtime.now(), [
        ...exerciseProjectionVersions(current),
      ]);
      const operationId = generatedLiveUuid(runtime, "fitness-live-operation-");
      const receipt = await sealLiveReceipt<FitnessSetUndoReceipt>({
        purpose: "fitness-live-write",
        version: 1,
        operationId,
        ...generation,
        preparedAt,
        kind: "set-undo",
        before: current,
        after: {
          session: { ...current.session, updated_at: preparedAt },
          exercise: { ...current.exercise, status: "active", updated_at: preparedAt },
          sets: current.sets.filter(({ id }) => id !== stableSetId),
        },
      });
      if (!isFitnessLiveWriteReceipt(receipt)) {
        throw liveError("invalid_input", "无法构造可靠的撤销回执。");
      }
      return receipt;
    });
  }

  async function prepareSessionFinish(
    sessionId: string,
    input: PrepareFitnessSessionFinishInput,
    expected: FitnessLiveSessionExpectation,
  ): Promise<FitnessSessionFinishReceipt> {
    const stableSessionId = snapshotLiveInput(sessionId);
    const stableInput = snapshotLiveInput(input);
    const stableExpected = snapshotLiveInput(expected);
    return prepareLocked(async () => {
      if (!safeOpaqueId(stableSessionId) || !isLiveSessionExpectation(stableExpected) ||
          stableExpected.session.id !== stableSessionId ||
          !stableInput || typeof stableInput !== "object" || Array.isArray(stableInput) ||
          (stableInput.endedEarly !== undefined && typeof stableInput.endedEarly !== "boolean") ||
          (stableInput.reflection !== undefined && typeof stableInput.reflection !== "string")) {
        throw liveError("invalid_input", "结束训练的内容或画面快照无效。");
      }
      const reflection = stableInput.reflection === undefined
        ? stableExpected.session.reflection
        : stableInput.reflection.trim();
      if (!safeString(reflection, 20_000)) {
        throw liveError("invalid_input", "训练感受过长；没有准备结束训练。");
      }
      const current = await readLiveSessionProjection(
        runtime,
        stableSessionId,
        stableExpected.session.event_id,
      );
      if (!isLiveSessionProjection(current) ||
          !sameProjection(publicSessionExpectation(current), stableExpected) ||
          current.session === null || current.session.status !== "active") {
        throw liveError("changed", "训练现场已在别处变化；没有准备结束。");
      }
      if (current.event !== null && current.event.status !== "in_progress") {
        throw liveError("changed", "关联日历安排已变化；没有准备结束训练。");
      }
      const generation = await readConfigGeneration(runtime);
      const preparedAt = nextLiveTimestamp(runtime.now(), [
        ...sessionProjectionVersions(
          current as FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>,
        ),
      ]);
      const operationId = generatedLiveUuid(runtime, "fitness-live-operation-");
      const afterCapabilities = [...current.capabilities];
      const capabilitiesBySource = new Map(current.capabilities.map((capability) =>
        [capability.source_set_id, capability]
      ));
      const exercises = new Map(current.exercises.map((exercise) => [exercise.id, exercise]));
      for (const set of current.sets) {
        if (!set.completed || set.set_kind !== "work" || set.pain_note !== "" ||
            set.completed_at === null || (set.reps === null && set.load_grams === null) ||
            capabilitiesBySource.has(set.id)) continue;
        const exercise = exercises.get(set.session_exercise_id);
        if (!exercise) throw liveError("inspect_failed", "训练组与动作关联不完整；没有准备结束。");
        afterCapabilities.push({
          id: generatedLiveUuid(runtime),
          exercise_id: exercise.exercise_id,
          equipment_id: exercise.equipment_id,
          source_set_id: set.id,
          load_grams: set.load_grams,
          reps: set.reps,
          rir: set.rir,
          rpe: set.rpe,
          confidence: "observed",
          recorded_at: set.completed_at,
          created_at: preparedAt,
        });
      }
      const receipt = await sealLiveReceipt<FitnessSessionFinishReceipt>({
        purpose: "fitness-live-write",
        version: 1,
        operationId,
        ...generation,
        preparedAt,
        kind: "session-finish",
        before: current as FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>,
        after: {
          session: {
            ...current.session,
            status: stableInput.endedEarly ? "ended_early" : "completed",
            ended_at: preparedAt,
            reflection,
            updated_at: preparedAt,
          },
          exercises: sortedExercises(current.exercises.map((exercise) =>
            transformedFinishedExercise(exercise, current.sets, preparedAt)
          )),
          sets: current.sets,
          cardioEntries: current.cardioEntries,
          event: current.event === null ? null : {
            ...current.event,
            status: "completed",
            updated_at: preparedAt,
          },
          capabilities: sortedCapabilities(afterCapabilities),
        },
      });
      if (!isFitnessLiveWriteReceipt(receipt)) {
        throw liveError("invalid_input", "无法构造可靠的结束训练回执。");
      }
      return receipt;
    });
  }

  async function prepareEmptySessionCancel(
    sessionId: string,
    expected: FitnessLiveSessionExpectation,
  ): Promise<FitnessEmptySessionCancelReceipt> {
    const stableSessionId = snapshotLiveInput(sessionId);
    const stableExpected = snapshotLiveInput(expected);
    return prepareLocked(async () => {
      if (!safeOpaqueId(stableSessionId) || !isLiveSessionExpectation(stableExpected) ||
          stableExpected.session.id !== stableSessionId) {
        throw liveError("invalid_input", "撤销训练的画面快照无效。");
      }
      const current = await readLiveSessionProjection(
        runtime,
        stableSessionId,
        stableExpected.session.event_id,
      );
      if (!isLiveSessionProjection(current) ||
          !sameProjection(publicSessionExpectation(current), stableExpected) ||
          current.session === null || current.session.status !== "active") {
        throw liveError("changed", "训练现场已在别处变化；没有准备撤销。");
      }
      if (current.sets.length !== 0 || current.cardioEntries.length !== 0 ||
          current.capabilities.length !== 0) {
        throw liveError("changed", "这场训练已经有现场事实，不能作为空训练撤销。");
      }
      if (current.event !== null && current.event.status !== "in_progress") {
        throw liveError("changed", "关联日历安排已变化；没有准备撤销训练。");
      }
      const generation = await readConfigGeneration(runtime);
      const preparedAt = nextLiveTimestamp(runtime.now(), [
        ...sessionProjectionVersions(
          current as FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>,
        ),
      ]);
      const operationId = generatedLiveUuid(runtime, "fitness-live-operation-");
      const receipt = await sealLiveReceipt<FitnessEmptySessionCancelReceipt>({
        purpose: "fitness-live-write",
        version: 1,
        operationId,
        ...generation,
        preparedAt,
        kind: "session-cancel",
        before: current as FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>,
        after: {
          session: null,
          exercises: [],
          sets: [],
          cardioEntries: [],
          event: current.event === null ? null : {
            ...current.event,
            status: "planned",
            updated_at: preparedAt,
          },
          capabilities: [],
        },
      });
      if (!isFitnessLiveWriteReceipt(receipt)) {
        throw liveError("invalid_input", "无法构造可靠的撤销训练回执。");
      }
      return receipt;
    });
  }

  async function receiptStateUnlocked(
    receipt: FitnessLiveWriteReceipt,
  ): Promise<Exclude<FitnessLiveWriteInspection, "still_unknown" | "invalid_receipt">> {
    const generation = await readConfigGeneration(runtime);
    if (generation.generationId !== receipt.generationId ||
        generation.generationSequence !== receipt.generationSequence) return "changed";
    if (receipt.kind === "set-record") {
      const beforeIds = new Set(receipt.before.sets.map(({ id }) => id));
      const target = receipt.after.sets.find(({ id }) => !beforeIds.has(id));
      if (!target) return "changed";
      const storedTarget = await readLiveSet(runtime, target.id);
      if (sameProjection(storedTarget, target)) return "exact_saved";
      const current = await readLiveExerciseProjection(runtime, receipt.before.exercise.id);
      return current && sameProjection(current, receipt.before) ? "expected" : "changed";
    }
    if (receipt.kind === "set-undo") {
      const afterIds = new Set(receipt.after.sets.map(({ id }) => id));
      const target = receipt.before.sets.find(({ id }) => !afterIds.has(id));
      if (!target) return "changed";
      const storedTarget = await readLiveSet(runtime, target.id);
      if (storedTarget === null) return "exact_saved";
      const current = await readLiveExerciseProjection(runtime, receipt.before.exercise.id);
      return current && sameProjection(current, receipt.before) ? "expected" : "changed";
    }
    const current = await readLiveSessionProjection(
      runtime,
      receipt.before.session.id,
      receipt.before.event?.id ?? null,
    );
    if (sameProjection(current, receipt.after)) return "exact_saved";
    return sameProjection(current, receipt.before) ? "expected" : "changed";
  }

  type LivePredicate = Readonly<{ sql: string; params: readonly unknown[] }>;

  function joinedLivePredicate(predicates: readonly LivePredicate[]): LivePredicate {
    return {
      sql: predicates.length === 0
        ? "1"
        : predicates.map(({ sql }) => `(${sql})`).join(" AND "),
      params: predicates.flatMap(({ params }) => [...params]),
    };
  }

  function liveSessionPredicate(row: FitnessSession): LivePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_sessions WHERE id=? AND event_id IS ?
        AND venue_id IS ? AND program_day_id IS ? AND started_at IS ? AND ended_at IS ?
        AND status IS ? AND available_minutes IS ? AND energy_note IS ?
        AND soreness_note IS ? AND reflection IS ? AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id, row.event_id, row.venue_id, row.program_day_id, row.started_at,
        row.ended_at, row.status, row.available_minutes, row.energy_note,
        row.soreness_note, row.reflection, row.created_at, row.updated_at,
      ],
    };
  }

  function liveExercisePredicate(row: FitnessSessionExercise): LivePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_session_exercises WHERE id=? AND session_id IS ?
        AND exercise_id IS ? AND equipment_id IS ? AND planned_item_id IS ?
        AND order_index IS ? AND status IS ? AND substituted_for_exercise_id IS ?
        AND substitution_reason IS ? AND equipment_snapshot IS ? AND note IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id, row.session_id, row.exercise_id, row.equipment_id, row.planned_item_id,
        row.order_index, row.status, row.substituted_for_exercise_id,
        row.substitution_reason, row.equipment_snapshot, row.note, row.created_at,
        row.updated_at,
      ],
    };
  }

  function liveSetPredicate(row: FitnessLiveSetSnapshot): LivePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_sets WHERE id=? AND session_exercise_id IS ?
        AND set_index IS ? AND set_kind IS ? AND load_grams IS ? AND reps IS ?
        AND duration_seconds IS ? AND rir IS ? AND rpe IS ? AND completed IS ?
        AND pain_note IS ? AND completed_at IS ? AND client_mutation_id IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id, row.session_exercise_id, row.set_index, row.set_kind, row.load_grams,
        row.reps, row.duration_seconds, row.rir, row.rpe, Number(row.completed),
        row.pain_note, row.completed_at, row.client_mutation_id, row.created_at,
        row.updated_at,
      ],
    };
  }

  function liveCardioPredicate(row: FitnessCardioEntry): LivePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_cardio_entries WHERE id=? AND session_id IS ?
        AND equipment_id IS ? AND mode IS ? AND duration_seconds IS ?
        AND distance_meters IS ? AND resistance IS ? AND average_heart_rate IS ?
        AND effort IS ? AND note IS ? AND created_at IS ?)`,
      params: [
        row.id, row.session_id, row.equipment_id, row.mode, row.duration_seconds,
        row.distance_meters, row.resistance, row.average_heart_rate, row.effort,
        row.note, row.created_at,
      ],
    };
  }

  function liveEventPredicate(row: FitnessCalendarEvent): LivePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_calendar_events WHERE id=?
        AND program_day_id IS ? AND venue_id IS ? AND title IS ? AND kind IS ?
        AND starts_at IS ? AND occurrence_key IS ? AND planned_minutes IS ?
        AND status IS ? AND rescheduled_from_id IS ? AND note IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id, row.program_day_id, row.venue_id, row.title, row.kind, row.starts_at,
        row.occurrence_key, row.planned_minutes, row.status, row.rescheduled_from_id,
        row.note, row.created_at, row.updated_at,
      ],
    };
  }

  function liveCapabilityPredicate(row: FitnessCapability): LivePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_capabilities WHERE id=?
        AND exercise_id IS ? AND equipment_id IS ? AND source_set_id IS ?
        AND load_grams IS ? AND reps IS ? AND rir IS ? AND rpe IS ?
        AND confidence IS ? AND recorded_at IS ? AND created_at IS ?)`,
      params: [
        row.id, row.exercise_id, row.equipment_id, row.source_set_id, row.load_grams,
        row.reps, row.rir, row.rpe, row.confidence, row.recorded_at, row.created_at,
      ],
    };
  }

  function exerciseSetPredicate(
    exerciseId: string,
    sets: readonly FitnessLiveSetSnapshot[],
  ): LivePredicate {
    return joinedLivePredicate([{
      sql: "(SELECT COUNT(*) FROM fitness_sets WHERE session_exercise_id=?)=?",
      params: [exerciseId, sets.length],
    }, ...sets.map(liveSetPredicate)]);
  }

  function sessionExerciseSetPredicate(
    sessionId: string,
    exercises: readonly FitnessSessionExercise[],
    sets: readonly FitnessLiveSetSnapshot[],
  ): LivePredicate {
    return joinedLivePredicate([{
      sql: "(SELECT COUNT(*) FROM fitness_session_exercises WHERE session_id=?)=?",
      params: [sessionId, exercises.length],
    }, ...exercises.map(liveExercisePredicate), {
      sql: `(SELECT COUNT(*) FROM fitness_sets recorded_set
        JOIN fitness_session_exercises exercise
          ON exercise.id=recorded_set.session_exercise_id
        WHERE exercise.session_id=?)=?`,
      params: [sessionId, sets.length],
    }, ...sets.map(liveSetPredicate)]);
  }

  function sessionCardioPredicate(
    sessionId: string,
    rows: readonly FitnessCardioEntry[],
  ): LivePredicate {
    return joinedLivePredicate([{
      sql: "(SELECT COUNT(*) FROM fitness_cardio_entries WHERE session_id=?)=?",
      params: [sessionId, rows.length],
    }, ...rows.map(liveCardioPredicate)]);
  }

  function sessionCapabilityPredicate(
    sessionId: string,
    rows: readonly FitnessCapability[],
  ): LivePredicate {
    return joinedLivePredicate([{
      sql: `(SELECT COUNT(*) FROM fitness_capabilities capability
        JOIN fitness_sets recorded_set ON recorded_set.id=capability.source_set_id
        JOIN fitness_session_exercises exercise
          ON exercise.id=recorded_set.session_exercise_id
        WHERE exercise.session_id=?)=?`,
      params: [sessionId, rows.length],
    }, ...rows.map(liveCapabilityPredicate)]);
  }

  function exerciseProjectionPredicate(
    projection: FitnessLiveExerciseProjection,
  ): LivePredicate {
    return joinedLivePredicate([
      liveSessionPredicate(projection.session),
      liveExercisePredicate(projection.exercise),
      exerciseSetPredicate(projection.exercise.id, projection.sets),
    ]);
  }

  function sessionProjectionPredicate(
    projection: FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>,
  ): LivePredicate {
    return joinedLivePredicate([
      liveSessionPredicate(projection.session),
      sessionExerciseSetPredicate(projection.session.id, projection.exercises, projection.sets),
      sessionCardioPredicate(projection.session.id, projection.cardioEntries),
      projection.event === null
        ? { sql: "1", params: [] }
        : liveEventPredicate(projection.event),
      sessionCapabilityPredicate(projection.session.id, projection.capabilities),
    ]);
  }

  function liveCasSentinel(predicate: LivePredicate): SqlStatement {
    return {
      sql: `INSERT INTO fitness_settings(key,value,updated_at)
        SELECT '__fitness_live_cas_abort__',NULL,0 WHERE NOT (${predicate.sql})`,
      params: predicate.params,
    };
  }

  function insertLiveSet(row: FitnessLiveSetSnapshot): SqlStatement {
    return {
      sql: `INSERT INTO fitness_sets(
        id,session_exercise_id,set_index,set_kind,load_grams,reps,duration_seconds,
        rir,rpe,completed,pain_note,completed_at,client_mutation_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        row.id, row.session_exercise_id, row.set_index, row.set_kind, row.load_grams,
        row.reps, row.duration_seconds, row.rir, row.rpe, Number(row.completed),
        row.pain_note, row.completed_at, row.client_mutation_id, row.created_at,
        row.updated_at,
      ],
    };
  }

  function insertLiveCapability(row: FitnessCapability): SqlStatement {
    return {
      sql: `INSERT INTO fitness_capabilities(
        id,exercise_id,equipment_id,source_set_id,load_grams,reps,rir,rpe,
        confidence,recorded_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        row.id, row.exercise_id, row.equipment_id, row.source_set_id, row.load_grams,
        row.reps, row.rir, row.rpe, row.confidence, row.recorded_at, row.created_at,
      ],
    };
  }

  function receiptStatements(receipt: FitnessLiveWriteReceipt): SqlStatement[] {
    if (receipt.kind === "set-record") {
      const beforeIds = new Set(receipt.before.sets.map(({ id }) => id));
      const set = receipt.after.sets.find(({ id }) => !beforeIds.has(id));
      if (!set) throw liveError("invalid_receipt", "组记录回执缺少目标行。", receipt);
      return [
        liveCasSentinel(exerciseProjectionPredicate(receipt.before)),
        insertLiveSet(set),
        {
          sql: "UPDATE fitness_session_exercises SET status='active',updated_at=? WHERE id=?",
          params: [receipt.preparedAt, receipt.before.exercise.id],
        },
        {
          sql: "UPDATE fitness_sessions SET updated_at=? WHERE id=?",
          params: [receipt.preparedAt, receipt.before.session.id],
        },
      ];
    }
    if (receipt.kind === "set-undo") {
      const afterIds = new Set(receipt.after.sets.map(({ id }) => id));
      const set = receipt.before.sets.find(({ id }) => !afterIds.has(id));
      if (!set) throw liveError("invalid_receipt", "撤销回执缺少目标行。", receipt);
      return [
        liveCasSentinel(exerciseProjectionPredicate(receipt.before)),
        { sql: "DELETE FROM fitness_sets WHERE id=?", params: [set.id] },
        {
          sql: "UPDATE fitness_session_exercises SET status='active',updated_at=? WHERE id=?",
          params: [receipt.preparedAt, receipt.before.exercise.id],
        },
        {
          sql: "UPDATE fitness_sessions SET updated_at=? WHERE id=?",
          params: [receipt.preparedAt, receipt.before.session.id],
        },
      ];
    }
    if (receipt.kind === "session-finish") {
      const statements: SqlStatement[] = [
        liveCasSentinel(sessionProjectionPredicate(receipt.before)),
        {
          sql: `UPDATE fitness_sessions SET status=?,ended_at=?,reflection=?,updated_at=?
            WHERE id=?`,
          params: [
            receipt.after.session.status,
            receipt.after.session.ended_at,
            receipt.after.session.reflection,
            receipt.after.session.updated_at,
            receipt.after.session.id,
          ],
        },
      ];
      for (const after of receipt.after.exercises) {
        const before = receipt.before.exercises.find(({ id }) => id === after.id);
        if (before && !sameProjection(before, after)) statements.push({
          sql: "UPDATE fitness_session_exercises SET status=?,updated_at=? WHERE id=?",
          params: [after.status, after.updated_at, after.id],
        });
      }
      if (receipt.after.event !== null) statements.push({
        sql: "UPDATE fitness_calendar_events SET status='completed',updated_at=? WHERE id=?",
        params: [receipt.after.event.updated_at, receipt.after.event.id],
      });
      const beforeCapabilityIds = new Set(receipt.before.capabilities.map(({ id }) => id));
      statements.push(...receipt.after.capabilities
        .filter(({ id }) => !beforeCapabilityIds.has(id))
        .map(insertLiveCapability));
      return statements;
    }
    const statements: SqlStatement[] = [
      liveCasSentinel(sessionProjectionPredicate(receipt.before)),
    ];
    if (receipt.after.event !== null) statements.push({
      sql: "UPDATE fitness_calendar_events SET status='planned',updated_at=? WHERE id=?",
      params: [receipt.after.event.updated_at, receipt.after.event.id],
    });
    statements.push({
      sql: "DELETE FROM fitness_sessions WHERE id=?",
      params: [receipt.before.session.id],
    });
    return statements;
  }

  function receiptEntity(receipt: FitnessLiveWriteReceipt): {
    id: string;
    updatedAt: number;
    reason: string;
  } {
    if (receipt.kind === "set-record") {
      const beforeIds = new Set(receipt.before.sets.map(({ id }) => id));
      return {
        id: receipt.after.sets.find(({ id }) => !beforeIds.has(id))?.id ??
          receipt.before.exercise.id,
        updatedAt: receipt.preparedAt,
        reason: "set-recorded",
      };
    }
    if (receipt.kind === "set-undo") {
      const afterIds = new Set(receipt.after.sets.map(({ id }) => id));
      return {
        id: receipt.before.sets.find(({ id }) => !afterIds.has(id))?.id ??
          receipt.before.exercise.id,
        updatedAt: receipt.preparedAt,
        reason: "set-undone",
      };
    }
    return {
      id: receipt.before.session.id,
      updatedAt: receipt.preparedAt,
      reason: receipt.kind === "session-finish" ? "session-finished" : "session-cancelled",
    };
  }

  function safeLiveBroadcast(reason: string): void {
    try {
      runtime.broadcast(reason);
    } catch {
      // A refresh hint is advisory and cannot reverse a durable commit.
    }
  }

  async function inspectWrite(value: unknown): Promise<FitnessLiveWriteInspection> {
    if (!isFitnessLiveWriteReceipt(value)) return "invalid_receipt";
    let stableReceipt: FitnessLiveWriteReceipt;
    try {
      stableReceipt = snapshotLiveInput(value);
    } catch {
      return "invalid_receipt";
    }
    if (!isFitnessLiveWriteReceipt(stableReceipt)) return "invalid_receipt";
    try {
      if (!await liveReceiptHashIsValid(stableReceipt)) return "invalid_receipt";
    } catch {
      return "invalid_receipt";
    }
    try {
      return await runtime.withExclusiveLock(() => receiptStateUnlocked(stableReceipt));
    } catch {
      return "still_unknown";
    }
  }

  async function commitWrite(value: unknown): Promise<FitnessLiveWriteResult> {
    if (!isFitnessLiveWriteReceipt(value)) {
      throw liveError("invalid_receipt", "训练写入回执无效；没有改动现场记录。");
    }
    let stableReceipt: FitnessLiveWriteReceipt;
    try {
      stableReceipt = snapshotLiveInput(value);
    } catch {
      throw liveError("invalid_receipt", "训练写入回执无效；没有改动现场记录。");
    }
    if (!isFitnessLiveWriteReceipt(stableReceipt)) {
      throw liveError("invalid_receipt", "训练写入回执无效；没有改动现场记录。");
    }
    try {
      if (!await liveReceiptHashIsValid(stableReceipt)) {
        throw liveError("invalid_receipt", "训练写入回执无效；没有改动现场记录。");
      }
    } catch (error) {
      if (error instanceof FitnessLiveMutationError) throw error;
      throw liveError("invalid_receipt", "训练写入回执无法验证；没有改动现场记录。");
    }
    const receipt = stableReceipt;
    const entity = receiptEntity(receipt);
    try {
      return await runtime.withExclusiveLock(async () => {
        const before = await receiptStateUnlocked(receipt);
        if (before === "exact_saved") {
          safeLiveBroadcast(entity.reason);
          return {
            outcome: "already_saved",
            receipt,
            entityId: entity.id,
            updatedAt: entity.updatedAt,
          };
        }
        if (before === "changed") {
          return { outcome: "changed", receipt, entityId: entity.id, retryable: false };
        }
        try {
          await runtime.batch(receiptStatements(receipt));
        } catch {
          // The transaction may have committed even though its response was lost.
        }
        const after = await receiptStateUnlocked(receipt);
        if (after === "exact_saved") {
          safeLiveBroadcast(entity.reason);
          return {
            outcome: "saved",
            receipt,
            entityId: entity.id,
            updatedAt: entity.updatedAt,
          };
        }
        if (after === "expected") {
          throw liveError(
            "write_failed",
            "这次现场记录确定没有写入；保留回执后可以重试。",
            receipt,
          );
        }
        return { outcome: "changed", receipt, entityId: entity.id, retryable: false };
      });
    } catch (error) {
      if (error instanceof FitnessLiveMutationError) throw error;
      return {
        outcome: "outcome_uncertain",
        receipt,
        entityId: entity.id,
        retryable: true,
      };
    }
  }

  return {
    prepareFitnessSetRecord: prepareSetRecord,
    prepareFitnessSetUndo: prepareSetUndo,
    prepareFitnessSessionFinish: prepareSessionFinish,
    prepareFitnessEmptySessionCancel: prepareEmptySessionCancel,
    inspectFitnessLiveWrite: inspectWrite,
    commitFitnessLiveWrite: commitWrite,
  } as const;
}

const defaultFitnessLiveStorageService = createFitnessLiveStorageService();

export const prepareFitnessSetRecord =
  defaultFitnessLiveStorageService.prepareFitnessSetRecord;
export const prepareFitnessSetUndo =
  defaultFitnessLiveStorageService.prepareFitnessSetUndo;
export const prepareFitnessSessionFinish =
  defaultFitnessLiveStorageService.prepareFitnessSessionFinish;
export const prepareFitnessEmptySessionCancel =
  defaultFitnessLiveStorageService.prepareFitnessEmptySessionCancel;
export const inspectFitnessLiveWrite =
  defaultFitnessLiveStorageService.inspectFitnessLiveWrite;
export const commitFitnessLiveWrite =
  defaultFitnessLiveStorageService.commitFitnessLiveWrite;

export type PrepareFitnessLiveSessionStartInput = Readonly<{
  eventId?: string | null;
  venueId: string;
  programDayId?: string | null;
  availableMinutes?: number | null;
  energyNote?: FitnessSession["energy_note"];
  sorenessNote?: string;
}>;

export type PrepareFitnessLiveExerciseAddInput = Readonly<{
  sessionId: string;
  exerciseId: string;
  equipmentId: string | null;
  equipmentSnapshot?: string;
}>;

export type PrepareFitnessLiveExerciseCompleteInput = Readonly<{
  sessionExerciseId: string;
  skipped?: boolean;
}>;

export type PrepareFitnessLiveExerciseSubstituteInput = Readonly<{
  sessionExerciseId: string;
  exerciseId: string;
  equipmentId: string | null;
  equipmentSnapshot?: string;
  reason: string;
}>;

export type FitnessLiveEquipmentContextExpectation = Readonly<{
  venue: FitnessVenue;
  equipment: readonly FitnessEquipment[];
  equipmentLoads: readonly FitnessEquipmentLoad[];
  avoidConstraints: readonly FitnessConstraint[];
}>;

export type FitnessLiveStartExpectation = FitnessLiveEquipmentContextExpectation & Readonly<{
  activeSessions: readonly FitnessSession[];
  event: FitnessCalendarEvent | null;
  program: FitnessProgram | null;
  programDay: FitnessProgramDay | null;
  programItems: readonly FitnessProgramItem[];
}>;

export type FitnessLiveAddExpectation = FitnessLiveEquipmentContextExpectation & Readonly<{
  projection: FitnessLiveSessionExpectation;
  nextOrderIndex: number;
}>;

export type FitnessLiveSubstituteExpectation =
  FitnessLiveEquipmentContextExpectation & Readonly<{
    projection: FitnessLiveSessionExpectation;
  }>;

type FitnessLiveStructureReceiptBase<Kind extends string> = Readonly<{
  purpose: "fitness-live-structure-write";
  version: 1;
  operationId: string;
  generationId: string;
  generationSequence: number;
  preparedAt: number;
  kind: Kind;
  projectionSha256: string;
}>;

export type FitnessLiveSessionStartReceipt =
  FitnessLiveStructureReceiptBase<"session-start"> & Readonly<{
    context: FitnessLiveStartExpectation;
    before: Readonly<{
      activeSessions: readonly FitnessSession[];
      event: FitnessCalendarEvent | null;
    }>;
    after: Readonly<{
      session: FitnessSession;
      exercises: readonly FitnessSessionExercise[];
      event: FitnessCalendarEvent | null;
    }>;
  }>;

export type FitnessLiveExerciseAddReceipt =
  FitnessLiveStructureReceiptBase<"exercise-add"> & Readonly<{
    context: FitnessLiveEquipmentContextExpectation;
    before: FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>;
    after: FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>;
  }>;

export type FitnessLiveExerciseCompleteReceipt =
  FitnessLiveStructureReceiptBase<"exercise-complete"> & Readonly<{
    before: FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>;
    after: FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>;
  }>;

export type FitnessLiveExerciseSubstituteReceipt =
  FitnessLiveStructureReceiptBase<"exercise-substitute"> & Readonly<{
    context: FitnessLiveEquipmentContextExpectation;
    before: FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>;
    after: FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>;
  }>;

export type FitnessLiveSessionReflectionReceipt =
  FitnessLiveStructureReceiptBase<"session-reflection"> & Readonly<{
    before: FitnessSession;
    after: FitnessSession;
  }>;

export type FitnessLiveStructureWriteReceipt =
  | FitnessLiveSessionStartReceipt
  | FitnessLiveExerciseAddReceipt
  | FitnessLiveExerciseCompleteReceipt
  | FitnessLiveExerciseSubstituteReceipt
  | FitnessLiveSessionReflectionReceipt;

export type FitnessLiveStructureWriteInspection = FitnessLiveWriteInspection;

export type FitnessLiveStructureWriteResult =
  | Readonly<{
      outcome: "saved" | "already_saved";
      receipt: FitnessLiveStructureWriteReceipt;
      entityId: string;
      updatedAt: number;
    }>
  | Readonly<{
      outcome: "changed";
      receipt: FitnessLiveStructureWriteReceipt;
      entityId: string;
      retryable: false;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      receipt: FitnessLiveStructureWriteReceipt;
      entityId: string;
      retryable: true;
    }>;

export class FitnessLiveStructureMutationError extends Error {
  readonly name = "FitnessLiveStructureMutationError";

  constructor(
    readonly code: FitnessLiveMutationErrorCode,
    message: string,
    readonly receipt?: FitnessLiveStructureWriteReceipt,
  ) {
    super(message);
  }
}

const LIVE_STRUCTURE_OPERATION_ID_PATTERN =
  /^fitness-live-structure-operation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIVE_SESSION_ID_PATTERN =
  /^session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIVE_EXERCISE_ID_PATTERN =
  /^session-exercise-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIVE_STRUCTURE_RECEIPT_MARKER_PREFIX =
  "__fitness_live_structure_receipt__:";

function structureError(
  code: FitnessLiveMutationErrorCode,
  message: string,
  receipt?: FitnessLiveStructureWriteReceipt,
): FitnessLiveStructureMutationError {
  return new FitnessLiveStructureMutationError(code, message, receipt);
}

function sortedSessions(rows: readonly FitnessSession[]): FitnessSession[] {
  return [...rows].sort((left, right) => compareLiveId(left.id, right.id));
}

function sortedEquipment(rows: readonly FitnessEquipment[]): FitnessEquipment[] {
  return [...rows].sort((left, right) => compareLiveId(left.id, right.id));
}

function sortedEquipmentLoads(
  rows: readonly FitnessEquipmentLoad[],
): FitnessEquipmentLoad[] {
  return [...rows].sort((left, right) =>
    compareLiveId(left.equipment_id, right.equipment_id) ||
    left.load_grams - right.load_grams || compareLiveId(left.id, right.id)
  );
}

function sortedConstraints(rows: readonly FitnessConstraint[]): FitnessConstraint[] {
  return [...rows].sort((left, right) => compareLiveId(left.id, right.id));
}

function sortedProgramItems(rows: readonly FitnessProgramItem[]): FitnessProgramItem[] {
  return [...rows].sort((left, right) =>
    left.order_index - right.order_index || compareLiveId(left.id, right.id)
  );
}

function equipmentContextFromSnapshot(
  snapshot: FitnessSnapshot,
  venueId: string,
): FitnessLiveEquipmentContextExpectation {
  const venue = snapshot.venues.find(({ id }) => id === venueId);
  if (!venue) throw structureError("invalid_input", "当前场地不在这份训练画面里。");
  const equipment = sortedEquipment(snapshot.equipment.filter(
    ({ venue_id }) => venue_id === venue.id,
  ));
  const equipmentIds = new Set(equipment.map(({ id }) => id));
  const equipmentLoads = sortedEquipmentLoads(snapshot.equipmentLoads.filter(
    ({ equipment_id }) => equipmentIds.has(equipment_id),
  ));
  const avoidConstraints = sortedConstraints(snapshot.constraints.filter(
    ({ active, severity }) => active && severity === "avoid",
  ));
  return { venue, equipment, equipmentLoads, avoidConstraints };
}

export function fitnessLiveStartExpectationFromSnapshot(
  snapshot: FitnessSnapshot,
  input: PrepareFitnessLiveSessionStartInput,
): FitnessLiveStartExpectation {
  const eventId = input.eventId ?? null;
  const event = eventId === null
    ? null
    : snapshot.events.find(({ id }) => id === eventId) ?? null;
  const programDayId = input.programDayId ?? event?.program_day_id ?? null;
  const programDay = programDayId === null
    ? null
    : snapshot.programDays.find(({ id }) => id === programDayId) ?? null;
  const program = programDay === null
    ? null
    : snapshot.programs.find(({ id }) => id === programDay.program_id) ?? null;
  const programItems = programDay === null
    ? []
    : sortedProgramItems(snapshot.programItems.filter(
      ({ program_day_id }) => program_day_id === programDay.id,
    ));
  return snapshotLiveInput({
    ...equipmentContextFromSnapshot(snapshot, input.venueId),
    activeSessions: sortedSessions(snapshot.sessions.filter(({ status }) => status === "active")),
    event,
    program,
    programDay,
    programItems,
  });
}

export function fitnessLiveAddExpectationFromSnapshot(
  snapshot: FitnessSnapshot,
  sessionId: string,
): FitnessLiveAddExpectation {
  const projection = fitnessLiveSessionExpectationFromSnapshot(snapshot, sessionId);
  return snapshotLiveInput({
    ...equipmentContextFromSnapshot(snapshot, projection.session.venue_id),
    projection,
    nextOrderIndex: projection.exercises.reduce(
      (maximum, exercise) => Math.max(maximum, exercise.order_index + 1),
      0,
    ),
  });
}

export function fitnessLiveSubstituteExpectationFromSnapshot(
  snapshot: FitnessSnapshot,
  sessionId: string,
): FitnessLiveSubstituteExpectation {
  const projection = fitnessLiveSessionExpectationFromSnapshot(snapshot, sessionId);
  return snapshotLiveInput({
    ...equipmentContextFromSnapshot(snapshot, projection.session.venue_id),
    projection,
  });
}

function isFitnessLiveProgram(value: unknown): value is FitnessProgram {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FitnessProgram>;
  return exactObjectKeys(value, [
    "id", "name", "venue_id", "goal", "split", "status", "version", "source",
    "assumptions", "created_at", "updated_at",
  ]) && safeOpaqueId(row.id) && safeString(row.name, 160) && row.name.length > 0 &&
    safeOpaqueId(row.venue_id) && FITNESS_GOALS.has(String(row.goal)) &&
    ["auto", "full_body", "upper_lower", "push_pull_legs", "custom"].includes(String(row.split)) &&
    ["draft", "active", "archived"].includes(String(row.status)) &&
    liveInteger(row.version, 1, Number.MAX_SAFE_INTEGER) &&
    ["local", "ai_draft", "manual"].includes(String(row.source)) &&
    safeStringArray(row.assumptions, 100) && uniqueExactStrings(row.assumptions) &&
    row.assumptions.every((assumption) => safeString(assumption, 500)) &&
    safeTimestamp(row.created_at) && safeTimestamp(row.updated_at) &&
    row.updated_at >= row.created_at;
}

function isFitnessLiveProgramDay(value: unknown): value is FitnessProgramDay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FitnessProgramDay>;
  return exactObjectKeys(value, [
    "id", "program_id", "day_index", "weekday", "kind", "name", "focus",
    "estimated_minutes", "variant", "created_at",
  ]) && safeOpaqueId(row.id) && safeOpaqueId(row.program_id) &&
    liveInteger(row.day_index, 0, 100_000) &&
    (row.weekday === null || liveInteger(row.weekday, 0, 6)) &&
    ["resistance", "cardio", "rest"].includes(String(row.kind)) &&
    safeString(row.name, 10_000) && safeString(row.focus, 10_000) &&
    liveInteger(row.estimated_minutes, 0, 240) &&
    ["standard", "short", "low_fatigue", "busy_gym"].includes(String(row.variant)) &&
    safeTimestamp(row.created_at);
}

function isFitnessLiveProgramItem(value: unknown): value is FitnessProgramItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FitnessProgramItem>;
  return exactObjectKeys(value, [
    "id", "program_day_id", "exercise_id", "equipment_id", "resource_equipment_ids",
    "order_index", "sets", "rep_min", "rep_max", "duration_seconds", "target_rir",
    "rest_seconds", "load_grams", "load_guidance", "rationale",
    "substitution_exercise_ids", "equipment_snapshot", "created_at",
  ]) && safeOpaqueId(row.id) && safeOpaqueId(row.program_day_id) &&
    safeOpaqueId(row.exercise_id) && Boolean(getFitnessExercise(row.exercise_id)) &&
    (row.equipment_id === null || safeOpaqueId(row.equipment_id)) &&
    safeStringArray(row.resource_equipment_ids, 100) &&
    uniqueExactStrings(row.resource_equipment_ids) &&
    row.resource_equipment_ids.every(safeOpaqueId) &&
    liveInteger(row.order_index, 0, 100_000) && liveInteger(row.sets, 1, 20) &&
    liveNullableInteger(row.rep_min, 1, 1_000) &&
    liveNullableInteger(row.rep_max, 1, 1_000) &&
    (row.rep_min === null || row.rep_max === null || row.rep_max >= row.rep_min) &&
    liveNullableInteger(row.duration_seconds, 1, 86_400) &&
    (row.rep_min !== null || row.duration_seconds !== null) &&
    liveNullableInteger(row.target_rir, 0, 5) && liveInteger(row.rest_seconds, 0, 1_200) &&
    liveNullableInteger(row.load_grams, 0, 10_000_000) &&
    safeString(row.load_guidance, 10_000) && safeString(row.rationale, 10_000) &&
    safeStringArray(row.substitution_exercise_ids, 100) &&
    uniqueExactStrings(row.substitution_exercise_ids) &&
    row.substitution_exercise_ids.every((id) => safeOpaqueId(id) &&
      id !== row.exercise_id && Boolean(getFitnessExercise(id))) &&
    safeString(row.equipment_snapshot, 100_000) && safeTimestamp(row.created_at);
}

function isFitnessLiveEquipmentContext(
  value: unknown,
): value is FitnessLiveEquipmentContextExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactObjectKeys(value, [
    "venue", "equipment", "equipmentLoads", "avoidConstraints",
  ])) return false;
  const context = value as Partial<FitnessLiveEquipmentContextExpectation>;
  if (!isFitnessVenueRow(context.venue) || !Array.isArray(context.equipment) ||
      !Array.isArray(context.equipmentLoads) || !Array.isArray(context.avoidConstraints)) return false;
  const total = context.equipment.length + context.equipmentLoads.length +
    context.avoidConstraints.length;
  if (total > LIVE_MAX_ATOMIC_ROWS || !uniqueIds(context.equipment) ||
      !uniqueIds(context.equipmentLoads) || !uniqueIds(context.avoidConstraints) ||
      !context.equipment.every((row) => isFitnessEquipmentRow(row) &&
        row.venue_id === context.venue?.id) ||
      !context.equipmentLoads.every(isFitnessEquipmentLoadRow) ||
      !context.avoidConstraints.every((row) =>
        isFitnessConstraintRow(row) && row.active && row.severity === "avoid") ||
      !isSortedProjection(context.equipment, sortedEquipment) ||
      !isSortedProjection(context.equipmentLoads, sortedEquipmentLoads) ||
      !isSortedProjection(context.avoidConstraints, sortedConstraints)) return false;
  const equipmentIds = new Set(context.equipment.map(({ id }) => id));
  return context.equipmentLoads.every(({ equipment_id }) => equipmentIds.has(equipment_id));
}

function equipmentContextOnly(
  value: FitnessLiveEquipmentContextExpectation,
): FitnessLiveEquipmentContextExpectation {
  return {
    venue: value.venue,
    equipment: value.equipment,
    equipmentLoads: value.equipmentLoads,
    avoidConstraints: value.avoidConstraints,
  };
}

function isFitnessLiveStartExpectation(value: unknown): value is FitnessLiveStartExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !jsonWithinUnits(value, LIVE_MAX_EXPECTATION_JSON_UNITS) || !exactObjectKeys(value, [
        "venue", "equipment", "equipmentLoads", "avoidConstraints", "activeSessions",
        "event", "program", "programDay", "programItems",
      ])) return false;
  const expected = value as Partial<FitnessLiveStartExpectation>;
  if (!isFitnessLiveEquipmentContext(equipmentContextOnly(
    expected as FitnessLiveEquipmentContextExpectation,
  )) || !Array.isArray(expected.activeSessions) ||
      !expected.activeSessions.every((session) =>
        isFitnessLiveSession(session) && session.status === "active") ||
      !uniqueIds(expected.activeSessions) ||
      !isSortedProjection(expected.activeSessions, sortedSessions) ||
      !(expected.event === null || isFitnessLiveEvent(expected.event)) ||
      !(expected.program === null || isFitnessLiveProgram(expected.program)) ||
      !(expected.programDay === null || isFitnessLiveProgramDay(expected.programDay)) ||
      !Array.isArray(expected.programItems) ||
      !expected.programItems.every(isFitnessLiveProgramItem) ||
      !uniqueIds(expected.programItems) ||
      new Set(expected.programItems.map(({ order_index }) => order_index)).size !==
      expected.programItems.length ||
      !isSortedProjection(expected.programItems, sortedProgramItems)) return false;
  const complete = expected as FitnessLiveStartExpectation;
  if (complete.activeSessions.length + complete.programItems.length + complete.equipment.length +
      complete.equipmentLoads.length + complete.avoidConstraints.length > LIVE_MAX_ATOMIC_ROWS) {
    return false;
  }
  if (complete.programDay === null) {
    return complete.program === null && complete.programItems.length === 0;
  }
  return complete.program !== null && complete.programDay.program_id === complete.program.id &&
    complete.program.venue_id === complete.venue.id &&
    complete.programItems.every(({ program_day_id }) =>
      program_day_id === complete.programDay?.id);
}

function isFitnessLiveAddExpectation(value: unknown): value is FitnessLiveAddExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !jsonWithinUnits(value, LIVE_MAX_EXPECTATION_JSON_UNITS) || !exactObjectKeys(value, [
        "venue", "equipment", "equipmentLoads", "avoidConstraints", "projection",
        "nextOrderIndex",
      ])) return false;
  const expected = value as Partial<FitnessLiveAddExpectation>;
  if (!isFitnessLiveEquipmentContext(equipmentContextOnly(
    expected as FitnessLiveEquipmentContextExpectation,
  )) || !isLiveSessionExpectation(expected.projection) ||
      expected.projection.session.venue_id !== expected.venue?.id ||
      !liveInteger(expected.nextOrderIndex, 0, 100_000)) return false;
  return expected.nextOrderIndex === expected.projection.exercises.reduce(
    (maximum, exercise) => Math.max(maximum, exercise.order_index + 1),
    0,
  );
}

function isFitnessLiveSubstituteExpectation(
  value: unknown,
): value is FitnessLiveSubstituteExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !jsonWithinUnits(value, LIVE_MAX_EXPECTATION_JSON_UNITS) || !exactObjectKeys(value, [
        "venue", "equipment", "equipmentLoads", "avoidConstraints", "projection",
      ])) return false;
  const expected = value as Partial<FitnessLiveSubstituteExpectation>;
  return isFitnessLiveEquipmentContext(equipmentContextOnly(
    expected as FitnessLiveEquipmentContextExpectation,
  )) && isLiveSessionExpectation(expected.projection) &&
    expected.projection.session.venue_id === expected.venue?.id;
}

async function readStructureEquipmentContext(
  runtime: FitnessLiveStorageRuntime,
  venueId: string,
): Promise<FitnessLiveEquipmentContextExpectation | null> {
  const [venueRows, equipmentRows, loadRows, constraintRows] = await Promise.all([
    liveRows<Row>(runtime, "SELECT * FROM fitness_venues WHERE id=? LIMIT 1", [venueId]),
    liveRows<Row>(runtime, "SELECT * FROM fitness_equipment WHERE venue_id=? ORDER BY id LIMIT ?", [
      venueId,
      LIVE_MAX_ATOMIC_ROWS + 1,
    ]),
    liveRows<Row>(runtime, `SELECT equipment_load.* FROM fitness_equipment_loads equipment_load
      JOIN fitness_equipment equipment ON equipment.id=equipment_load.equipment_id
      WHERE equipment.venue_id=? ORDER BY equipment_load.equipment_id,
        equipment_load.load_grams,equipment_load.id LIMIT ?`, [
      venueId,
      LIVE_MAX_ATOMIC_ROWS + 1,
    ]),
    liveRows<Row>(runtime, `SELECT * FROM fitness_constraints
      WHERE active=1 AND severity='avoid' ORDER BY id LIMIT ?`, [LIVE_MAX_ATOMIC_ROWS + 1]),
  ]);
  const venue = venueRows[0] ? mapVenue(venueRows[0]) : null;
  if (!venue) return null;
  return {
    venue,
    equipment: sortedEquipment(equipmentRows.map(mapEquipment)),
    equipmentLoads: sortedEquipmentLoads(loadRows.map(mapEquipmentLoad)),
    avoidConstraints: sortedConstraints(constraintRows.map(mapConstraint)),
  };
}

async function readStructureStartExpectation(
  runtime: FitnessLiveStorageRuntime,
  input: Readonly<{ venueId: string; eventId: string | null; programDayId: string | null }>,
): Promise<FitnessLiveStartExpectation | null> {
  const context = await readStructureEquipmentContext(runtime, input.venueId);
  if (!context) return null;
  const [activeSessions, eventRows, dayRows] = await Promise.all([
    liveRows<FitnessSession>(runtime,
      "SELECT * FROM fitness_sessions WHERE status='active' ORDER BY id LIMIT ?",
      [LIVE_MAX_ATOMIC_ROWS + 1]),
    input.eventId === null
      ? Promise.resolve([] as readonly FitnessCalendarEvent[])
      : liveRows<FitnessCalendarEvent>(runtime,
        "SELECT * FROM fitness_calendar_events WHERE id=? LIMIT 1", [input.eventId]),
    input.programDayId === null
      ? Promise.resolve([] as readonly FitnessProgramDay[])
      : liveRows<FitnessProgramDay>(runtime,
        "SELECT * FROM fitness_program_days WHERE id=? LIMIT 1", [input.programDayId]),
  ]);
  const programDay = dayRows[0] ?? null;
  const [programRows, itemRows] = programDay === null
    ? [[], []] as const
    : await Promise.all([
      liveRows<Row>(runtime, "SELECT * FROM fitness_programs WHERE id=? LIMIT 1", [
        programDay.program_id,
      ]),
      liveRows<Row>(runtime, `SELECT * FROM fitness_program_items
        WHERE program_day_id=? ORDER BY order_index,id LIMIT ?`, [
        programDay.id,
        LIVE_MAX_ATOMIC_ROWS + 1,
      ]),
    ]);
  return {
    ...context,
    activeSessions: sortedSessions(activeSessions),
    event: eventRows[0] ?? null,
    program: programRows[0] ? mapProgram(programRows[0]) : null,
    programDay,
    programItems: sortedProgramItems(itemRows.map(mapProgramItem)),
  };
}

function resolveStructureEquipmentSnapshot(
  exercise: FitnessExercise,
  context: FitnessLiveEquipmentContextExpectation,
  equipmentId: string | null,
  requestedSnapshot: string | undefined,
): string {
  if (exerciseIsAvoided(exercise, context.avoidConstraints)) {
    throw structureError("changed", `动作「${exercise.name_zh}」与当前避用限制冲突。`);
  }
  const ids = [...new Set([
    ...(equipmentId ? [equipmentId] : []),
    ...snapshotResourceIds(requestedSnapshot),
  ])];
  if (ids.length === 0) {
    if (exercise.requirements.some(({ optional }) => !optional)) {
      throw structureError("invalid_input", "这个动作缺少当前场地的必需器材。");
    }
    return "[]";
  }
  const equipmentById = new Map(context.equipment.map((entry) => [entry.id, entry]));
  const resources = ids.flatMap((id) => {
    const equipment = equipmentById.get(id);
    return equipment ? [equipment] : [];
  });
  if (resources.length !== ids.length || resources.some((equipment) =>
    equipment.venue_id !== context.venue.id ||
    !["available", "limited"].includes(equipment.status)
  )) throw structureError("changed", "器材快照包含不属于当前场地或不可用的器材。");
  const requirementKinds = new Set(exercise.requirements.map(({ kind }) => kind));
  if (resources.some(({ kind }) => !requirementKinds.has(kind)) ||
      exercise.requirements.some((requirement) =>
        !requirement.optional && !resources.some(({ kind }) => kind === requirement.kind)
      )) throw structureError("invalid_input", "这个动作缺少当前场地的完整器材资源。");
  for (const resource of resources) {
    if (!equipmentSupportsExercise(exercise, resource, context.equipmentLoads)) {
      throw structureError("changed", `动作「${exercise.name_zh}」的器材数量不足。`);
    }
  }
  return canonicalEquipmentSnapshot(resources, context.equipmentLoads);
}

function structureContextVersions(context: FitnessLiveEquipmentContextExpectation): number[] {
  return [
    context.venue.created_at,
    context.venue.updated_at,
    ...context.equipment.flatMap(({ created_at, updated_at }) => [created_at, updated_at]),
    ...context.equipmentLoads.map(({ created_at }) => created_at),
    ...context.avoidConstraints.flatMap(({ created_at, updated_at }) => [created_at, updated_at]),
  ];
}

function startExpectationVersions(context: FitnessLiveStartExpectation): number[] {
  return [
    ...structureContextVersions(context),
    ...context.activeSessions.flatMap(({ created_at, started_at, updated_at }) =>
      [created_at, started_at, updated_at]),
    ...(context.event === null ? [] : [context.event.created_at, context.event.updated_at]),
    ...(context.program === null ? [] : [context.program.created_at, context.program.updated_at]),
    ...(context.programDay === null ? [] : [context.programDay.created_at]),
    ...context.programItems.map(({ created_at }) => created_at),
  ];
}

function structureGeneratedId(
  runtime: FitnessLiveStorageRuntime,
  prefix: "session-" | "session-exercise-" | "fitness-live-structure-operation-",
): string {
  const uuid = runtime.randomUUID();
  if (!LIVE_UUID_PATTERN.test(uuid)) {
    throw structureError("invalid_input", "无法生成可靠的训练结构写入标识。");
  }
  return `${prefix}${uuid}`;
}

function sameStructureSessionClock(
  before: FitnessSession,
  after: FitnessSession,
  preparedAt: number,
): boolean {
  return sameProjection(after, { ...before, updated_at: preparedAt });
}

function isStructureStartTransition(receipt: FitnessLiveSessionStartReceipt): boolean {
  const { context, before, after, preparedAt } = receipt;
  if (!isFitnessLiveStartExpectation(context) || !before || typeof before !== "object" ||
      Array.isArray(before) || !exactObjectKeys(before, ["activeSessions", "event"]) ||
      !after || typeof after !== "object" || Array.isArray(after) ||
      !exactObjectKeys(after, ["session", "exercises", "event"]) ||
      !sameProjection(before.activeSessions, context.activeSessions) ||
      !sameProjection(before.event, context.event) || context.activeSessions.length !== 0 ||
      context.venue.status !== "active" || !isFitnessLiveSession(after.session) ||
      after.session.status !== "active" || !LIVE_SESSION_ID_PATTERN.test(after.session.id) ||
      after.session.venue_id !== context.venue.id || after.session.started_at !== preparedAt ||
      after.session.created_at !== preparedAt || after.session.updated_at !== preparedAt ||
      after.session.ended_at !== null || !strictlyAfterEvery(preparedAt, startExpectationVersions(context)) ||
      !Array.isArray(after.exercises) || !after.exercises.every(isFitnessLiveExercise) ||
      !uniqueIds(after.exercises) || !isSortedProjection(after.exercises, sortedExercises) ||
      after.exercises.length !== context.programItems.length) return false;
  if (context.event === null) {
    if (after.event !== null || after.session.event_id !== null) return false;
  } else if (
    context.event.status !== "planned" || after.event === null ||
    context.event.venue_id !== null && context.event.venue_id !== context.venue.id ||
    after.session.event_id !== context.event.id || !sameProjection(after.event, {
      ...context.event,
      status: "in_progress",
      updated_at: preparedAt,
    })
  ) return false;
  if (context.programDay === null) {
    if (after.session.program_day_id !== null || context.program !== null ||
        context.programItems.length !== 0) return false;
  } else if (
    context.program === null || context.program.venue_id !== context.venue.id ||
    after.session.program_day_id !== context.programDay.id ||
    context.event !== null && context.event.program_day_id !== null &&
      context.event.program_day_id !== context.programDay.id
  ) return false;
  return after.exercises.every((exercise, index) => {
    const item = context.programItems[index];
    if (!item) return false;
    const catalogExercise = getFitnessExercise(item.exercise_id);
    if (!catalogExercise) return false;
    let equipmentSnapshot: string;
    try {
      equipmentSnapshot = resolveStructureEquipmentSnapshot(
        catalogExercise,
        context,
        item.equipment_id,
        item.equipment_snapshot,
      );
    } catch {
      return false;
    }
    return LIVE_EXERCISE_ID_PATTERN.test(exercise.id) &&
      exercise.session_id === after.session.id && exercise.exercise_id === item.exercise_id &&
      exercise.equipment_id === item.equipment_id && exercise.planned_item_id === item.id &&
      exercise.order_index === index && exercise.status === (index === 0 ? "active" : "pending") &&
      exercise.substituted_for_exercise_id === null && exercise.substitution_reason === "" &&
      exercise.equipment_snapshot === equipmentSnapshot && exercise.note === "" &&
      exercise.created_at === preparedAt && exercise.updated_at === preparedAt;
  });
}

function addedStructureExercise(
  before: readonly FitnessSessionExercise[],
  after: readonly FitnessSessionExercise[],
): FitnessSessionExercise | null {
  const beforeIds = new Set(before.map(({ id }) => id));
  const rows = after.filter(({ id }) => !beforeIds.has(id));
  return rows.length === 1 ? rows[0]! : null;
}

function isStructureAddTransition(receipt: FitnessLiveExerciseAddReceipt): boolean {
  const { context, before, after, preparedAt } = receipt;
  if (!isFitnessLiveEquipmentContext(context) || !isLiveSessionProjection(before) ||
      !isLiveSessionProjection(after) || before.session === null || after.session === null ||
      before.session.status !== "active" || context.venue.id !== before.session.venue_id ||
      !sameStructureSessionClock(before.session, after.session, preparedAt) ||
      !strictlyAfterEvery(preparedAt, [
        ...sessionProjectionVersions(before),
        ...structureContextVersions(context),
      ]) || !sameProjection(before.sets, after.sets) ||
      !sameProjection(before.cardioEntries, after.cardioEntries) ||
      !sameProjection(before.event, after.event) ||
      !sameProjection(before.capabilities, after.capabilities) ||
      after.exercises.length !== before.exercises.length + 1) return false;
  const added = addedStructureExercise(before.exercises, after.exercises);
  if (!added || !before.exercises.every((exercise) =>
    sameProjection(after.exercises.find(({ id }) => id === exercise.id), exercise)
  )) return false;
  const catalogExercise = getFitnessExercise(added.exercise_id);
  if (!catalogExercise) return false;
  let equipmentSnapshot: string;
  try {
    equipmentSnapshot = resolveStructureEquipmentSnapshot(
      catalogExercise,
      context,
      added.equipment_id,
      added.equipment_snapshot,
    );
  } catch {
    return false;
  }
  const nextOrder = before.exercises.reduce(
    (maximum, exercise) => Math.max(maximum, exercise.order_index + 1),
    0,
  );
  const unfinished = before.exercises.some(({ status }) => status === "active" || status === "pending");
  return LIVE_EXERCISE_ID_PATTERN.test(added.id) &&
    added.session_id === before.session.id && added.planned_item_id === null &&
    added.order_index === nextOrder && added.status === (unfinished ? "pending" : "active") &&
    added.substituted_for_exercise_id === null && added.substitution_reason === "" &&
    added.equipment_snapshot === equipmentSnapshot && added.note === "" &&
    added.created_at === preparedAt && added.updated_at === preparedAt;
}

function structureChangedExercises(
  before: readonly FitnessSessionExercise[],
  after: readonly FitnessSessionExercise[],
): readonly Readonly<{ before: FitnessSessionExercise; after: FitnessSessionExercise }>[] {
  if (before.length !== after.length) return [];
  const afterById = new Map(after.map((exercise) => [exercise.id, exercise]));
  return before.flatMap((prior) => {
    const next = afterById.get(prior.id);
    return next && !sameProjection(prior, next) ? [{ before: prior, after: next }] : [];
  });
}

function isStructureCompleteTransition(receipt: FitnessLiveExerciseCompleteReceipt): boolean {
  const { before, after, preparedAt } = receipt;
  if (!isLiveSessionProjection(before) || !isLiveSessionProjection(after) ||
      before.session === null || after.session === null || before.session.status !== "active" ||
      !sameStructureSessionClock(before.session, after.session, preparedAt) ||
      !strictlyAfterEvery(preparedAt, sessionProjectionVersions(before)) ||
      !sameProjection(before.sets, after.sets) ||
      !sameProjection(before.cardioEntries, after.cardioEntries) ||
      !sameProjection(before.event, after.event) ||
      !sameProjection(before.capabilities, after.capabilities)) return false;
  const changed = structureChangedExercises(before.exercises, after.exercises);
  const target = changed.find(({ after: row }) =>
    (row.status === "completed" || row.status === "skipped") && row.updated_at === preparedAt
  );
  if (!target || target.before.status !== "active" ||
      before.exercises.filter(({ status }) => status === "active").length !== 1 ||
      !sameProjection(target.after, {
        ...target.before,
        status: target.after.status,
        updated_at: preparedAt,
      })) return false;
  const targetSets = before.sets.filter(({ session_exercise_id }) =>
    session_exercise_id === target.before.id);
  if ((target.after.status === "completed" && targetSets.length === 0) ||
      (target.after.status === "skipped" && targetSets.length !== 0)) return false;
  const next = before.exercises
    .filter(({ order_index, status }) =>
      order_index > target.before.order_index && status === "pending")
    .sort((left, right) => left.order_index - right.order_index || compareLiveId(left.id, right.id))[0];
  const expectedChanged = next ? 2 : 1;
  if (changed.length !== expectedChanged) return false;
  return !next || changed.some(({ before: prior, after: current }) =>
    prior.id === next.id && sameProjection(current, {
      ...prior,
      status: "active",
      updated_at: preparedAt,
    })
  );
}

function isStructureSubstituteTransition(
  receipt: FitnessLiveExerciseSubstituteReceipt,
): boolean {
  const { context, before, after, preparedAt } = receipt;
  if (!isFitnessLiveEquipmentContext(context) || !isLiveSessionProjection(before) ||
      !isLiveSessionProjection(after) || before.session === null || after.session === null ||
      before.session.status !== "active" || context.venue.id !== before.session.venue_id ||
      !sameStructureSessionClock(before.session, after.session, preparedAt) ||
      !strictlyAfterEvery(preparedAt, [
        ...sessionProjectionVersions(before),
        ...structureContextVersions(context),
      ]) || !sameProjection(before.sets, after.sets) ||
      !sameProjection(before.cardioEntries, after.cardioEntries) ||
      !sameProjection(before.event, after.event) ||
      !sameProjection(before.capabilities, after.capabilities)) return false;
  const changed = structureChangedExercises(before.exercises, after.exercises);
  if (changed.length !== 1) return false;
  const target = changed[0]!;
  if (target.before.status !== "active" ||
      before.exercises.filter(({ status }) => status === "active").length !== 1 ||
      before.sets.some(({ session_exercise_id }) => session_exercise_id === target.before.id) ||
      target.after.exercise_id === target.before.exercise_id ||
      target.after.status !== target.before.status ||
      target.after.substituted_for_exercise_id !==
        (target.before.substituted_for_exercise_id ?? target.before.exercise_id) ||
      target.after.created_at !== target.before.created_at ||
      target.after.updated_at !== preparedAt || target.after.id !== target.before.id ||
      target.after.session_id !== target.before.session_id ||
      target.after.planned_item_id !== target.before.planned_item_id ||
      target.after.order_index !== target.before.order_index ||
      target.after.note !== target.before.note ||
      !safeString(target.after.substitution_reason, 10_000)) return false;
  const catalogExercise = getFitnessExercise(target.after.exercise_id);
  if (!catalogExercise) return false;
  try {
    return target.after.equipment_snapshot === resolveStructureEquipmentSnapshot(
      catalogExercise,
      context,
      target.after.equipment_id,
      target.after.equipment_snapshot,
    );
  } catch {
    return false;
  }
}

function isStructureReflectionTransition(
  receipt: FitnessLiveSessionReflectionReceipt,
): boolean {
  return isFitnessLiveSession(receipt.before) && isFitnessLiveSession(receipt.after) &&
    receipt.before.id === receipt.after.id && receipt.before.reflection !== receipt.after.reflection &&
    safeString(receipt.after.reflection, 4_000) &&
    receipt.preparedAt > receipt.before.updated_at &&
    sameProjection(receipt.after, {
      ...receipt.before,
      reflection: receipt.after.reflection,
      updated_at: receipt.preparedAt,
    });
}

function hasValidStructureReceiptBase(
  value: object,
  kind: FitnessLiveStructureWriteReceipt["kind"],
  keys: readonly string[],
): boolean {
  const receipt = value as Partial<FitnessLiveStructureWriteReceipt>;
  return exactObjectKeys(value, [
    "purpose", "version", "operationId", "generationId", "generationSequence",
    "preparedAt", "kind", "projectionSha256", ...keys,
  ]) && receipt.purpose === "fitness-live-structure-write" && receipt.version === 1 &&
    receipt.kind === kind && typeof receipt.operationId === "string" &&
    LIVE_STRUCTURE_OPERATION_ID_PATTERN.test(receipt.operationId) &&
    typeof receipt.generationId === "string" &&
    CONFIG_GENERATION_ID_PATTERN.test(receipt.generationId) &&
    liveInteger(receipt.generationSequence, 0, Number.MAX_SAFE_INTEGER) &&
    liveInteger(receipt.preparedAt, 0, Number.MAX_SAFE_INTEGER) &&
    typeof receipt.projectionSha256 === "string" &&
    CONFIG_HASH_PATTERN.test(receipt.projectionSha256);
}

function isFitnessLiveStructureWriteReceiptUnchecked(
  value: unknown,
): value is FitnessLiveStructureWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !jsonWithinUnits(value, LIVE_MAX_RECEIPT_JSON_UNITS)) return false;
  const receipt = value as Partial<FitnessLiveStructureWriteReceipt>;
  switch (receipt.kind) {
    case "session-start":
      return hasValidStructureReceiptBase(value, receipt.kind, ["context", "before", "after"]) &&
        isStructureStartTransition(receipt as FitnessLiveSessionStartReceipt);
    case "exercise-add":
      return hasValidStructureReceiptBase(value, receipt.kind, ["context", "before", "after"]) &&
        isStructureAddTransition(receipt as FitnessLiveExerciseAddReceipt);
    case "exercise-complete":
      return hasValidStructureReceiptBase(value, receipt.kind, ["before", "after"]) &&
        isStructureCompleteTransition(receipt as FitnessLiveExerciseCompleteReceipt);
    case "exercise-substitute":
      return hasValidStructureReceiptBase(value, receipt.kind, ["context", "before", "after"]) &&
        isStructureSubstituteTransition(receipt as FitnessLiveExerciseSubstituteReceipt);
    case "session-reflection":
      return hasValidStructureReceiptBase(value, receipt.kind, ["before", "after"]) &&
        isStructureReflectionTransition(receipt as FitnessLiveSessionReflectionReceipt);
    default:
      return false;
  }
}

export function isFitnessLiveStructureWriteReceipt(
  value: unknown,
): value is FitnessLiveStructureWriteReceipt {
  try {
    return isFitnessLiveStructureWriteReceiptUnchecked(value);
  } catch {
    return false;
  }
}

async function sealStructureReceipt<Receipt extends FitnessLiveStructureWriteReceipt>(
  draft: Omit<Receipt, "projectionSha256">,
): Promise<Receipt> {
  const projectionSha256 = await sha256Hex(canonicalJson(draft));
  return { ...draft, projectionSha256 } as Receipt;
}

async function structureReceiptHashIsValid(
  receipt: FitnessLiveStructureWriteReceipt,
): Promise<boolean> {
  const { projectionSha256, ...projection } = receipt;
  return projectionSha256 === await sha256Hex(canonicalJson(projection));
}

function snapshotStructureInput<Input>(value: Input): Input {
  try {
    return JSON.parse(JSON.stringify(value)) as Input;
  } catch {
    throw structureError("invalid_input", "训练结构写入内容不能安全复制。");
  }
}

export function createFitnessLiveStructureStorageService(
  runtime: FitnessLiveStorageRuntime = {
    withExclusiveLock: (operation) => withFitnessWriteLock(operation, { requireSupport: true }),
    query: async <Result extends object>(sql: string, params?: SqlParams) => ({
      rows: await rawQuery<Result>(sql, params),
    }),
    batch: (statements) => rawBatch(statements),
    currentGeneration: () => localDb.currentGeneration(DB),
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    broadcast: broadcastFitnessChange,
  },
) {
  async function prepareLocked<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await runtime.withExclusiveLock(operation);
    } catch (error) {
      if (error instanceof FitnessLiveStructureMutationError) throw error;
      if (error instanceof TypeError) throw structureError("invalid_input", error.message);
      throw structureError("inspect_failed", "暂时无法核对训练结构；没有开始写入。");
    }
  }

  async function prepareSessionStart(
    input: PrepareFitnessLiveSessionStartInput,
    expected: FitnessLiveStartExpectation,
  ): Promise<FitnessLiveSessionStartReceipt> {
    const stableInput = snapshotStructureInput(input);
    const stableExpected = snapshotStructureInput(expected);
    return prepareLocked(async () => {
      if (!stableInput || typeof stableInput !== "object" || Array.isArray(stableInput) ||
          !isFitnessLiveStartExpectation(stableExpected) ||
          !safeOpaqueId(stableInput.venueId) ||
          (stableInput.eventId !== undefined && stableInput.eventId !== null &&
            !safeOpaqueId(stableInput.eventId)) ||
          (stableInput.programDayId !== undefined && stableInput.programDayId !== null &&
            !safeOpaqueId(stableInput.programDayId)) ||
          (stableInput.availableMinutes !== undefined && stableInput.availableMinutes !== null &&
            !liveInteger(stableInput.availableMinutes, 1, 1_440)) ||
          (stableInput.energyNote !== undefined &&
            !["", "lower", "usual", "higher"].includes(stableInput.energyNote)) ||
          (stableInput.sorenessNote !== undefined &&
            typeof stableInput.sorenessNote !== "string")) {
        throw structureError("invalid_input", "开始训练的内容或画面快照无效。");
      }
      const eventId = stableInput.eventId ?? null;
      const eventProgramDayId = stableExpected.event?.program_day_id ?? null;
      const programDayId = stableInput.programDayId ?? eventProgramDayId;
      if (stableExpected.venue.id !== stableInput.venueId ||
          (eventId === null ? stableExpected.event !== null : stableExpected.event?.id !== eventId) ||
          (programDayId === null
            ? stableExpected.programDay !== null
            : stableExpected.programDay?.id !== programDayId) ||
          stableExpected.programItems.some((item, index) => item.order_index !== index)) {
        throw structureError("invalid_input", "开始训练的目标与当前画面不一致。");
      }
      const current = await readStructureStartExpectation(runtime, {
        venueId: stableInput.venueId,
        eventId,
        programDayId,
      });
      if (!current || !isFitnessLiveStartExpectation(current) ||
          !sameProjection(current, stableExpected)) {
        throw structureError("changed", "场地、计划或日历已在别处变化；没有准备开始训练。");
      }
      if (current.activeSessions.length !== 0) {
        throw structureError("changed", "已有一场进行中的训练；没有准备另一场。");
      }
      if (current.venue.status !== "active" ||
          current.event !== null && current.event.status !== "planned") {
        throw structureError("changed", "场地或日历安排已不可开始。");
      }
      const sorenessNote = stableInput.sorenessNote?.trim() ?? "";
      if (!safeString(sorenessNote, 20_000)) {
        throw structureError("invalid_input", "身体感受过长；没有准备开始训练。");
      }
      const generation = await readConfigGeneration(runtime);
      const preparedAt = nextLiveTimestamp(runtime.now(), startExpectationVersions(current));
      const sessionId = structureGeneratedId(runtime, "session-");
      const operationId = structureGeneratedId(runtime, "fitness-live-structure-operation-");
      const session: FitnessSession = {
        id: sessionId,
        event_id: eventId,
        venue_id: current.venue.id,
        program_day_id: programDayId,
        started_at: preparedAt,
        ended_at: null,
        status: "active",
        available_minutes: stableInput.availableMinutes ?? null,
        energy_note: stableInput.energyNote ?? "",
        soreness_note: sorenessNote,
        reflection: "",
        created_at: preparedAt,
        updated_at: preparedAt,
      };
      const exercises: FitnessSessionExercise[] = [];
      for (const [index, item] of current.programItems.entries()) {
        const exercise = getFitnessExercise(item.exercise_id);
        if (!exercise) throw structureError("changed", "训练日包含当前版本不识别的动作。");
        exercises.push({
          id: structureGeneratedId(runtime, "session-exercise-"),
          session_id: sessionId,
          exercise_id: item.exercise_id,
          equipment_id: item.equipment_id,
          planned_item_id: item.id,
          order_index: index,
          status: index === 0 ? "active" : "pending",
          substituted_for_exercise_id: null,
          substitution_reason: "",
          equipment_snapshot: resolveStructureEquipmentSnapshot(
            exercise,
            current,
            item.equipment_id,
            item.equipment_snapshot,
          ),
          note: "",
          created_at: preparedAt,
          updated_at: preparedAt,
        });
      }
      const receipt = await sealStructureReceipt<FitnessLiveSessionStartReceipt>({
        purpose: "fitness-live-structure-write",
        version: 1,
        operationId,
        ...generation,
        preparedAt,
        kind: "session-start",
        context: current,
        before: { activeSessions: current.activeSessions, event: current.event },
        after: {
          session,
          exercises,
          event: current.event === null ? null : {
            ...current.event,
            status: "in_progress",
            updated_at: preparedAt,
          },
        },
      });
      if (!isFitnessLiveStructureWriteReceipt(receipt)) {
        throw structureError("invalid_input", "无法构造可靠的开始训练回执。");
      }
      return receipt;
    });
  }

  async function prepareExerciseAdd(
    input: PrepareFitnessLiveExerciseAddInput,
    expected: FitnessLiveAddExpectation,
  ): Promise<FitnessLiveExerciseAddReceipt> {
    const stableInput = snapshotStructureInput(input);
    const stableExpected = snapshotStructureInput(expected);
    return prepareLocked(async () => {
      if (!stableInput || typeof stableInput !== "object" || Array.isArray(stableInput) ||
          !isFitnessLiveAddExpectation(stableExpected) ||
          !safeOpaqueId(stableInput.sessionId) || !safeOpaqueId(stableInput.exerciseId) ||
          (stableInput.equipmentId !== null && !safeOpaqueId(stableInput.equipmentId)) ||
          (stableInput.equipmentSnapshot !== undefined &&
            typeof stableInput.equipmentSnapshot !== "string")) {
        throw structureError("invalid_input", "新增动作的内容或画面快照无效。");
      }
      if (stableExpected.projection.session.id !== stableInput.sessionId) {
        throw structureError("invalid_input", "新增动作不属于当前训练画面。");
      }
      const [currentProjection, currentContext] = await Promise.all([
        readLiveSessionProjection(
          runtime,
          stableInput.sessionId,
          stableExpected.projection.session.event_id,
        ),
        readStructureEquipmentContext(runtime, stableExpected.venue.id),
      ]);
      if (!isLiveSessionProjection(currentProjection) || currentProjection.session === null ||
          !currentContext || !isFitnessLiveEquipmentContext(currentContext) ||
          !sameProjection(publicSessionExpectation(currentProjection), stableExpected.projection) ||
          !sameProjection(currentContext, equipmentContextOnly(stableExpected)) ||
          currentProjection.session.status !== "active") {
        throw structureError("changed", "训练现场或器材已在别处变化；没有准备新增动作。");
      }
      const currentNext = currentProjection.exercises.reduce(
        (maximum, exercise) => Math.max(maximum, exercise.order_index + 1),
        0,
      );
      if (stableExpected.nextOrderIndex !== currentNext) {
        throw structureError("changed", "动作顺序已变化；没有准备新增动作。");
      }
      const exercise = getFitnessExercise(stableInput.exerciseId);
      if (!exercise) throw structureError("invalid_input", "要新增的动作不存在。");
      const equipmentSnapshot = resolveStructureEquipmentSnapshot(
        exercise,
        currentContext,
        stableInput.equipmentId,
        stableInput.equipmentSnapshot,
      );
      const generation = await readConfigGeneration(runtime);
      const preparedAt = nextLiveTimestamp(runtime.now(), [
        ...sessionProjectionVersions(
          currentProjection as FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>,
        ),
        ...structureContextVersions(currentContext),
      ]);
      const exerciseId = structureGeneratedId(runtime, "session-exercise-");
      const operationId = structureGeneratedId(runtime, "fitness-live-structure-operation-");
      const unfinished = currentProjection.exercises.some(({ status }) =>
        status === "active" || status === "pending");
      const added: FitnessSessionExercise = {
        id: exerciseId,
        session_id: currentProjection.session.id,
        exercise_id: stableInput.exerciseId,
        equipment_id: stableInput.equipmentId,
        planned_item_id: null,
        order_index: currentNext,
        status: unfinished ? "pending" : "active",
        substituted_for_exercise_id: null,
        substitution_reason: "",
        equipment_snapshot: equipmentSnapshot,
        note: "",
        created_at: preparedAt,
        updated_at: preparedAt,
      };
      const receipt = await sealStructureReceipt<FitnessLiveExerciseAddReceipt>({
        purpose: "fitness-live-structure-write",
        version: 1,
        operationId,
        ...generation,
        preparedAt,
        kind: "exercise-add",
        context: currentContext,
        before: currentProjection as FitnessLiveSessionProjection & Readonly<{
          session: FitnessSession;
        }>,
        after: {
          ...currentProjection,
          session: { ...currentProjection.session, updated_at: preparedAt },
          exercises: sortedExercises([...currentProjection.exercises, added]),
        },
      });
      if (!isFitnessLiveStructureWriteReceipt(receipt)) {
        throw structureError("invalid_input", "无法构造可靠的新增动作回执。");
      }
      return receipt;
    });
  }

  async function prepareExerciseComplete(
    input: PrepareFitnessLiveExerciseCompleteInput,
    expected: FitnessLiveSessionExpectation,
  ): Promise<FitnessLiveExerciseCompleteReceipt> {
    const stableInput = snapshotStructureInput(input);
    const stableExpected = snapshotStructureInput(expected);
    return prepareLocked(async () => {
      if (!stableInput || typeof stableInput !== "object" || Array.isArray(stableInput) ||
          !isLiveSessionExpectation(stableExpected) ||
          !safeOpaqueId(stableInput.sessionExerciseId) ||
          (stableInput.skipped !== undefined && typeof stableInput.skipped !== "boolean")) {
        throw structureError("invalid_input", "更新动作的内容或画面快照无效。");
      }
      const targetExpected = stableExpected.exercises.find(
        ({ id }) => id === stableInput.sessionExerciseId,
      );
      if (!targetExpected) throw structureError("invalid_input", "目标动作不在当前训练画面。");
      const current = await readLiveSessionProjection(
        runtime,
        stableExpected.session.id,
        stableExpected.session.event_id,
      );
      if (!isLiveSessionProjection(current) || current.session === null ||
          !sameProjection(publicSessionExpectation(current), stableExpected) ||
          current.session.status !== "active") {
        throw structureError("changed", "训练现场已在别处变化；没有准备更新动作。");
      }
      const target = current.exercises.find(({ id }) => id === stableInput.sessionExerciseId);
      if (!target || target.status !== "active" ||
          current.exercises.filter(({ status }) => status === "active").length !== 1) {
        throw structureError("changed", "这个动作已不是可完成或跳过的状态。");
      }
      const targetSets = current.sets.filter(({ session_exercise_id }) =>
        session_exercise_id === target.id);
      const skipped = stableInput.skipped ?? false;
      if ((skipped && targetSets.length !== 0) || (!skipped && targetSets.length === 0)) {
        throw structureError(
          "changed",
          skipped ? "这个动作已有组记录，不能改写成未做。" : "这个动作还没有组记录，不能标记完成。",
        );
      }
      const generation = await readConfigGeneration(runtime);
      const preparedAt = nextLiveTimestamp(runtime.now(), sessionProjectionVersions(
        current as FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>,
      ));
      const next = current.exercises
        .filter(({ order_index, status }) =>
          order_index > target.order_index && status === "pending")
        .sort((left, right) => left.order_index - right.order_index ||
          compareLiveId(left.id, right.id))[0];
      const exercises = current.exercises.map((exercise) => {
        if (exercise.id === target.id) return {
          ...exercise,
          status: skipped ? "skipped" as const : "completed" as const,
          updated_at: preparedAt,
        };
        if (next && exercise.id === next.id) return {
          ...exercise,
          status: "active" as const,
          updated_at: preparedAt,
        };
        return exercise;
      });
      const operationId = structureGeneratedId(runtime, "fitness-live-structure-operation-");
      const receipt = await sealStructureReceipt<FitnessLiveExerciseCompleteReceipt>({
        purpose: "fitness-live-structure-write",
        version: 1,
        operationId,
        ...generation,
        preparedAt,
        kind: "exercise-complete",
        before: current as FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>,
        after: {
          ...current,
          session: { ...current.session, updated_at: preparedAt },
          exercises,
        },
      });
      if (!isFitnessLiveStructureWriteReceipt(receipt)) {
        throw structureError("invalid_input", "无法构造可靠的动作状态回执。");
      }
      return receipt;
    });
  }

  async function prepareExerciseSubstitute(
    input: PrepareFitnessLiveExerciseSubstituteInput,
    expected: FitnessLiveSubstituteExpectation,
  ): Promise<FitnessLiveExerciseSubstituteReceipt> {
    const stableInput = snapshotStructureInput(input);
    const stableExpected = snapshotStructureInput(expected);
    return prepareLocked(async () => {
      if (!stableInput || typeof stableInput !== "object" || Array.isArray(stableInput) ||
          !isFitnessLiveSubstituteExpectation(stableExpected) ||
          !safeOpaqueId(stableInput.sessionExerciseId) || !safeOpaqueId(stableInput.exerciseId) ||
          (stableInput.equipmentId !== null && !safeOpaqueId(stableInput.equipmentId)) ||
          (stableInput.equipmentSnapshot !== undefined &&
            typeof stableInput.equipmentSnapshot !== "string") ||
          typeof stableInput.reason !== "string") {
        throw structureError("invalid_input", "替换动作的内容或画面快照无效。");
      }
      const reason = stableInput.reason.trim();
      if (!safeString(reason, 10_000)) {
        throw structureError("invalid_input", "替换原因过长；没有准备替换动作。");
      }
      const [current, currentContext] = await Promise.all([
        readLiveSessionProjection(
          runtime,
          stableExpected.projection.session.id,
          stableExpected.projection.session.event_id,
        ),
        readStructureEquipmentContext(runtime, stableExpected.venue.id),
      ]);
      if (!isLiveSessionProjection(current) || current.session === null ||
          !currentContext || !isFitnessLiveEquipmentContext(currentContext) ||
          !sameProjection(publicSessionExpectation(current), stableExpected.projection) ||
          !sameProjection(currentContext, equipmentContextOnly(stableExpected)) ||
          current.session.status !== "active") {
        throw structureError("changed", "训练现场或器材已在别处变化；没有准备替换动作。");
      }
      const target = current.exercises.find(({ id }) => id === stableInput.sessionExerciseId);
      if (!target || target.status !== "active" ||
          current.exercises.filter(({ status }) => status === "active").length !== 1 ||
          stableInput.exerciseId === target.exercise_id ||
          current.sets.some(({ session_exercise_id }) => session_exercise_id === target.id)) {
        throw structureError("changed", "只有零组记录且未结束的动作可以替换。");
      }
      const replacement = getFitnessExercise(stableInput.exerciseId);
      if (!replacement) throw structureError("invalid_input", "替代动作不存在。");
      const equipmentSnapshot = resolveStructureEquipmentSnapshot(
        replacement,
        currentContext,
        stableInput.equipmentId,
        stableInput.equipmentSnapshot,
      );
      const generation = await readConfigGeneration(runtime);
      const preparedAt = nextLiveTimestamp(runtime.now(), [
        ...sessionProjectionVersions(
          current as FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>,
        ),
        ...structureContextVersions(currentContext),
      ]);
      const exercises = current.exercises.map((exercise) => exercise.id === target.id ? {
        ...exercise,
        exercise_id: stableInput.exerciseId,
        equipment_id: stableInput.equipmentId,
        substituted_for_exercise_id:
          exercise.substituted_for_exercise_id ?? exercise.exercise_id,
        substitution_reason: reason,
        equipment_snapshot: equipmentSnapshot,
        updated_at: preparedAt,
      } : exercise);
      const operationId = structureGeneratedId(runtime, "fitness-live-structure-operation-");
      const receipt = await sealStructureReceipt<FitnessLiveExerciseSubstituteReceipt>({
        purpose: "fitness-live-structure-write",
        version: 1,
        operationId,
        ...generation,
        preparedAt,
        kind: "exercise-substitute",
        context: currentContext,
        before: current as FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>,
        after: {
          ...current,
          session: { ...current.session, updated_at: preparedAt },
          exercises,
        },
      });
      if (!isFitnessLiveStructureWriteReceipt(receipt)) {
        throw structureError("invalid_input", "无法构造可靠的替换动作回执。");
      }
      return receipt;
    });
  }

  async function prepareSessionReflection(
    sessionId: string,
    reflection: string,
    expected: FitnessSession,
  ): Promise<FitnessLiveSessionReflectionReceipt> {
    const stableSessionId = snapshotStructureInput(sessionId);
    const stableReflection = snapshotStructureInput(reflection);
    const stableExpected = snapshotStructureInput(expected);
    return prepareLocked(async () => {
      const targetReflection = typeof stableReflection === "string"
        ? stableReflection.trim()
        : stableReflection;
      if (!safeOpaqueId(stableSessionId) || !isFitnessLiveSession(stableExpected) ||
          stableExpected.id !== stableSessionId ||
          !safeString(targetReflection, 4_000) || targetReflection === stableExpected.reflection) {
        throw structureError("invalid_input", "训练感受没有变化或内容无效。");
      }
      const current = await readLiveSession(runtime, stableSessionId);
      if (!current || !sameProjection(current, stableExpected)) {
        throw structureError("changed", "这场训练已在别处变化；没有准备覆盖训练感受。");
      }
      const generation = await readConfigGeneration(runtime);
      const preparedAt = nextLiveTimestamp(runtime.now(), [
        current.created_at,
        current.started_at,
        current.updated_at,
        ...(current.ended_at === null ? [] : [current.ended_at]),
      ]);
      const operationId = structureGeneratedId(runtime, "fitness-live-structure-operation-");
      const receipt = await sealStructureReceipt<FitnessLiveSessionReflectionReceipt>({
        purpose: "fitness-live-structure-write",
        version: 1,
        operationId,
        ...generation,
        preparedAt,
        kind: "session-reflection",
        before: current,
        after: { ...current, reflection: targetReflection, updated_at: preparedAt },
      });
      if (!isFitnessLiveStructureWriteReceipt(receipt)) {
        throw structureError("invalid_input", "无法构造可靠的训练感受回执。");
      }
      return receipt;
    });
  }

  function startTargetMatches(
    current: FitnessSession,
    receipt: FitnessLiveSessionStartReceipt,
  ): boolean {
    const target = receipt.after.session;
    return isFitnessLiveSession(current) && current.id === target.id &&
      current.event_id === target.event_id &&
      current.venue_id === target.venue_id && current.program_day_id === target.program_day_id &&
      current.started_at === target.started_at &&
      current.available_minutes === target.available_minutes &&
      current.energy_note === target.energy_note && current.soreness_note === target.soreness_note &&
      current.created_at === target.created_at && current.updated_at >= target.updated_at &&
      structureSessionLifecycleCanAdvance(target, current);
  }

  function structureSessionLifecycleCanAdvance(
    target: FitnessSession,
    current: FitnessSession,
  ): boolean {
    if (current.status === target.status && current.ended_at === target.ended_at) return true;
    return target.status === "active" && target.ended_at === null &&
      (current.status === "completed" || current.status === "ended_early") &&
      current.ended_at !== null && current.ended_at >= target.updated_at &&
      current.updated_at >= current.ended_at;
  }

  function structureExerciseStatusCanAdvance(
    target: FitnessSessionExercise["status"],
    current: FitnessSessionExercise["status"],
  ): boolean {
    if (target === "pending") {
      return current === "pending" || current === "active" ||
        current === "completed" || current === "skipped";
    }
    if (target === "active") {
      return current === "active" || current === "completed" || current === "skipped";
    }
    return current === target;
  }

  function startExerciseTargetMatches(
    current: FitnessSessionExercise,
    target: FitnessSessionExercise,
  ): boolean {
    if (!isFitnessLiveExercise(current) || current.id !== target.id ||
        current.session_id !== target.session_id ||
        current.planned_item_id !== target.planned_item_id ||
        current.order_index !== target.order_index || current.created_at !== target.created_at ||
        current.updated_at < target.updated_at ||
        !structureExerciseStatusCanAdvance(target.status, current.status)) return false;
    if (current.note !== target.note) return false;
    if (current.substituted_for_exercise_id === null) {
      return current.exercise_id === target.exercise_id &&
        current.equipment_id === target.equipment_id &&
        current.substitution_reason === target.substitution_reason &&
        current.equipment_snapshot === target.equipment_snapshot;
    }
    return current.substituted_for_exercise_id === target.exercise_id &&
      Boolean(getFitnessExercise(current.exercise_id));
  }

  function substituteTargetMatches(
    current: FitnessSessionExercise,
    target: FitnessSessionExercise,
  ): boolean {
    return isFitnessLiveExercise(current) && current.id === target.id &&
      current.session_id === target.session_id &&
      current.exercise_id === target.exercise_id && current.equipment_id === target.equipment_id &&
      current.planned_item_id === target.planned_item_id &&
      current.order_index === target.order_index &&
      current.substituted_for_exercise_id === target.substituted_for_exercise_id &&
      current.substitution_reason === target.substitution_reason &&
      current.equipment_snapshot === target.equipment_snapshot && current.note === target.note &&
      current.created_at === target.created_at && current.updated_at >= target.updated_at &&
      (current.status === "active" || current.status === "completed" ||
        current.status === "skipped");
  }

  function reflectionTargetMatches(
    current: FitnessSession,
    target: FitnessSession,
  ): boolean {
    if (!isFitnessLiveSession(current) || current.id !== target.id ||
        current.event_id !== target.event_id || current.venue_id !== target.venue_id ||
        current.program_day_id !== target.program_day_id ||
        current.started_at !== target.started_at ||
        current.available_minutes !== target.available_minutes ||
        current.energy_note !== target.energy_note ||
        current.soreness_note !== target.soreness_note ||
        current.reflection !== target.reflection || current.created_at !== target.created_at ||
        current.updated_at < target.updated_at) return false;
    return structureSessionLifecycleCanAdvance(target, current);
  }

  function structureReceiptMarkerKey(
    receipt: FitnessLiveStructureWriteReceipt,
  ): string {
    return `${LIVE_STRUCTURE_RECEIPT_MARKER_PREFIX}${receipt.operationId}`;
  }

  function structureReceiptMarkerValue(
    receipt: FitnessLiveStructureWriteReceipt,
  ): string {
    return canonicalJson({
      purpose: "fitness-live-structure-receipt-marker",
      version: 1,
      kind: receipt.kind,
      generationId: receipt.generationId,
      generationSequence: receipt.generationSequence,
      projectionSha256: receipt.projectionSha256,
    });
  }

  async function structureReceiptMarkerState(
    receipt: FitnessLiveStructureWriteReceipt,
  ): Promise<"absent" | "match" | "conflict"> {
    const rows = await liveRows<Readonly<{ value: string; updated_at: number }>>(
      runtime,
      "SELECT value,updated_at FROM fitness_settings WHERE key=? LIMIT 1",
      [structureReceiptMarkerKey(receipt)],
    );
    const row = rows[0];
    if (!row) return "absent";
    return row.value === structureReceiptMarkerValue(receipt) &&
        row.updated_at === receipt.preparedAt
      ? "match"
      : "conflict";
  }

  async function receiptStateUnlocked(
    receipt: FitnessLiveStructureWriteReceipt,
  ): Promise<Exclude<FitnessLiveStructureWriteInspection, "still_unknown" | "invalid_receipt">> {
    const generation = await readConfigGeneration(runtime);
    if (generation.generationId !== receipt.generationId ||
        generation.generationSequence !== receipt.generationSequence) return "changed";
    const markerState = await structureReceiptMarkerState(receipt);
    if (markerState === "conflict") return "changed";
    switch (receipt.kind) {
      case "session-start": {
        const currentTarget = await readLiveSession(runtime, receipt.after.session.id);
        const targetExercises = currentTarget && startTargetMatches(currentTarget, receipt)
          ? await Promise.all(receipt.after.exercises.map(({ id }) =>
            readLiveExercise(runtime, id)
          ))
          : [];
        const targetMatches = Boolean(currentTarget) &&
          targetExercises.length === receipt.after.exercises.length &&
          targetExercises.every((exercise, index) => exercise &&
            startExerciseTargetMatches(exercise, receipt.after.exercises[index]!));
        if (markerState === "match") {
          return targetMatches ? "exact_saved" : "changed";
        }
        if (currentTarget) return "changed";
        const current = await readStructureStartExpectation(runtime, {
          venueId: receipt.context.venue.id,
          eventId: receipt.context.event?.id ?? null,
          programDayId: receipt.context.programDay?.id ?? null,
        });
        return current && sameProjection(current, receipt.context) ? "expected" : "changed";
      }
      case "exercise-add": {
        const target = addedStructureExercise(receipt.before.exercises, receipt.after.exercises);
        if (!target) return "changed";
        const currentTarget = await readLiveExercise(runtime, target.id);
        const targetMatches = Boolean(currentTarget) &&
          startExerciseTargetMatches(currentTarget!, target);
        if (markerState === "match") {
          return targetMatches ? "exact_saved" : "changed";
        }
        if (currentTarget) return "changed";
        const [current, context] = await Promise.all([
          readLiveSessionProjection(
            runtime,
            receipt.before.session.id,
            receipt.before.event?.id ?? null,
          ),
          readStructureEquipmentContext(runtime, receipt.context.venue.id),
        ]);
        return sameProjection(current, receipt.before) && sameProjection(context, receipt.context)
          ? "expected"
          : "changed";
      }
      case "exercise-complete": {
        const changed = structureChangedExercises(receipt.before.exercises, receipt.after.exercises);
        const target = changed.find(({ after }) =>
          after.status === "completed" || after.status === "skipped");
        if (!target) return "changed";
        const currentTarget = await readLiveExercise(runtime, target.after.id);
        const targetMatches = sameProjection(currentTarget, target.after);
        if (markerState === "match") {
          return targetMatches ? "exact_saved" : "changed";
        }
        const current = await readLiveSessionProjection(
          runtime,
          receipt.before.session.id,
          receipt.before.event?.id ?? null,
        );
        return sameProjection(current, receipt.before) ? "expected" : "changed";
      }
      case "exercise-substitute": {
        const target = structureChangedExercises(
          receipt.before.exercises,
          receipt.after.exercises,
        )[0];
        if (!target) return "changed";
        const currentTarget = await readLiveExercise(runtime, target.after.id);
        const targetMatches = Boolean(currentTarget) &&
          substituteTargetMatches(currentTarget!, target.after);
        if (markerState === "match") {
          return targetMatches ? "exact_saved" : "changed";
        }
        const [current, context] = await Promise.all([
          readLiveSessionProjection(
            runtime,
            receipt.before.session.id,
            receipt.before.event?.id ?? null,
          ),
          readStructureEquipmentContext(runtime, receipt.context.venue.id),
        ]);
        return sameProjection(current, receipt.before) && sameProjection(context, receipt.context)
          ? "expected"
          : "changed";
      }
      case "session-reflection": {
        const current = await readLiveSession(runtime, receipt.before.id);
        const targetMatches = Boolean(current) && reflectionTargetMatches(
          current!,
          receipt.after,
        );
        if (markerState === "match") {
          return targetMatches ? "exact_saved" : "changed";
        }
        if (current && !sameProjection(current, receipt.before)) return "changed";
        return sameProjection(current, receipt.before) ? "expected" : "changed";
      }
    }
  }

  type StructurePredicate = Readonly<{ sql: string; params: readonly unknown[] }>;

  function joinedPredicate(predicates: readonly StructurePredicate[]): StructurePredicate {
    return {
      sql: predicates.length === 0
        ? "1"
        : predicates.map(({ sql }) => `(${sql})`).join(" AND "),
      params: predicates.flatMap(({ params }) => [...params]),
    };
  }

  function sessionPredicate(row: FitnessSession): StructurePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_sessions WHERE id=? AND event_id IS ?
        AND venue_id IS ? AND program_day_id IS ? AND started_at IS ? AND ended_at IS ?
        AND status IS ? AND available_minutes IS ? AND energy_note IS ?
        AND soreness_note IS ? AND reflection IS ? AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id, row.event_id, row.venue_id, row.program_day_id, row.started_at,
        row.ended_at, row.status, row.available_minutes, row.energy_note,
        row.soreness_note, row.reflection, row.created_at, row.updated_at,
      ],
    };
  }

  function exercisePredicate(row: FitnessSessionExercise): StructurePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_session_exercises WHERE id=? AND session_id IS ?
        AND exercise_id IS ? AND equipment_id IS ? AND planned_item_id IS ?
        AND order_index IS ? AND status IS ? AND substituted_for_exercise_id IS ?
        AND substitution_reason IS ? AND equipment_snapshot IS ? AND note IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id, row.session_id, row.exercise_id, row.equipment_id, row.planned_item_id,
        row.order_index, row.status, row.substituted_for_exercise_id,
        row.substitution_reason, row.equipment_snapshot, row.note, row.created_at,
        row.updated_at,
      ],
    };
  }

  function setPredicate(row: FitnessLiveSetSnapshot): StructurePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_sets WHERE id=? AND session_exercise_id IS ?
        AND set_index IS ? AND set_kind IS ? AND load_grams IS ? AND reps IS ?
        AND duration_seconds IS ? AND rir IS ? AND rpe IS ? AND completed IS ?
        AND pain_note IS ? AND completed_at IS ? AND client_mutation_id IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id, row.session_exercise_id, row.set_index, row.set_kind, row.load_grams,
        row.reps, row.duration_seconds, row.rir, row.rpe, Number(row.completed),
        row.pain_note, row.completed_at, row.client_mutation_id, row.created_at,
        row.updated_at,
      ],
    };
  }

  function cardioPredicate(row: FitnessCardioEntry): StructurePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_cardio_entries WHERE id=? AND session_id IS ?
        AND equipment_id IS ? AND mode IS ? AND duration_seconds IS ?
        AND distance_meters IS ? AND resistance IS ? AND average_heart_rate IS ?
        AND effort IS ? AND note IS ? AND created_at IS ?)`,
      params: [
        row.id, row.session_id, row.equipment_id, row.mode, row.duration_seconds,
        row.distance_meters, row.resistance, row.average_heart_rate, row.effort,
        row.note, row.created_at,
      ],
    };
  }

  function eventPredicate(row: FitnessCalendarEvent): StructurePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_calendar_events WHERE id=?
        AND program_day_id IS ? AND venue_id IS ? AND title IS ? AND kind IS ?
        AND starts_at IS ? AND occurrence_key IS ? AND planned_minutes IS ?
        AND status IS ? AND rescheduled_from_id IS ? AND note IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id, row.program_day_id, row.venue_id, row.title, row.kind, row.starts_at,
        row.occurrence_key, row.planned_minutes, row.status, row.rescheduled_from_id,
        row.note, row.created_at, row.updated_at,
      ],
    };
  }

  function capabilityPredicate(row: FitnessCapability): StructurePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_capabilities WHERE id=?
        AND exercise_id IS ? AND equipment_id IS ? AND source_set_id IS ?
        AND load_grams IS ? AND reps IS ? AND rir IS ? AND rpe IS ?
        AND confidence IS ? AND recorded_at IS ? AND created_at IS ?)`,
      params: [
        row.id, row.exercise_id, row.equipment_id, row.source_set_id, row.load_grams,
        row.reps, row.rir, row.rpe, row.confidence, row.recorded_at, row.created_at,
      ],
    };
  }

  function sessionProjectionPredicate(
    projection: FitnessLiveSessionProjection & Readonly<{ session: FitnessSession }>,
  ): StructurePredicate {
    return joinedPredicate([
      sessionPredicate(projection.session),
      {
        sql: "(SELECT COUNT(*) FROM fitness_session_exercises WHERE session_id=?)=?",
        params: [projection.session.id, projection.exercises.length],
      },
      ...projection.exercises.map(exercisePredicate),
      {
        sql: `(SELECT COUNT(*) FROM fitness_sets recorded_set
          JOIN fitness_session_exercises exercise
            ON exercise.id=recorded_set.session_exercise_id
          WHERE exercise.session_id=?)=?`,
        params: [projection.session.id, projection.sets.length],
      },
      ...projection.sets.map(setPredicate),
      {
        sql: "(SELECT COUNT(*) FROM fitness_cardio_entries WHERE session_id=?)=?",
        params: [projection.session.id, projection.cardioEntries.length],
      },
      ...projection.cardioEntries.map(cardioPredicate),
      projection.event === null ? { sql: "1", params: [] } : eventPredicate(projection.event),
      {
        sql: `(SELECT COUNT(*) FROM fitness_capabilities capability
          JOIN fitness_sets recorded_set ON recorded_set.id=capability.source_set_id
          JOIN fitness_session_exercises exercise
            ON exercise.id=recorded_set.session_exercise_id
          WHERE exercise.session_id=?)=?`,
        params: [projection.session.id, projection.capabilities.length],
      },
      ...projection.capabilities.map(capabilityPredicate),
    ]);
  }

  function venuePredicate(row: FitnessVenue): StructurePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_venues WHERE id=? AND name IS ?
        AND venue_type IS ? AND location IS ? AND area_notes IS ? AND busy_notes IS ?
        AND default_session_minutes IS ? AND supersets_allowed IS ? AND is_default IS ?
        AND status IS ? AND last_verified_at IS ? AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id, row.name, row.venue_type, row.location, row.area_notes, row.busy_notes,
        row.default_session_minutes, Number(row.supersets_allowed), Number(row.is_default),
        row.status, row.last_verified_at, row.created_at, row.updated_at,
      ],
    };
  }

  function equipmentPredicate(row: FitnessEquipment): StructurePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_equipment WHERE id=? AND venue_id IS ?
        AND name IS ? AND kind IS ? AND area IS ? AND quantity IS ? AND status IS ?
        AND load_mode IS ? AND load_semantics IS ? AND min_load_grams IS ?
        AND max_load_grams IS ? AND increment_grams IS ? AND bar_weight_grams IS ?
        AND unilateral IS ? AND busy_level IS ? AND json(settings_json)=json(?)
        AND json(attachments_json)=json(?) AND notes IS ? AND created_at IS ?
        AND updated_at IS ?)`,
      params: [
        row.id, row.venue_id, row.name, row.kind, row.area, row.quantity, row.status,
        row.load_mode, row.load_semantics, row.min_load_grams, row.max_load_grams,
        row.increment_grams, row.bar_weight_grams, Number(row.unilateral), row.busy_level,
        JSON.stringify(row.settings), JSON.stringify(row.attachments), row.notes,
        row.created_at, row.updated_at,
      ],
    };
  }

  function loadPredicate(row: FitnessEquipmentLoad): StructurePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_equipment_loads WHERE id=?
        AND equipment_id IS ? AND load_grams IS ? AND quantity IS ? AND label IS ?
        AND available IS ? AND created_at IS ?)`,
      params: [
        row.id, row.equipment_id, row.load_grams, row.quantity, row.label,
        Number(row.available), row.created_at,
      ],
    };
  }

  function constraintPredicate(row: FitnessConstraint): StructurePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_constraints WHERE id=? AND label IS ?
        AND body_area IS ? AND severity IS ? AND json(movement_patterns_json)=json(?)
        AND json(exercise_ids_json)=json(?) AND note IS ? AND active IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id, row.label, row.body_area, row.severity,
        JSON.stringify(row.movement_patterns), JSON.stringify(row.exercise_ids), row.note,
        Number(row.active), row.created_at, row.updated_at,
      ],
    };
  }

  function equipmentContextPredicate(
    context: FitnessLiveEquipmentContextExpectation,
  ): StructurePredicate {
    return joinedPredicate([
      venuePredicate(context.venue),
      {
        sql: "(SELECT COUNT(*) FROM fitness_equipment WHERE venue_id=?)=?",
        params: [context.venue.id, context.equipment.length],
      },
      ...context.equipment.map(equipmentPredicate),
      {
        sql: `(SELECT COUNT(*) FROM fitness_equipment_loads equipment_load
          JOIN fitness_equipment equipment ON equipment.id=equipment_load.equipment_id
          WHERE equipment.venue_id=?)=?`,
        params: [context.venue.id, context.equipmentLoads.length],
      },
      ...context.equipmentLoads.map(loadPredicate),
      {
        sql: `(SELECT COUNT(*) FROM fitness_constraints
          WHERE active=1 AND severity='avoid')=?`,
        params: [context.avoidConstraints.length],
      },
      ...context.avoidConstraints.map(constraintPredicate),
    ]);
  }

  function programPredicate(row: FitnessProgram): StructurePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_programs WHERE id=? AND name IS ?
        AND venue_id IS ? AND goal IS ? AND split IS ? AND status IS ? AND version IS ?
        AND source IS ? AND json(assumptions_json)=json(?) AND created_at IS ?
        AND updated_at IS ?)`,
      params: [
        row.id, row.name, row.venue_id, row.goal, row.split, row.status, row.version,
        row.source, JSON.stringify(row.assumptions), row.created_at, row.updated_at,
      ],
    };
  }

  function programDayPredicate(row: FitnessProgramDay): StructurePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_program_days WHERE id=? AND program_id IS ?
        AND day_index IS ? AND weekday IS ? AND kind IS ? AND name IS ? AND focus IS ?
        AND estimated_minutes IS ? AND variant IS ? AND created_at IS ?)`,
      params: [
        row.id, row.program_id, row.day_index, row.weekday, row.kind, row.name,
        row.focus, row.estimated_minutes, row.variant, row.created_at,
      ],
    };
  }

  function programItemPredicate(row: FitnessProgramItem): StructurePredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_program_items WHERE id=?
        AND program_day_id IS ? AND exercise_id IS ? AND equipment_id IS ?
        AND json(resource_equipment_ids_json)=json(?) AND order_index IS ? AND sets IS ?
        AND rep_min IS ? AND rep_max IS ? AND duration_seconds IS ? AND target_rir IS ?
        AND rest_seconds IS ? AND load_grams IS ? AND load_guidance IS ?
        AND rationale IS ? AND json(substitution_exercise_ids_json)=json(?)
        AND equipment_snapshot IS ? AND created_at IS ?)`,
      params: [
        row.id, row.program_day_id, row.exercise_id, row.equipment_id,
        JSON.stringify(row.resource_equipment_ids), row.order_index, row.sets, row.rep_min,
        row.rep_max, row.duration_seconds, row.target_rir, row.rest_seconds, row.load_grams,
        row.load_guidance, row.rationale, JSON.stringify(row.substitution_exercise_ids),
        row.equipment_snapshot, row.created_at,
      ],
    };
  }

  function startContextPredicate(context: FitnessLiveStartExpectation): StructurePredicate {
    const predicates: StructurePredicate[] = [
      equipmentContextPredicate(context),
      {
        sql: "(SELECT COUNT(*) FROM fitness_sessions WHERE status='active')=?",
        params: [context.activeSessions.length],
      },
      ...context.activeSessions.map(sessionPredicate),
      context.event === null ? { sql: "1", params: [] } : eventPredicate(context.event),
    ];
    if (context.program !== null && context.programDay !== null) {
      predicates.push(
        programPredicate(context.program),
        programDayPredicate(context.programDay),
        {
          sql: "(SELECT COUNT(*) FROM fitness_program_items WHERE program_day_id=?)=?",
          params: [context.programDay.id, context.programItems.length],
        },
        ...context.programItems.map(programItemPredicate),
      );
    }
    return joinedPredicate(predicates);
  }

  function absentPredicate(table: string, id: string): StructurePredicate {
    return { sql: `NOT EXISTS(SELECT 1 FROM ${table} WHERE id=?)`, params: [id] };
  }

  function receiptMarkerAbsentPredicate(
    receipt: FitnessLiveStructureWriteReceipt,
  ): StructurePredicate {
    return {
      sql: "NOT EXISTS(SELECT 1 FROM fitness_settings WHERE key=?)",
      params: [structureReceiptMarkerKey(receipt)],
    };
  }

  function casSentinel(predicate: StructurePredicate): SqlStatement {
    return {
      sql: `INSERT INTO fitness_settings(key,value,updated_at)
        SELECT '__fitness_live_structure_cas_abort__',NULL,0 WHERE NOT (${predicate.sql})`,
      params: predicate.params,
    };
  }

  function insertSession(row: FitnessSession): SqlStatement {
    return {
      sql: `INSERT INTO fitness_sessions(
        id,event_id,venue_id,program_day_id,started_at,ended_at,status,available_minutes,
        energy_note,soreness_note,reflection,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        row.id, row.event_id, row.venue_id, row.program_day_id, row.started_at,
        row.ended_at, row.status, row.available_minutes, row.energy_note,
        row.soreness_note, row.reflection, row.created_at, row.updated_at,
      ],
    };
  }

  function insertExercise(row: FitnessSessionExercise): SqlStatement {
    return {
      sql: `INSERT INTO fitness_session_exercises(
        id,session_id,exercise_id,equipment_id,planned_item_id,order_index,status,
        substituted_for_exercise_id,substitution_reason,equipment_snapshot,note,
        created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        row.id, row.session_id, row.exercise_id, row.equipment_id, row.planned_item_id,
        row.order_index, row.status, row.substituted_for_exercise_id,
        row.substitution_reason, row.equipment_snapshot, row.note, row.created_at,
        row.updated_at,
      ],
    };
  }

  function insertReceiptMarker(
    receipt: FitnessLiveStructureWriteReceipt,
  ): SqlStatement {
    return {
      sql: "INSERT INTO fitness_settings(key,value,updated_at) VALUES(?,?,?)",
      params: [
        structureReceiptMarkerKey(receipt),
        structureReceiptMarkerValue(receipt),
        receipt.preparedAt,
      ],
    };
  }

  function receiptStatements(receipt: FitnessLiveStructureWriteReceipt): SqlStatement[] {
    switch (receipt.kind) {
      case "session-start": {
        const predicate = joinedPredicate([
          startContextPredicate(receipt.context),
          absentPredicate("fitness_sessions", receipt.after.session.id),
          ...receipt.after.exercises.map((exercise) =>
            absentPredicate("fitness_session_exercises", exercise.id)),
          receiptMarkerAbsentPredicate(receipt),
        ]);
        return [
          casSentinel(predicate),
          insertSession(receipt.after.session),
          ...receipt.after.exercises.map(insertExercise),
          ...(receipt.after.event === null ? [] : [{
            sql: "UPDATE fitness_calendar_events SET status='in_progress',updated_at=? WHERE id=?",
            params: [receipt.after.event.updated_at, receipt.after.event.id],
          }]),
          insertReceiptMarker(receipt),
        ];
      }
      case "exercise-add": {
        const target = addedStructureExercise(receipt.before.exercises, receipt.after.exercises);
        if (!target) throw structureError("invalid_receipt", "新增动作回执缺少目标行。", receipt);
        return [
          casSentinel(joinedPredicate([
            sessionProjectionPredicate(receipt.before),
            equipmentContextPredicate(receipt.context),
            absentPredicate("fitness_session_exercises", target.id),
            receiptMarkerAbsentPredicate(receipt),
          ])),
          insertExercise(target),
          {
            sql: "UPDATE fitness_sessions SET updated_at=? WHERE id=?",
            params: [receipt.preparedAt, receipt.before.session.id],
          },
          insertReceiptMarker(receipt),
        ];
      }
      case "exercise-complete": {
        const changed = structureChangedExercises(receipt.before.exercises, receipt.after.exercises);
        return [
          casSentinel(joinedPredicate([
            sessionProjectionPredicate(receipt.before),
            receiptMarkerAbsentPredicate(receipt),
          ])),
          ...changed.map(({ after }) => ({
            sql: "UPDATE fitness_session_exercises SET status=?,updated_at=? WHERE id=?",
            params: [after.status, after.updated_at, after.id],
          })),
          {
            sql: "UPDATE fitness_sessions SET updated_at=? WHERE id=?",
            params: [receipt.preparedAt, receipt.before.session.id],
          },
          insertReceiptMarker(receipt),
        ];
      }
      case "exercise-substitute": {
        const target = structureChangedExercises(receipt.before.exercises, receipt.after.exercises)[0];
        if (!target) throw structureError("invalid_receipt", "替换动作回执缺少目标行。", receipt);
        return [
          casSentinel(joinedPredicate([
            sessionProjectionPredicate(receipt.before),
            equipmentContextPredicate(receipt.context),
            receiptMarkerAbsentPredicate(receipt),
          ])),
          {
            sql: `UPDATE fitness_session_exercises SET exercise_id=?,equipment_id=?,
              substituted_for_exercise_id=?,substitution_reason=?,equipment_snapshot=?,
              updated_at=? WHERE id=?`,
            params: [
              target.after.exercise_id, target.after.equipment_id,
              target.after.substituted_for_exercise_id, target.after.substitution_reason,
              target.after.equipment_snapshot, target.after.updated_at, target.after.id,
            ],
          },
          {
            sql: "UPDATE fitness_sessions SET updated_at=? WHERE id=?",
            params: [receipt.preparedAt, receipt.before.session.id],
          },
          insertReceiptMarker(receipt),
        ];
      }
      case "session-reflection":
        return [
          casSentinel(joinedPredicate([
            sessionPredicate(receipt.before),
            receiptMarkerAbsentPredicate(receipt),
          ])),
          {
            sql: "UPDATE fitness_sessions SET reflection=?,updated_at=? WHERE id=?",
            params: [receipt.after.reflection, receipt.after.updated_at, receipt.after.id],
          },
          insertReceiptMarker(receipt),
        ];
    }
  }

  function receiptEntity(receipt: FitnessLiveStructureWriteReceipt): {
    id: string;
    updatedAt: number;
    reason: string;
  } {
    switch (receipt.kind) {
      case "session-start":
        return { id: receipt.after.session.id, updatedAt: receipt.preparedAt, reason: "session-started" };
      case "exercise-add":
        return {
          id: addedStructureExercise(receipt.before.exercises, receipt.after.exercises)?.id ??
            receipt.before.session.id,
          updatedAt: receipt.preparedAt,
          reason: "session-exercise-added",
        };
      case "exercise-complete": {
        const target = structureChangedExercises(receipt.before.exercises, receipt.after.exercises)
          .find(({ after }) => after.status === "completed" || after.status === "skipped");
        return {
          id: target?.after.id ?? receipt.before.session.id,
          updatedAt: receipt.preparedAt,
          reason: "session-exercise-updated",
        };
      }
      case "exercise-substitute":
        return {
          id: structureChangedExercises(receipt.before.exercises, receipt.after.exercises)[0]
            ?.after.id ?? receipt.before.session.id,
          updatedAt: receipt.preparedAt,
          reason: "exercise-substituted",
        };
      case "session-reflection":
        return {
          id: receipt.after.id,
          updatedAt: receipt.after.updated_at,
          reason: "session-reflection-updated",
        };
    }
  }

  function safeBroadcast(reason: string): void {
    try {
      runtime.broadcast(reason);
    } catch {
      // A refresh hint cannot reverse a durable commit.
    }
  }

  async function inspectWrite(value: unknown): Promise<FitnessLiveStructureWriteInspection> {
    if (!isFitnessLiveStructureWriteReceipt(value)) return "invalid_receipt";
    let receipt: FitnessLiveStructureWriteReceipt;
    try {
      receipt = snapshotStructureInput(value);
    } catch {
      return "invalid_receipt";
    }
    if (!isFitnessLiveStructureWriteReceipt(receipt)) return "invalid_receipt";
    try {
      if (!await structureReceiptHashIsValid(receipt)) return "invalid_receipt";
    } catch {
      return "invalid_receipt";
    }
    try {
      return await runtime.withExclusiveLock(() => receiptStateUnlocked(receipt));
    } catch {
      return "still_unknown";
    }
  }

  async function commitWrite(value: unknown): Promise<FitnessLiveStructureWriteResult> {
    if (!isFitnessLiveStructureWriteReceipt(value)) {
      throw structureError("invalid_receipt", "训练结构写入回执无效；没有改动现场记录。");
    }
    let receipt: FitnessLiveStructureWriteReceipt;
    try {
      receipt = snapshotStructureInput(value);
    } catch {
      throw structureError("invalid_receipt", "训练结构写入回执无效；没有改动现场记录。");
    }
    if (!isFitnessLiveStructureWriteReceipt(receipt)) {
      throw structureError("invalid_receipt", "训练结构写入回执无效；没有改动现场记录。");
    }
    try {
      if (!await structureReceiptHashIsValid(receipt)) {
        throw structureError("invalid_receipt", "训练结构写入回执无效；没有改动现场记录。");
      }
    } catch (error) {
      if (error instanceof FitnessLiveStructureMutationError) throw error;
      throw structureError("invalid_receipt", "训练结构写入回执无法验证；没有改动现场记录。");
    }
    const entity = receiptEntity(receipt);
    try {
      return await runtime.withExclusiveLock(async () => {
        const before = await receiptStateUnlocked(receipt);
        if (before === "exact_saved") {
          safeBroadcast(entity.reason);
          return {
            outcome: "already_saved",
            receipt,
            entityId: entity.id,
            updatedAt: entity.updatedAt,
          };
        }
        if (before === "changed") {
          return { outcome: "changed", receipt, entityId: entity.id, retryable: false };
        }
        try {
          await runtime.batch(receiptStatements(receipt));
        } catch {
          // The transaction may have committed even when its response was lost.
        }
        const after = await receiptStateUnlocked(receipt);
        if (after === "exact_saved") {
          safeBroadcast(entity.reason);
          return {
            outcome: "saved",
            receipt,
            entityId: entity.id,
            updatedAt: entity.updatedAt,
          };
        }
        if (after === "expected") {
          throw structureError(
            "write_failed",
            "这次训练结构确定没有写入；保留回执后可以重试。",
            receipt,
          );
        }
        return { outcome: "changed", receipt, entityId: entity.id, retryable: false };
      });
    } catch (error) {
      if (error instanceof FitnessLiveStructureMutationError) throw error;
      return {
        outcome: "outcome_uncertain",
        receipt,
        entityId: entity.id,
        retryable: true,
      };
    }
  }

  return {
    prepareFitnessLiveSessionStart: prepareSessionStart,
    prepareFitnessLiveExerciseAdd: prepareExerciseAdd,
    prepareFitnessLiveExerciseComplete: prepareExerciseComplete,
    prepareFitnessLiveExerciseSubstitute: prepareExerciseSubstitute,
    prepareFitnessLiveSessionReflection: prepareSessionReflection,
    inspectFitnessLiveStructureWrite: inspectWrite,
    commitFitnessLiveStructureWrite: commitWrite,
  } as const;
}

const defaultFitnessLiveStructureStorageService = createFitnessLiveStructureStorageService();

export const prepareFitnessLiveSessionStart =
  defaultFitnessLiveStructureStorageService.prepareFitnessLiveSessionStart;
export const prepareFitnessLiveExerciseAdd =
  defaultFitnessLiveStructureStorageService.prepareFitnessLiveExerciseAdd;
export const prepareFitnessLiveExerciseComplete =
  defaultFitnessLiveStructureStorageService.prepareFitnessLiveExerciseComplete;
export const prepareFitnessLiveExerciseSubstitute =
  defaultFitnessLiveStructureStorageService.prepareFitnessLiveExerciseSubstitute;
export const prepareFitnessLiveSessionReflection =
  defaultFitnessLiveStructureStorageService.prepareFitnessLiveSessionReflection;
export const inspectFitnessLiveStructureWrite =
  defaultFitnessLiveStructureStorageService.inspectFitnessLiveStructureWrite;
export const commitFitnessLiveStructureWrite =
  defaultFitnessLiveStructureStorageService.commitFitnessLiveStructureWrite;

export type PrepareFitnessProgramVersionScheduleInput = Readonly<{
  draft: FitnessPlanDraft;
  source?: FitnessProgram["source"];
  anchorAt: number;
}>;

export type PrepareFitnessProgramWeekScheduleInput = Readonly<{
  programId: string;
  anchorAt: number;
}>;

export type FitnessProgramEnvironmentExpectation = Readonly<{
  activePrograms: readonly FitnessProgram[];
  logicalPrograms: readonly FitnessProgram[];
  venue: FitnessVenue;
  equipment: readonly FitnessEquipment[];
  equipmentLoads: readonly FitnessEquipmentLoad[];
  activeConstraints: readonly FitnessConstraint[];
}>;

export type FitnessProgramVersionScheduleExpectation =
  FitnessProgramEnvironmentExpectation;

export type FitnessProgramWeekScheduleExpectation =
  FitnessProgramEnvironmentExpectation & Readonly<{
    anchorAt: number;
    program: FitnessProgram;
    days: readonly FitnessProgramDay[];
    items: readonly FitnessProgramItem[];
    occurrences: readonly FitnessCalendarEvent[];
  }>;

type FitnessProgramReceiptBase<Kind extends string> = Readonly<{
  purpose: "fitness-program-write";
  version: 1;
  operationId: string;
  generationId: string;
  generationSequence: number;
  preparedAt: number;
  kind: Kind;
  projectionSha256: string;
}>;

export type FitnessProgramVersionScheduleReceipt =
  FitnessProgramReceiptBase<"program-version-schedule"> & Readonly<{
    request: Readonly<{
      draft: FitnessPlanDraft;
      source: FitnessProgram["source"];
      anchorAt: number;
      scheduleTimeZone: string;
    }>;
    before: FitnessProgramVersionScheduleExpectation;
    after: Readonly<{
      archivedPrograms: readonly FitnessProgram[];
      program: FitnessProgram;
      days: readonly FitnessProgramDay[];
      items: readonly FitnessProgramItem[];
      events: readonly FitnessCalendarEvent[];
    }>;
  }>;

export type FitnessProgramWeekScheduleReceipt =
  FitnessProgramReceiptBase<"program-week-schedule"> & Readonly<{
    request: Readonly<{
      programId: string;
      anchorAt: number;
      scheduleTimeZone: string;
    }>;
    before: FitnessProgramWeekScheduleExpectation;
    after: Readonly<{
      events: readonly FitnessCalendarEvent[];
      createdEventIds: readonly string[];
    }>;
  }>;

export type FitnessProgramWriteReceipt =
  | FitnessProgramVersionScheduleReceipt
  | FitnessProgramWeekScheduleReceipt;

export type FitnessProgramWriteInspection = FitnessLiveWriteInspection;

export type FitnessProgramWriteResult =
  | Readonly<{
      outcome: "saved" | "already_saved";
      receipt: FitnessProgramWriteReceipt;
      entityId: string;
      updatedAt: number;
    }>
  | Readonly<{
      outcome: "changed";
      receipt: FitnessProgramWriteReceipt;
      entityId: string;
      retryable: false;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      receipt: FitnessProgramWriteReceipt;
      entityId: string;
      retryable: true;
    }>;

export class FitnessProgramMutationError extends Error {
  readonly name = "FitnessProgramMutationError";

  constructor(
    readonly code: FitnessLiveMutationErrorCode,
    message: string,
    readonly receipt?: FitnessProgramWriteReceipt,
  ) {
    super(message);
  }
}

export type PrepareFitnessCalendarRescheduleInput = Readonly<{
  eventId: string;
  startsAt: number;
}>;

export type PrepareFitnessCalendarNotPerformedInput = Readonly<{
  eventId: string;
  note?: string;
}>;

type FitnessCalendarReceiptBase<Kind extends string> = Readonly<{
  purpose: "fitness-calendar-write";
  version: 1;
  operationId: string;
  generationId: string;
  generationSequence: number;
  preparedAt: number;
  kind: Kind;
  projectionSha256: string;
}>;

export type FitnessCalendarRescheduleReceipt =
  FitnessCalendarReceiptBase<"calendar-reschedule"> & Readonly<{
    before: FitnessCalendarEvent;
    after: FitnessCalendarEvent;
  }>;

export type FitnessCalendarNotPerformedReceipt =
  FitnessCalendarReceiptBase<"calendar-not-performed"> & Readonly<{
    before: FitnessCalendarEvent;
    after: FitnessCalendarEvent;
  }>;

export type FitnessCalendarWriteReceipt =
  | FitnessCalendarRescheduleReceipt
  | FitnessCalendarNotPerformedReceipt;

export type FitnessCalendarWriteInspection = FitnessLiveWriteInspection;

export type FitnessCalendarWriteResult =
  | Readonly<{
      outcome: "saved" | "already_saved";
      receipt: FitnessCalendarWriteReceipt;
      entityId: string;
      updatedAt: number;
    }>
  | Readonly<{
      outcome: "changed";
      receipt: FitnessCalendarWriteReceipt;
      entityId: string;
      retryable: false;
    }>
  | Readonly<{
      outcome: "outcome_uncertain";
      receipt: FitnessCalendarWriteReceipt;
      entityId: string;
      retryable: true;
    }>;

export class FitnessCalendarMutationError extends Error {
  readonly name = "FitnessCalendarMutationError";

  constructor(
    readonly code: FitnessLiveMutationErrorCode,
    message: string,
    readonly receipt?: FitnessCalendarWriteReceipt,
  ) {
    super(message);
  }
}

const PROGRAM_OPERATION_ID_PATTERN =
  /^fitness-program-operation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALENDAR_OPERATION_ID_PATTERN =
  /^fitness-calendar-operation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROGRAM_ID_PATTERN =
  /^program-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROGRAM_DAY_ID_PATTERN =
  /^program-day-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROGRAM_ITEM_ID_PATTERN =
  /^program-item-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROGRAM_EVENT_ID_PATTERN =
  /^event-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROGRAM_RECEIPT_MARKER_PREFIX = "__fitness_program_receipt__:";

function programError(
  code: FitnessLiveMutationErrorCode,
  message: string,
  receipt?: FitnessProgramWriteReceipt,
): FitnessProgramMutationError {
  return new FitnessProgramMutationError(code, message, receipt);
}

function calendarError(
  code: FitnessLiveMutationErrorCode,
  message: string,
  receipt?: FitnessCalendarWriteReceipt,
): FitnessCalendarMutationError {
  return new FitnessCalendarMutationError(code, message, receipt);
}

function sortedPrograms(rows: readonly FitnessProgram[]): FitnessProgram[] {
  return [...rows].sort((left, right) =>
    left.version - right.version || compareLiveId(left.id, right.id)
  );
}

function sortedProgramDays(rows: readonly FitnessProgramDay[]): FitnessProgramDay[] {
  return [...rows].sort((left, right) =>
    left.day_index - right.day_index || compareLiveId(left.id, right.id)
  );
}

function sortedProgramEvents(rows: readonly FitnessCalendarEvent[]): FitnessCalendarEvent[] {
  return [...rows].sort((left, right) =>
    compareLiveId(left.program_day_id ?? "", right.program_day_id ?? "") ||
    compareLiveId(left.occurrence_key ?? "", right.occurrence_key ?? "") ||
    compareLiveId(left.id, right.id)
  );
}

type ProgramLogicalKey = Readonly<{
  venueId: string;
  name: string;
  goal: FitnessProgram["goal"];
  split: FitnessProgram["split"];
}>;

function programLogicalKeyFromDraft(draft: FitnessPlanDraft): ProgramLogicalKey {
  return {
    venueId: draft.venue_id,
    name: draft.name.trim(),
    goal: draft.goal,
    split: draft.split,
  };
}

function programLogicalKeyFromProgram(program: FitnessProgram): ProgramLogicalKey {
  return {
    venueId: program.venue_id,
    name: program.name,
    goal: program.goal,
    split: program.split,
  };
}

function programMatchesLogicalKey(
  program: FitnessProgram,
  key: ProgramLogicalKey,
): boolean {
  return program.venue_id === key.venueId && program.name === key.name &&
    program.goal === key.goal && program.split === key.split;
}

function isFitnessProgramDraftForReceipt(value: unknown): value is FitnessPlanDraft {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !jsonWithinUnits(value, LIVE_MAX_EXPECTATION_JSON_UNITS) || !exactObjectKeys(value, [
        "name", "venue_id", "goal", "split", "assumptions", "warnings", "days",
      ])) return false;
  const draft = value as Partial<FitnessPlanDraft>;
  if (!safeString(draft.name, 160) || draft.name.trim().length === 0 ||
      !safeOpaqueId(draft.venue_id) || !FITNESS_GOALS.has(String(draft.goal)) ||
      !["auto", "full_body", "upper_lower", "push_pull_legs", "custom"]
        .includes(String(draft.split)) ||
      !safeStringArray(draft.assumptions, 100) || !uniqueExactStrings(draft.assumptions) ||
      !draft.assumptions.every((entry) => safeString(entry, 500) && entry.trim().length > 0) ||
      !safeStringArray(draft.warnings, 100) ||
      !draft.warnings.every((entry) => safeString(entry, 1_000)) ||
      !Array.isArray(draft.days) || draft.days.length === 0 || draft.days.length > 28) return false;
  let itemCount = 0;
  for (const [dayIndex, day] of draft.days.entries()) {
    if (!day || typeof day !== "object" || Array.isArray(day) || !exactObjectKeys(day, [
      "weekday", "kind", "name", "focus", "estimated_minutes", "items",
    ]) || !(day.weekday === null || liveInteger(day.weekday, 0, 6)) ||
        !["resistance", "cardio", "rest"].includes(String(day.kind)) ||
        !safeString(day.name, 10_000) || day.name.trim().length === 0 ||
        !safeString(day.focus, 10_000) || !liveInteger(day.estimated_minutes, 0, 240) ||
        !Array.isArray(day.items) || day.items.length > LIVE_MAX_ATOMIC_ROWS) return false;
    itemCount += day.items.length;
    if (itemCount > LIVE_MAX_ATOMIC_ROWS) return false;
    for (const [itemIndex, item] of day.items.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item) ||
          !exactObjectKeys(item, [
            "exercise_id", "equipment_id", "resource_equipment_ids", "order_index",
            "sets", "rep_min", "rep_max", "duration_seconds", "target_rir",
            "rest_seconds", "load_grams", "load_guidance", "rationale",
            "substitution_exercise_ids", "equipment_snapshot",
          ]) || item.order_index !== itemIndex || !isFitnessLiveProgramItem({
            ...item,
            id: `draft-item-${dayIndex}-${itemIndex}`,
            program_day_id: `draft-day-${dayIndex}`,
            created_at: 0,
          })) return false;
    }
  }
  return true;
}

function isFitnessProgramEnvironment(
  value: unknown,
): value is FitnessProgramEnvironmentExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !jsonWithinUnits(value, LIVE_MAX_EXPECTATION_JSON_UNITS) || !exactObjectKeys(value, [
        "activePrograms", "logicalPrograms", "venue", "equipment", "equipmentLoads",
        "activeConstraints",
      ])) return false;
  const expected = value as Partial<FitnessProgramEnvironmentExpectation>;
  if (!Array.isArray(expected.activePrograms) || !Array.isArray(expected.logicalPrograms) ||
      !Array.isArray(expected.equipment) || !Array.isArray(expected.equipmentLoads) ||
      !Array.isArray(expected.activeConstraints) || !isFitnessVenueRow(expected.venue)) return false;
  const total = expected.activePrograms.length + expected.logicalPrograms.length +
    expected.equipment.length + expected.equipmentLoads.length +
    expected.activeConstraints.length;
  if (total > LIVE_MAX_ATOMIC_ROWS || !uniqueIds(expected.activePrograms) ||
      !uniqueIds(expected.logicalPrograms) || !uniqueIds(expected.equipment) ||
      !uniqueIds(expected.equipmentLoads) || !uniqueIds(expected.activeConstraints) ||
      !expected.activePrograms.every((row) => isFitnessLiveProgram(row) && row.status === "active") ||
      !expected.logicalPrograms.every(isFitnessLiveProgram) ||
      !expected.equipment.every((row) => isFitnessEquipmentRow(row) &&
        row.venue_id === expected.venue?.id) ||
      !expected.equipmentLoads.every(isFitnessEquipmentLoadRow) ||
      !expected.activeConstraints.every((row) => isFitnessConstraintRow(row) && row.active) ||
      !isSortedProjection(expected.activePrograms, sortedPrograms) ||
      !isSortedProjection(expected.logicalPrograms, sortedPrograms) ||
      !isSortedProjection(expected.equipment, sortedEquipment) ||
      !isSortedProjection(expected.equipmentLoads, sortedEquipmentLoads) ||
      !isSortedProjection(expected.activeConstraints, sortedConstraints)) return false;
  const equipmentIds = new Set(expected.equipment.map(({ id }) => id));
  return expected.equipmentLoads.every(({ equipment_id }) => equipmentIds.has(equipment_id));
}

function programEnvironmentOnly(
  value: FitnessProgramEnvironmentExpectation,
): FitnessProgramEnvironmentExpectation {
  return {
    activePrograms: value.activePrograms,
    logicalPrograms: value.logicalPrograms,
    venue: value.venue,
    equipment: value.equipment,
    equipmentLoads: value.equipmentLoads,
    activeConstraints: value.activeConstraints,
  };
}

function isFitnessProgramVersionScheduleExpectation(
  value: unknown,
): value is FitnessProgramVersionScheduleExpectation {
  return isFitnessProgramEnvironment(value);
}

type ProgramScheduleSlot = Readonly<{
  day: FitnessProgramDay;
  startsAt: number;
  occurrenceKey: string;
}>;

type ProgramCivilDateTime = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

function isCanonicalProgramTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 100 ||
      value !== value.trim()) return false;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value })
      .resolvedOptions().timeZone === value;
  } catch {
    return false;
  }
}

function currentProgramTimeZone(): string {
  const value = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!isCanonicalProgramTimeZone(value)) {
    throw programError("invalid_input", "无法冻结当前时区，未准备计划排期。");
  }
  return value;
}

function civilDateTimeAt(timestamp: number, timeZone: string): ProgramCivilDateTime {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  const result = {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
  if (!Object.values(result).every(Number.isSafeInteger)) {
    throw new RangeError("invalid zoned civil time");
  }
  return result;
}

function addProgramCivilDays(
  value: Pick<ProgramCivilDateTime, "year" | "month" | "day">,
  days: number,
): Pick<ProgramCivilDateTime, "year" | "month" | "day"> {
  const next = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function epochForProgramCivilTime(
  value: ProgramCivilDateTime,
  timeZone: string,
): number {
  const desired = Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
  );
  let candidate = desired;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = civilDateTimeAt(candidate, timeZone);
    const represented = Date.UTC(
      current.year,
      current.month - 1,
      current.day,
      current.hour,
      current.minute,
      current.second,
    );
    const adjustment = desired - represented;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  const verified = civilDateTimeAt(candidate, timeZone);
  if (!sameProjection(verified, value) || !safeTimestamp(candidate)) {
    throw new RangeError("unrepresentable zoned civil time");
  }
  return candidate;
}

function programScheduleSlots(
  days: readonly FitnessProgramDay[],
  anchorAt: number,
  scheduleTimeZone: string,
): ProgramScheduleSlot[] {
  if (!safeTimestamp(anchorAt) || !isCanonicalProgramTimeZone(scheduleTimeZone)) return [];
  try {
    const anchorCivil = civilDateTimeAt(anchorAt, scheduleTimeZone);
    const anchorWeekday = new Date(Date.UTC(
      anchorCivil.year,
      anchorCivil.month - 1,
      anchorCivil.day,
    )).getUTCDay();
    return sortedProgramDays(days).flatMap((day) => {
      if (day.weekday === null || day.kind === "rest") return [];
      const delta = (day.weekday - anchorWeekday + 7) % 7;
      let targetDate = addProgramCivilDays(anchorCivil, delta);
      let startsAt = epochForProgramCivilTime({
        ...targetDate,
        hour: 18,
        minute: 0,
        second: 0,
      }, scheduleTimeZone);
      if (startsAt < anchorAt) {
        targetDate = addProgramCivilDays(targetDate, 7);
        startsAt = epochForProgramCivilTime({
          ...targetDate,
          hour: 18,
          minute: 0,
          second: 0,
        }, scheduleTimeZone);
      }
      return [{
        day,
        startsAt,
        occurrenceKey: [
          targetDate.year,
          String(targetDate.month).padStart(2, "0"),
          String(targetDate.day).padStart(2, "0"),
        ].join("-"),
      }];
    });
  } catch {
    return [];
  }
}

function isFitnessProgramWeekScheduleExpectation(
  value: unknown,
  scheduleTimeZone: string,
): value is FitnessProgramWeekScheduleExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !jsonWithinUnits(value, LIVE_MAX_EXPECTATION_JSON_UNITS) || !exactObjectKeys(value, [
        "activePrograms", "logicalPrograms", "venue", "equipment", "equipmentLoads",
        "activeConstraints", "anchorAt", "program", "days", "items", "occurrences",
      ])) return false;
  const expected = value as Partial<FitnessProgramWeekScheduleExpectation>;
  if (!isFitnessProgramEnvironment(programEnvironmentOnly(
    expected as FitnessProgramEnvironmentExpectation,
  )) || !safeTimestamp(expected.anchorAt) || !isFitnessLiveProgram(expected.program) ||
      expected.program.status !== "active" || expected.program.venue_id !== expected.venue?.id ||
      !Array.isArray(expected.days) || !Array.isArray(expected.items) ||
      !Array.isArray(expected.occurrences) || !uniqueIds(expected.days) ||
      !uniqueIds(expected.items) || !uniqueIds(expected.occurrences) ||
      !expected.days.every((row) => isFitnessLiveProgramDay(row) &&
        row.program_id === expected.program?.id) ||
      !expected.items.every(isFitnessLiveProgramItem) ||
      !expected.occurrences.every(isFitnessLiveEvent) ||
      !isSortedProjection(expected.days, sortedProgramDays) ||
      !isSortedProjection(expected.items, sortedProgramItems) ||
      !isSortedProjection(expected.occurrences, sortedProgramEvents)) return false;
  const complete = expected as FitnessProgramWeekScheduleExpectation;
  if (complete.days.length + complete.items.length + complete.occurrences.length +
      complete.activePrograms.length + complete.logicalPrograms.length +
      complete.equipment.length + complete.equipmentLoads.length +
      complete.activeConstraints.length > LIVE_MAX_ATOMIC_ROWS) return false;
  const dayIds = new Set(complete.days.map(({ id }) => id));
  if (!complete.items.every(({ program_day_id }) => dayIds.has(program_day_id)) ||
      !complete.logicalPrograms.every((row) =>
        programMatchesLogicalKey(row, programLogicalKeyFromProgram(complete.program)))) return false;
  const slots = programScheduleSlots(complete.days, complete.anchorAt, scheduleTimeZone);
  if (slots.length === 0) return false;
  const slotKeys = new Set(slots.map(({ day, occurrenceKey }) =>
    `${day.id}\u0000${occurrenceKey}`));
  const occurrenceKeys = complete.occurrences.map(({ program_day_id, occurrence_key }) =>
    `${program_day_id ?? ""}\u0000${occurrence_key ?? ""}`);
  return new Set(occurrenceKeys).size === occurrenceKeys.length &&
    occurrenceKeys.every((key) => slotKeys.has(key));
}

function programEnvironmentFromSnapshot(
  snapshot: FitnessSnapshot,
  key: ProgramLogicalKey,
): FitnessProgramEnvironmentExpectation {
  const venue = snapshot.venues.find(({ id }) => id === key.venueId);
  if (!venue) throw programError("invalid_input", "计划场地不在这份画面里。");
  const equipment = sortedEquipment(snapshot.equipment.filter(
    ({ venue_id }) => venue_id === venue.id,
  ));
  const equipmentIds = new Set(equipment.map(({ id }) => id));
  return snapshotProgramInput({
    activePrograms: sortedPrograms(snapshot.programs.filter(({ status }) => status === "active")),
    logicalPrograms: sortedPrograms(snapshot.programs.filter((program) =>
      programMatchesLogicalKey(program, key))),
    venue,
    equipment,
    equipmentLoads: sortedEquipmentLoads(snapshot.equipmentLoads.filter(
      ({ equipment_id }) => equipmentIds.has(equipment_id),
    )),
    activeConstraints: sortedConstraints(snapshot.constraints.filter(({ active }) => active)),
  });
}

export function fitnessProgramVersionScheduleExpectationFromSnapshot(
  snapshot: FitnessSnapshot,
  draft: FitnessPlanDraft,
): FitnessProgramVersionScheduleExpectation {
  if (!isFitnessProgramDraftForReceipt(draft)) {
    throw programError("invalid_input", "计划草稿不是可准备的完整快照。");
  }
  return programEnvironmentFromSnapshot(snapshot, programLogicalKeyFromDraft(draft));
}

export function fitnessProgramWeekScheduleExpectationFromSnapshot(
  snapshot: FitnessSnapshot,
  programId: string,
  anchorAt: number,
): FitnessProgramWeekScheduleExpectation {
  const scheduleTimeZone = currentProgramTimeZone();
  const program = snapshot.programs.find(({ id }) => id === programId);
  if (!program || !safeTimestamp(anchorAt)) {
    throw programError("invalid_input", "计划或排期锚点不在这份画面里。");
  }
  const environment = programEnvironmentFromSnapshot(
    snapshot,
    programLogicalKeyFromProgram(program),
  );
  const days = sortedProgramDays(snapshot.programDays.filter(
    ({ program_id }) => program_id === program.id,
  ));
  const dayIds = new Set(days.map(({ id }) => id));
  const items = sortedProgramItems(snapshot.programItems.filter(
    ({ program_day_id }) => dayIds.has(program_day_id),
  ));
  const slotKeys = new Set(programScheduleSlots(days, anchorAt, scheduleTimeZone).map(
    ({ day, occurrenceKey }) => `${day.id}\u0000${occurrenceKey}`,
  ));
  const occurrences = sortedProgramEvents(snapshot.events.filter(
    ({ program_day_id, occurrence_key }) => slotKeys.has(
      `${program_day_id ?? ""}\u0000${occurrence_key ?? ""}`,
    ),
  ));
  return snapshotProgramInput({
    ...environment,
    anchorAt,
    program,
    days,
    items,
    occurrences,
  });
}

async function readProgramEnvironment(
  runtime: FitnessLiveStorageRuntime,
  key: ProgramLogicalKey,
): Promise<FitnessProgramEnvironmentExpectation | null> {
  const [venueRows, activeRows, logicalRows, equipmentRows, loadRows, constraintRows] =
    await Promise.all([
      liveRows<Row>(runtime, "SELECT * FROM fitness_venues WHERE id=? LIMIT 1", [key.venueId]),
      liveRows<Row>(runtime,
        "SELECT * FROM fitness_programs WHERE status='active' ORDER BY version,id LIMIT ?",
        [LIVE_MAX_ATOMIC_ROWS + 1]),
      liveRows<Row>(runtime, `SELECT * FROM fitness_programs
        WHERE venue_id=? AND name=? AND goal=? AND split=? ORDER BY version,id LIMIT ?`, [
        key.venueId,
        key.name,
        key.goal,
        key.split,
        LIVE_MAX_ATOMIC_ROWS + 1,
      ]),
      liveRows<Row>(runtime,
        "SELECT * FROM fitness_equipment WHERE venue_id=? ORDER BY id LIMIT ?", [
        key.venueId,
        LIVE_MAX_ATOMIC_ROWS + 1,
      ]),
      liveRows<Row>(runtime, `SELECT equipment_load.*
        FROM fitness_equipment_loads equipment_load
        JOIN fitness_equipment equipment ON equipment.id=equipment_load.equipment_id
        WHERE equipment.venue_id=?
        ORDER BY equipment_load.equipment_id,equipment_load.load_grams,equipment_load.id
        LIMIT ?`, [key.venueId, LIVE_MAX_ATOMIC_ROWS + 1]),
      liveRows<Row>(runtime,
        "SELECT * FROM fitness_constraints WHERE active=1 ORDER BY id LIMIT ?",
        [LIVE_MAX_ATOMIC_ROWS + 1]),
    ]);
  const venue = venueRows[0] ? mapVenue(venueRows[0]) : null;
  if (!venue) return null;
  return {
    activePrograms: sortedPrograms(activeRows.map(mapProgram)),
    logicalPrograms: sortedPrograms(logicalRows.map(mapProgram)),
    venue,
    equipment: sortedEquipment(equipmentRows.map(mapEquipment)),
    equipmentLoads: sortedEquipmentLoads(loadRows.map(mapEquipmentLoad)),
    activeConstraints: sortedConstraints(constraintRows.map(mapConstraint)),
  };
}

async function readProgramWeekExpectation(
  runtime: FitnessLiveStorageRuntime,
  programId: string,
  anchorAt: number,
  scheduleTimeZone: string,
): Promise<FitnessProgramWeekScheduleExpectation | null> {
  const programRows = await liveRows<Row>(
    runtime,
    "SELECT * FROM fitness_programs WHERE id=? LIMIT 1",
    [programId],
  );
  const program = programRows[0] ? mapProgram(programRows[0]) : null;
  if (!program) return null;
  const key = programLogicalKeyFromProgram(program);
  const [environment, dayRows, itemRows] = await Promise.all([
    readProgramEnvironment(runtime, key),
    liveRows<FitnessProgramDay>(runtime,
      "SELECT * FROM fitness_program_days WHERE program_id=? ORDER BY day_index,id LIMIT ?", [
      program.id,
      LIVE_MAX_ATOMIC_ROWS + 1,
    ]),
    liveRows<Row>(runtime, `SELECT item.* FROM fitness_program_items item
      JOIN fitness_program_days day ON day.id=item.program_day_id
      WHERE day.program_id=? ORDER BY day.day_index,item.order_index,item.id LIMIT ?`, [
      program.id,
      LIVE_MAX_ATOMIC_ROWS + 1,
    ]),
  ]);
  if (!environment) return null;
  const days = sortedProgramDays(dayRows);
  const slots = programScheduleSlots(days, anchorAt, scheduleTimeZone);
  const occurrenceRows = await Promise.all(slots.map(({ day, occurrenceKey }) =>
    liveRows<FitnessCalendarEvent>(runtime, `SELECT * FROM fitness_calendar_events
      WHERE program_day_id=? AND occurrence_key=? ORDER BY id LIMIT 2`, [
      day.id,
      occurrenceKey,
    ])));
  return {
    ...environment,
    anchorAt,
    program,
    days,
    items: sortedProgramItems(itemRows.map(mapProgramItem)),
    occurrences: sortedProgramEvents(occurrenceRows.flatMap((rows) => [...rows])),
  };
}

function programEnvironmentVersions(
  environment: FitnessProgramEnvironmentExpectation,
): number[] {
  return [
    environment.venue.created_at,
    environment.venue.updated_at,
    ...environment.activePrograms.flatMap(({ created_at, updated_at }) =>
      [created_at, updated_at]),
    ...environment.logicalPrograms.flatMap(({ created_at, updated_at }) =>
      [created_at, updated_at]),
    ...environment.equipment.flatMap(({ created_at, updated_at }) =>
      [created_at, updated_at]),
    ...environment.equipmentLoads.map(({ created_at }) => created_at),
    ...environment.activeConstraints.flatMap(({ created_at, updated_at }) =>
      [created_at, updated_at]),
  ];
}

function programWeekVersions(expected: FitnessProgramWeekScheduleExpectation): number[] {
  return [
    ...programEnvironmentVersions(expected),
    expected.program.created_at,
    expected.program.updated_at,
    ...expected.days.map(({ created_at }) => created_at),
    ...expected.items.map(({ created_at }) => created_at),
    ...expected.occurrences.flatMap(({ created_at, updated_at }) =>
      [created_at, updated_at]),
  ];
}

function generatedProgramId(
  runtime: FitnessLiveStorageRuntime,
  prefix: "program-" | "program-day-" | "program-item-" | "event-" |
    "fitness-program-operation-",
): string {
  const uuid = runtime.randomUUID();
  if (!LIVE_UUID_PATTERN.test(uuid)) {
    throw programError("invalid_input", "无法生成可靠的计划写入标识。");
  }
  return `${prefix}${uuid}`;
}

function generatedCalendarOperationId(runtime: FitnessLiveStorageRuntime): string {
  const uuid = runtime.randomUUID();
  if (!LIVE_UUID_PATTERN.test(uuid)) {
    throw calendarError("invalid_input", "无法生成可靠的日历写入标识。");
  }
  return `fitness-calendar-operation-${uuid}`;
}

function canonicalProgramDraft(draft: FitnessPlanDraft): FitnessPlanDraft {
  return { ...draft, name: draft.name.trim() };
}

function validateProgramDraftAgainstEnvironment(
  draft: FitnessPlanDraft,
  environment: FitnessProgramEnvironmentExpectation,
): readonly (readonly string[])[] {
  try {
    return assertDraftReferences(
      draft,
      environment.venue,
      environment.equipment,
      environment.equipmentLoads,
      environment.activeConstraints,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "计划草稿引用无效";
    throw programError("invalid_input", message);
  }
}

function draftFromProgramWeek(
  expected: FitnessProgramWeekScheduleExpectation,
): FitnessPlanDraft {
  const itemsByDay = new Map<string, FitnessProgramItem[]>();
  for (const item of expected.items) {
    const items = itemsByDay.get(item.program_day_id) ?? [];
    items.push(item);
    itemsByDay.set(item.program_day_id, items);
  }
  return {
    name: expected.program.name,
    venue_id: expected.program.venue_id,
    goal: expected.program.goal,
    split: expected.program.split,
    assumptions: expected.program.assumptions,
    warnings: [],
    days: expected.days.map((day) => ({
      weekday: day.weekday,
      kind: day.kind,
      name: day.name,
      focus: day.focus,
      estimated_minutes: day.estimated_minutes,
      items: sortedProgramItems(itemsByDay.get(day.id) ?? []).map((item) => ({
        exercise_id: item.exercise_id,
        equipment_id: item.equipment_id,
        resource_equipment_ids: item.resource_equipment_ids,
        order_index: item.order_index,
        sets: item.sets,
        rep_min: item.rep_min,
        rep_max: item.rep_max,
        duration_seconds: item.duration_seconds,
        target_rir: item.target_rir,
        rest_seconds: item.rest_seconds,
        load_grams: item.load_grams,
        load_guidance: item.load_guidance,
        rationale: item.rationale,
        substitution_exercise_ids: item.substitution_exercise_ids,
        equipment_snapshot: item.equipment_snapshot,
      })),
    })),
  };
}

function isCanonicalProgramSource(value: unknown): value is FitnessProgram["source"] {
  return value === "local" || value === "ai_draft" || value === "manual";
}

function versionScheduleTransition(
  receipt: FitnessProgramVersionScheduleReceipt,
): boolean {
  const { request, before, after, preparedAt } = receipt;
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      !exactObjectKeys(request, ["draft", "source", "anchorAt", "scheduleTimeZone"]) ||
      !isFitnessProgramDraftForReceipt(request.draft) ||
      request.draft.name !== request.draft.name.trim() ||
      !isCanonicalProgramSource(request.source) || !safeTimestamp(request.anchorAt) ||
      !isCanonicalProgramTimeZone(request.scheduleTimeZone) ||
      !isFitnessProgramVersionScheduleExpectation(before) ||
      !after || typeof after !== "object" || Array.isArray(after) ||
      !exactObjectKeys(after, ["archivedPrograms", "program", "days", "items", "events"]) ||
      !Array.isArray(after.archivedPrograms) || !Array.isArray(after.days) ||
      !Array.isArray(after.items) || !Array.isArray(after.events) ||
      !after.archivedPrograms.every(isFitnessLiveProgram) ||
      !isFitnessLiveProgram(after.program) || !after.days.every(isFitnessLiveProgramDay) ||
      !after.items.every(isFitnessLiveProgramItem) || !after.events.every(isFitnessLiveEvent) ||
      !uniqueIds(after.archivedPrograms) || !uniqueIds(after.days) || !uniqueIds(after.items) ||
      !uniqueIds(after.events) || !isSortedProjection(after.archivedPrograms, sortedPrograms) ||
      !isSortedProjection(after.days, sortedProgramDays) ||
      !isSortedProjection(after.items, sortedProgramItems) ||
      !isSortedProjection(after.events, sortedProgramEvents) ||
      !strictlyAfterEvery(preparedAt, programEnvironmentVersions(before))) return false;
  const key = programLogicalKeyFromDraft(request.draft);
  if (before.venue.id !== key.venueId || before.venue.status !== "active" ||
      !before.logicalPrograms.every((program) => programMatchesLogicalKey(program, key)) ||
      !sameProjection(after.archivedPrograms, sortedPrograms(before.activePrograms.map(
        (program) => ({ ...program, status: "archived" as const, updated_at: preparedAt }),
      )))) return false;
  let snapshots: readonly (readonly string[])[];
  try {
    snapshots = validateProgramDraftAgainstEnvironment(request.draft, before);
  } catch {
    return false;
  }
  const expectedVersion = before.logicalPrograms.reduce(
    (maximum, program) => Math.max(maximum, program.version + 1),
    1,
  );
  if (!PROGRAM_ID_PATTERN.test(after.program.id) || !sameProjection(after.program, {
    id: after.program.id,
    name: key.name,
    venue_id: key.venueId,
    goal: key.goal,
    split: key.split,
    status: "active",
    version: expectedVersion,
    source: request.source,
    assumptions: request.draft.assumptions,
    created_at: preparedAt,
    updated_at: preparedAt,
  }) || after.days.length !== request.draft.days.length) return false;
  const expectedItems: FitnessProgramItem[] = [];
  for (const [dayIndex, draftDay] of request.draft.days.entries()) {
    const day = after.days[dayIndex];
    if (!day || !PROGRAM_DAY_ID_PATTERN.test(day.id) || !sameProjection(day, {
      id: day.id,
      program_id: after.program.id,
      day_index: dayIndex,
      weekday: draftDay.weekday,
      kind: draftDay.kind,
      name: draftDay.name,
      focus: draftDay.focus,
      estimated_minutes: draftDay.estimated_minutes,
      variant: "standard",
      created_at: preparedAt,
    })) return false;
    for (const [itemIndex, draftItem] of draftDay.items.entries()) {
      const item = after.items.find((candidate) =>
        candidate.program_day_id === day.id && candidate.order_index === itemIndex);
      if (!item || !PROGRAM_ITEM_ID_PATTERN.test(item.id) || !sameProjection(item, {
        ...draftItem,
        id: item.id,
        program_day_id: day.id,
        equipment_snapshot: snapshots[dayIndex]?.[itemIndex] ?? "[]",
        created_at: preparedAt,
      })) return false;
      expectedItems.push(item);
    }
  }
  if (expectedItems.length !== after.items.length) return false;
  const slots = programScheduleSlots(after.days, request.anchorAt, request.scheduleTimeZone);
  if (slots.length === 0 || slots.length !== after.events.length) return false;
  return slots.every(({ day, startsAt, occurrenceKey }) => {
    const event = after.events.find(({ program_day_id }) => program_day_id === day.id);
    return Boolean(event) && PROGRAM_EVENT_ID_PATTERN.test(event!.id) && sameProjection(event, {
      id: event!.id,
      program_day_id: day.id,
      venue_id: after.program.venue_id,
      title: day.name,
      kind: day.kind,
      starts_at: startsAt,
      occurrence_key: occurrenceKey,
      planned_minutes: day.estimated_minutes,
      status: "planned",
      rescheduled_from_id: null,
      note: "",
      created_at: preparedAt,
      updated_at: preparedAt,
    });
  });
}

function weekScheduleTransition(
  receipt: FitnessProgramWeekScheduleReceipt,
): boolean {
  const { request, before, after, preparedAt } = receipt;
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      !exactObjectKeys(request, ["programId", "anchorAt", "scheduleTimeZone"]) ||
      !safeOpaqueId(request.programId) || !safeTimestamp(request.anchorAt) ||
      !isCanonicalProgramTimeZone(request.scheduleTimeZone) ||
      !isFitnessProgramWeekScheduleExpectation(before, request.scheduleTimeZone) ||
      request.programId !== before.program.id || request.anchorAt !== before.anchorAt ||
      !after || typeof after !== "object" || Array.isArray(after) ||
      !exactObjectKeys(after, ["events", "createdEventIds"]) ||
      !Array.isArray(after.events) || !Array.isArray(after.createdEventIds) ||
      !after.events.every(isFitnessLiveEvent) || !uniqueIds(after.events) ||
      !safeStringArray(after.createdEventIds, LIVE_MAX_ATOMIC_ROWS) ||
      !uniqueExactStrings(after.createdEventIds) ||
      !after.createdEventIds.every((id) => PROGRAM_EVENT_ID_PATTERN.test(id)) ||
      !isSortedProjection(after.events, sortedProgramEvents) ||
      !strictlyAfterEvery(preparedAt, programWeekVersions(before))) return false;
  const key = programLogicalKeyFromProgram(before.program);
  if (before.venue.id !== before.program.venue_id || before.venue.status !== "active" ||
      !before.logicalPrograms.every((program) => programMatchesLogicalKey(program, key)) ||
      !before.activePrograms.some(({ id }) => id === before.program.id) ||
      !before.logicalPrograms.some(({ id }) => id === before.program.id)) return false;
  try {
    validateProgramDraftAgainstEnvironment(draftFromProgramWeek(before), before);
  } catch {
    return false;
  }
  const slots = programScheduleSlots(before.days, request.anchorAt, request.scheduleTimeZone);
  if (slots.length === 0 || slots.length !== after.events.length) return false;
  const occurrenceByKey = new Map(before.occurrences.map((event) => [
    `${event.program_day_id ?? ""}\u0000${event.occurrence_key ?? ""}`,
    event,
  ]));
  const createdIds: string[] = [];
  for (const { day, startsAt, occurrenceKey } of slots) {
    const keyValue = `${day.id}\u0000${occurrenceKey}`;
    const target = after.events.find((event) =>
      event.program_day_id === day.id && event.occurrence_key === occurrenceKey);
    if (!target) return false;
    const existing = occurrenceByKey.get(keyValue);
    if (existing) {
      if (!sameProjection(target, existing)) return false;
      continue;
    }
    if (!PROGRAM_EVENT_ID_PATTERN.test(target.id) || !sameProjection(target, {
      id: target.id,
      program_day_id: day.id,
      venue_id: before.program.venue_id,
      title: day.name,
      kind: day.kind,
      starts_at: startsAt,
      occurrence_key: occurrenceKey,
      planned_minutes: day.estimated_minutes,
      status: "planned",
      rescheduled_from_id: null,
      note: "",
      created_at: preparedAt,
      updated_at: preparedAt,
    })) return false;
    createdIds.push(target.id);
  }
  return sameProjection(
    [...after.createdEventIds].sort(compareLiveId),
    createdIds.sort(compareLiveId),
  );
}

function hasValidProgramReceiptBase(
  value: object,
  kind: FitnessProgramWriteReceipt["kind"],
  keys: readonly string[],
): boolean {
  const receipt = value as Partial<FitnessProgramWriteReceipt>;
  return exactObjectKeys(value, [
    "purpose", "version", "operationId", "generationId", "generationSequence",
    "preparedAt", "kind", "projectionSha256", ...keys,
  ]) && receipt.purpose === "fitness-program-write" && receipt.version === 1 &&
    receipt.kind === kind && typeof receipt.operationId === "string" &&
    PROGRAM_OPERATION_ID_PATTERN.test(receipt.operationId) &&
    typeof receipt.generationId === "string" &&
    CONFIG_GENERATION_ID_PATTERN.test(receipt.generationId) &&
    liveInteger(receipt.generationSequence, 0, Number.MAX_SAFE_INTEGER) &&
    safeTimestamp(receipt.preparedAt) && typeof receipt.projectionSha256 === "string" &&
    CONFIG_HASH_PATTERN.test(receipt.projectionSha256);
}

function isFitnessProgramWriteReceiptUnchecked(
  value: unknown,
): value is FitnessProgramWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !jsonWithinUnits(value, LIVE_MAX_RECEIPT_JSON_UNITS)) return false;
  const receipt = value as Partial<FitnessProgramWriteReceipt>;
  if (receipt.kind === "program-version-schedule") {
    return hasValidProgramReceiptBase(value, receipt.kind, ["request", "before", "after"]) &&
      versionScheduleTransition(receipt as FitnessProgramVersionScheduleReceipt);
  }
  if (receipt.kind === "program-week-schedule") {
    return hasValidProgramReceiptBase(value, receipt.kind, ["request", "before", "after"]) &&
      weekScheduleTransition(receipt as FitnessProgramWeekScheduleReceipt);
  }
  return false;
}

export function isFitnessProgramWriteReceipt(
  value: unknown,
): value is FitnessProgramWriteReceipt {
  try {
    return isFitnessProgramWriteReceiptUnchecked(value);
  } catch {
    return false;
  }
}

async function sealProgramReceipt<Receipt extends FitnessProgramWriteReceipt>(
  draft: Omit<Receipt, "projectionSha256">,
): Promise<Receipt> {
  const projectionSha256 = await sha256Hex(canonicalJson(draft));
  return { ...draft, projectionSha256 } as Receipt;
}

async function programReceiptHashIsValid(
  receipt: FitnessProgramWriteReceipt,
): Promise<boolean> {
  const { projectionSha256, ...projection } = receipt;
  return projectionSha256 === await sha256Hex(canonicalJson(projection));
}

function snapshotProgramInput<Input>(value: Input): Input {
  try {
    return JSON.parse(JSON.stringify(value)) as Input;
  } catch {
    throw programError("invalid_input", "计划写入内容不能安全复制。");
  }
}

export function createFitnessProgramStorageService(
  runtime: FitnessLiveStorageRuntime = {
    withExclusiveLock: (operation) => withFitnessWriteLock(operation, { requireSupport: true }),
    query: async <Result extends object>(sql: string, params?: SqlParams) => ({
      rows: await rawQuery<Result>(sql, params),
    }),
    batch: (statements) => rawBatch(statements),
    currentGeneration: () => localDb.currentGeneration(DB),
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    broadcast: broadcastFitnessChange,
  },
) {
  async function prepareLocked<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await runtime.withExclusiveLock(operation);
    } catch (error) {
      if (error instanceof FitnessProgramMutationError) throw error;
      if (error instanceof TypeError) throw programError("invalid_input", error.message);
      throw programError("inspect_failed", "暂时无法核对计划；没有开始写入。");
    }
  }

  async function prepareVersionSchedule(
    input: PrepareFitnessProgramVersionScheduleInput,
    expected: FitnessProgramVersionScheduleExpectation,
  ): Promise<FitnessProgramVersionScheduleReceipt> {
    const stableInput = snapshotProgramInput(input);
    const stableExpected = snapshotProgramInput(expected);
    const stableSource = stableInput && typeof stableInput === "object" &&
        !Array.isArray(stableInput) && stableInput.source !== undefined
      ? stableInput.source
      : "local";
    const stableScheduleTimeZone = currentProgramTimeZone();
    return prepareLocked(async () => {
      if (!stableInput || typeof stableInput !== "object" || Array.isArray(stableInput) ||
          !Object.keys(stableInput).every((key) =>
            key === "draft" || key === "source" || key === "anchorAt") ||
          !isFitnessProgramDraftForReceipt(stableInput.draft) ||
          !isCanonicalProgramSource(stableSource) || !safeTimestamp(stableInput.anchorAt) ||
          !isFitnessProgramVersionScheduleExpectation(stableExpected)) {
        throw programError("invalid_input", "计划草稿、排期锚点或画面快照无效。");
      }
      const draft = canonicalProgramDraft(stableInput.draft);
      const key = programLogicalKeyFromDraft(draft);
      if (stableExpected.venue.id !== key.venueId ||
          !stableExpected.logicalPrograms.every((program) =>
            programMatchesLogicalKey(program, key))) {
        throw programError("invalid_input", "计划版本集合与草稿身份不一致。");
      }
      const current = await readProgramEnvironment(runtime, key);
      if (!current || !isFitnessProgramVersionScheduleExpectation(current) ||
          !sameProjection(current, stableExpected)) {
        throw programError("changed", "计划版本、场地、器材或身体边界已变化；没有准备保存。");
      }
      if (current.venue.status !== "active") {
        throw programError("changed", "计划场地已不可用；没有准备保存。");
      }
      const snapshots = validateProgramDraftAgainstEnvironment(draft, current);
      const schedulableDays = draft.days.filter(({ weekday, kind }) =>
        weekday !== null && kind !== "rest");
      if (schedulableDays.length === 0) {
        throw programError("invalid_input", "计划至少需要一个可放入日历的训练日。");
      }
      const generation = await readConfigGeneration(runtime);
      const preparedAt = nextLiveTimestamp(runtime.now(), programEnvironmentVersions(current));
      const programId = generatedProgramId(runtime, "program-");
      const operationId = generatedProgramId(runtime, "fitness-program-operation-");
      const version = current.logicalPrograms.reduce(
        (maximum, program) => Math.max(maximum, program.version + 1),
        1,
      );
      const program: FitnessProgram = {
        id: programId,
        name: draft.name,
        venue_id: draft.venue_id,
        goal: draft.goal,
        split: draft.split,
        status: "active",
        version,
        source: stableSource,
        assumptions: draft.assumptions,
        created_at: preparedAt,
        updated_at: preparedAt,
      };
      const days: FitnessProgramDay[] = [];
      const items: FitnessProgramItem[] = [];
      for (const [dayIndex, draftDay] of draft.days.entries()) {
        const dayId = generatedProgramId(runtime, "program-day-");
        const day: FitnessProgramDay = {
          id: dayId,
          program_id: programId,
          day_index: dayIndex,
          weekday: draftDay.weekday,
          kind: draftDay.kind,
          name: draftDay.name,
          focus: draftDay.focus,
          estimated_minutes: draftDay.estimated_minutes,
          variant: "standard",
          created_at: preparedAt,
        };
        days.push(day);
        for (const [itemIndex, draftItem] of draftDay.items.entries()) {
          items.push({
            ...draftItem,
            id: generatedProgramId(runtime, "program-item-"),
            program_day_id: dayId,
            equipment_snapshot: snapshots[dayIndex]?.[itemIndex] ?? "[]",
            created_at: preparedAt,
          });
        }
      }
      const events = sortedProgramEvents(programScheduleSlots(
        days,
        stableInput.anchorAt,
        stableScheduleTimeZone,
      ).map(
        ({ day, startsAt, occurrenceKey }) => ({
          id: generatedProgramId(runtime, "event-"),
          program_day_id: day.id,
          venue_id: program.venue_id,
          title: day.name,
          kind: day.kind,
          starts_at: startsAt,
          occurrence_key: occurrenceKey,
          planned_minutes: day.estimated_minutes,
          status: "planned" as const,
          rescheduled_from_id: null,
          note: "",
          created_at: preparedAt,
          updated_at: preparedAt,
        }),
      ));
      const receipt = await sealProgramReceipt<FitnessProgramVersionScheduleReceipt>({
        purpose: "fitness-program-write",
        version: 1,
        operationId,
        ...generation,
        preparedAt,
        kind: "program-version-schedule",
        request: {
          draft,
          source: stableSource,
          anchorAt: stableInput.anchorAt,
          scheduleTimeZone: stableScheduleTimeZone,
        },
        before: current,
        after: {
          archivedPrograms: sortedPrograms(current.activePrograms.map((row) => ({
            ...row,
            status: "archived" as const,
            updated_at: preparedAt,
          }))),
          program,
          days: sortedProgramDays(days),
          items: sortedProgramItems(items),
          events,
        },
      });
      if (!isFitnessProgramWriteReceipt(receipt)) {
        throw programError("invalid_input", "无法构造可靠的计划版本回执。");
      }
      return receipt;
    });
  }

  async function prepareWeekSchedule(
    input: PrepareFitnessProgramWeekScheduleInput,
    expected: FitnessProgramWeekScheduleExpectation,
  ): Promise<FitnessProgramWeekScheduleReceipt> {
    const stableInput = snapshotProgramInput(input);
    const stableExpected = snapshotProgramInput(expected);
    const stableScheduleTimeZone = currentProgramTimeZone();
    return prepareLocked(async () => {
      if (!stableInput || typeof stableInput !== "object" || Array.isArray(stableInput) ||
          !exactObjectKeys(stableInput, ["programId", "anchorAt"]) ||
          !safeOpaqueId(stableInput.programId) || !safeTimestamp(stableInput.anchorAt) ||
          !isFitnessProgramWeekScheduleExpectation(stableExpected, stableScheduleTimeZone) ||
          stableExpected.program.id !== stableInput.programId ||
          stableExpected.anchorAt !== stableInput.anchorAt) {
        throw programError("invalid_input", "计划、排期锚点或画面快照无效。");
      }
      const current = await readProgramWeekExpectation(
        runtime,
        stableInput.programId,
        stableInput.anchorAt,
        stableScheduleTimeZone,
      );
      if (!current || !isFitnessProgramWeekScheduleExpectation(current, stableScheduleTimeZone) ||
          !sameProjection(current, stableExpected)) {
        throw programError("changed", "计划、日历、器材或身体边界已变化；没有准备排期。");
      }
      if (current.program.status !== "active" || current.venue.status !== "active") {
        throw programError("changed", "只能安排当前启用且场地可用的计划。");
      }
      validateProgramDraftAgainstEnvironment(draftFromProgramWeek(current), current);
      const slots = programScheduleSlots(
        current.days,
        stableInput.anchorAt,
        stableScheduleTimeZone,
      );
      if (slots.length === 0) {
        throw programError("invalid_input", "这版计划没有可放入日历的训练日。");
      }
      const generation = await readConfigGeneration(runtime);
      const preparedAt = nextLiveTimestamp(runtime.now(), programWeekVersions(current));
      const operationId = generatedProgramId(runtime, "fitness-program-operation-");
      const occurrenceByKey = new Map(current.occurrences.map((event) => [
        `${event.program_day_id ?? ""}\u0000${event.occurrence_key ?? ""}`,
        event,
      ]));
      const events: FitnessCalendarEvent[] = [];
      const createdEventIds: string[] = [];
      for (const { day, startsAt, occurrenceKey } of slots) {
        const existing = occurrenceByKey.get(`${day.id}\u0000${occurrenceKey}`);
        if (existing) {
          events.push(existing);
          continue;
        }
        const eventId = generatedProgramId(runtime, "event-");
        createdEventIds.push(eventId);
        events.push({
          id: eventId,
          program_day_id: day.id,
          venue_id: current.program.venue_id,
          title: day.name,
          kind: day.kind,
          starts_at: startsAt,
          occurrence_key: occurrenceKey,
          planned_minutes: day.estimated_minutes,
          status: "planned",
          rescheduled_from_id: null,
          note: "",
          created_at: preparedAt,
          updated_at: preparedAt,
        });
      }
      const receipt = await sealProgramReceipt<FitnessProgramWeekScheduleReceipt>({
        purpose: "fitness-program-write",
        version: 1,
        operationId,
        ...generation,
        preparedAt,
        kind: "program-week-schedule",
        request: {
          ...stableInput,
          scheduleTimeZone: stableScheduleTimeZone,
        },
        before: current,
        after: {
          events: sortedProgramEvents(events),
          createdEventIds: [...createdEventIds].sort(compareLiveId),
        },
      });
      if (!isFitnessProgramWriteReceipt(receipt)) {
        throw programError("invalid_input", "无法构造可靠的计划排期回执。");
      }
      return receipt;
    });
  }

  function programTargetMatches(current: FitnessProgram, target: FitnessProgram): boolean {
    return isFitnessLiveProgram(current) && current.id === target.id &&
      current.name === target.name && current.venue_id === target.venue_id &&
      current.goal === target.goal && current.split === target.split &&
      current.version === target.version && current.source === target.source &&
      sameProjection(current.assumptions, target.assumptions) &&
      current.created_at === target.created_at && current.updated_at >= target.updated_at &&
      (current.status === "active" || current.status === "archived");
  }

  function scheduledEventTargetMatches(
    current: FitnessCalendarEvent,
    target: FitnessCalendarEvent,
  ): boolean {
    if (!isFitnessLiveEvent(current) || current.id !== target.id ||
        current.program_day_id !== target.program_day_id || current.venue_id !== target.venue_id ||
        current.title !== target.title || current.kind !== target.kind ||
        current.occurrence_key !== target.occurrence_key ||
        current.planned_minutes !== target.planned_minutes ||
        current.rescheduled_from_id !== target.rescheduled_from_id ||
        current.created_at !== target.created_at || current.updated_at < target.updated_at) {
      return false;
    }
    if (target.status === "completed" || target.status === "not_performed" ||
        target.status === "cancelled") {
      return current.starts_at === target.starts_at && current.status === target.status &&
        current.note === target.note;
    }
    const reachableStatus = current.status === "planned" || current.status === "in_progress" ||
      current.status === "completed" || current.status === "not_performed" ||
      current.status === "cancelled";
    const reachableNote = current.status === "not_performed"
      ? safeString(current.note, 4_000) && current.note === current.note.trim()
      : current.note === target.note;
    return reachableStatus && reachableNote;
  }

  async function readProgramTree(
    programId: string,
  ): Promise<Readonly<{
    program: FitnessProgram | null;
    days: readonly FitnessProgramDay[];
    items: readonly FitnessProgramItem[];
  }>> {
    const [programRows, dayRows, itemRows] = await Promise.all([
      liveRows<Row>(runtime, "SELECT * FROM fitness_programs WHERE id=? LIMIT 1", [programId]),
      liveRows<FitnessProgramDay>(runtime,
        "SELECT * FROM fitness_program_days WHERE program_id=? ORDER BY day_index,id LIMIT ?", [
        programId,
        LIVE_MAX_ATOMIC_ROWS + 1,
      ]),
      liveRows<Row>(runtime, `SELECT item.* FROM fitness_program_items item
        JOIN fitness_program_days day ON day.id=item.program_day_id
        WHERE day.program_id=? ORDER BY day.day_index,item.order_index,item.id LIMIT ?`, [
        programId,
        LIVE_MAX_ATOMIC_ROWS + 1,
      ]),
    ]);
    return {
      program: programRows[0] ? mapProgram(programRows[0]) : null,
      days: sortedProgramDays(dayRows),
      items: sortedProgramItems(itemRows.map(mapProgramItem)),
    };
  }

  async function targetEventsMatch(
    targets: readonly FitnessCalendarEvent[],
  ): Promise<boolean> {
    const rows = await Promise.all(targets.map(({ id }) => liveRows<FitnessCalendarEvent>(
      runtime,
      "SELECT * FROM fitness_calendar_events WHERE id=? LIMIT 1",
      [id],
    )));
    return rows.every((current, index) => current[0] &&
      scheduledEventTargetMatches(current[0], targets[index]!));
  }

  function programReceiptMarkerKey(receipt: FitnessProgramWriteReceipt): string {
    return `${PROGRAM_RECEIPT_MARKER_PREFIX}${receipt.operationId}`;
  }

  function programReceiptMarkerValue(receipt: FitnessProgramWriteReceipt): string {
    return canonicalJson({
      purpose: "fitness-program-receipt-marker",
      version: 1,
      kind: receipt.kind,
      generationId: receipt.generationId,
      generationSequence: receipt.generationSequence,
      projectionSha256: receipt.projectionSha256,
    });
  }

  async function markerState(
    receipt: FitnessProgramWriteReceipt,
  ): Promise<"absent" | "match" | "conflict"> {
    const rows = await liveRows<Readonly<{ value: string; updated_at: number }>>(
      runtime,
      "SELECT value,updated_at FROM fitness_settings WHERE key=? LIMIT 1",
      [programReceiptMarkerKey(receipt)],
    );
    const row = rows[0];
    if (!row) return "absent";
    return row.value === programReceiptMarkerValue(receipt) &&
        row.updated_at === receipt.preparedAt
      ? "match"
      : "conflict";
  }

  async function anyGeneratedTargetExists(
    receipt: FitnessProgramWriteReceipt,
  ): Promise<boolean> {
    const targets = receipt.kind === "program-version-schedule"
      ? [
        ["fitness_programs", receipt.after.program.id],
        ...receipt.after.days.map(({ id }) => ["fitness_program_days", id]),
        ...receipt.after.items.map(({ id }) => ["fitness_program_items", id]),
        ...receipt.after.events.map(({ id }) => ["fitness_calendar_events", id]),
      ]
      : receipt.after.createdEventIds.map((id) => ["fitness_calendar_events", id]);
    const rows = await Promise.all(targets.map(([table, id]) => liveRows<Readonly<{ present: 1 }>>(
      runtime,
      `SELECT 1 present FROM ${table} WHERE id=? LIMIT 1`,
      [id],
    )));
    return rows.some((result) => result.length > 0);
  }

  async function targetMatches(receipt: FitnessProgramWriteReceipt): Promise<boolean> {
    if (receipt.kind === "program-version-schedule") {
      const tree = await readProgramTree(receipt.after.program.id);
      return Boolean(tree.program) && programTargetMatches(tree.program!, receipt.after.program) &&
        sameProjection(tree.days, receipt.after.days) &&
        sameProjection(tree.items, receipt.after.items) &&
        await targetEventsMatch(receipt.after.events);
    }
    const tree = await readProgramTree(receipt.before.program.id);
    return Boolean(tree.program) && programTargetMatches(tree.program!, receipt.before.program) &&
      sameProjection(tree.days, receipt.before.days) &&
      sameProjection(tree.items, receipt.before.items) &&
      await targetEventsMatch(receipt.after.events);
  }

  async function receiptStateUnlocked(
    receipt: FitnessProgramWriteReceipt,
  ): Promise<Exclude<FitnessProgramWriteInspection, "still_unknown" | "invalid_receipt">> {
    const generation = await readConfigGeneration(runtime);
    if (generation.generationId !== receipt.generationId ||
        generation.generationSequence !== receipt.generationSequence) return "changed";
    const currentMarker = await markerState(receipt);
    if (currentMarker === "conflict") return "changed";
    if (currentMarker === "match") {
      return await targetMatches(receipt) ? "exact_saved" : "changed";
    }
    if (await anyGeneratedTargetExists(receipt)) return "changed";
    if (receipt.kind === "program-version-schedule") {
      const current = await readProgramEnvironment(
        runtime,
        programLogicalKeyFromDraft(receipt.request.draft),
      );
      return sameProjection(current, receipt.before) ? "expected" : "changed";
    }
    const current = await readProgramWeekExpectation(
      runtime,
      receipt.request.programId,
      receipt.request.anchorAt,
      receipt.request.scheduleTimeZone,
    );
    return sameProjection(current, receipt.before) ? "expected" : "changed";
  }

  type ProgramPredicate = Readonly<{ sql: string; params: readonly unknown[] }>;

  function joinedProgramPredicate(
    predicates: readonly ProgramPredicate[],
  ): ProgramPredicate {
    return {
      sql: predicates.length === 0
        ? "1"
        : predicates.map(({ sql }) => `(${sql})`).join(" AND "),
      params: predicates.flatMap(({ params }) => [...params]),
    };
  }

  function programRowPredicate(row: FitnessProgram): ProgramPredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_programs WHERE id=? AND name IS ?
        AND venue_id IS ? AND goal IS ? AND split IS ? AND status IS ? AND version IS ?
        AND source IS ? AND json(assumptions_json)=json(?) AND created_at IS ?
        AND updated_at IS ?)`,
      params: [
        row.id,
        row.name,
        row.venue_id,
        row.goal,
        row.split,
        row.status,
        row.version,
        row.source,
        JSON.stringify(row.assumptions),
        row.created_at,
        row.updated_at,
      ],
    };
  }

  function programDayRowPredicate(row: FitnessProgramDay): ProgramPredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_program_days WHERE id=? AND program_id IS ?
        AND day_index IS ? AND weekday IS ? AND kind IS ? AND name IS ? AND focus IS ?
        AND estimated_minutes IS ? AND variant IS ? AND created_at IS ?)`,
      params: [
        row.id,
        row.program_id,
        row.day_index,
        row.weekday,
        row.kind,
        row.name,
        row.focus,
        row.estimated_minutes,
        row.variant,
        row.created_at,
      ],
    };
  }

  function programItemRowPredicate(row: FitnessProgramItem): ProgramPredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_program_items WHERE id=?
        AND program_day_id IS ? AND exercise_id IS ? AND equipment_id IS ?
        AND json(resource_equipment_ids_json)=json(?) AND order_index IS ? AND sets IS ?
        AND rep_min IS ? AND rep_max IS ? AND duration_seconds IS ? AND target_rir IS ?
        AND rest_seconds IS ? AND load_grams IS ? AND load_guidance IS ?
        AND rationale IS ? AND json(substitution_exercise_ids_json)=json(?)
        AND equipment_snapshot IS ? AND created_at IS ?)`,
      params: [
        row.id,
        row.program_day_id,
        row.exercise_id,
        row.equipment_id,
        JSON.stringify(row.resource_equipment_ids),
        row.order_index,
        row.sets,
        row.rep_min,
        row.rep_max,
        row.duration_seconds,
        row.target_rir,
        row.rest_seconds,
        row.load_grams,
        row.load_guidance,
        row.rationale,
        JSON.stringify(row.substitution_exercise_ids),
        row.equipment_snapshot,
        row.created_at,
      ],
    };
  }

  function programEventRowPredicate(row: FitnessCalendarEvent): ProgramPredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_calendar_events WHERE id=?
        AND program_day_id IS ? AND venue_id IS ? AND title IS ? AND kind IS ?
        AND starts_at IS ? AND occurrence_key IS ? AND planned_minutes IS ?
        AND status IS ? AND rescheduled_from_id IS ? AND note IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id,
        row.program_day_id,
        row.venue_id,
        row.title,
        row.kind,
        row.starts_at,
        row.occurrence_key,
        row.planned_minutes,
        row.status,
        row.rescheduled_from_id,
        row.note,
        row.created_at,
        row.updated_at,
      ],
    };
  }

  function programVenuePredicate(row: FitnessVenue): ProgramPredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_venues WHERE id=? AND name IS ?
        AND venue_type IS ? AND location IS ? AND area_notes IS ? AND busy_notes IS ?
        AND default_session_minutes IS ? AND supersets_allowed IS ? AND is_default IS ?
        AND status IS ? AND last_verified_at IS ? AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id,
        row.name,
        row.venue_type,
        row.location,
        row.area_notes,
        row.busy_notes,
        row.default_session_minutes,
        Number(row.supersets_allowed),
        Number(row.is_default),
        row.status,
        row.last_verified_at,
        row.created_at,
        row.updated_at,
      ],
    };
  }

  function programEquipmentPredicate(row: FitnessEquipment): ProgramPredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_equipment WHERE id=? AND venue_id IS ?
        AND name IS ? AND kind IS ? AND area IS ? AND quantity IS ? AND status IS ?
        AND load_mode IS ? AND load_semantics IS ? AND min_load_grams IS ?
        AND max_load_grams IS ? AND increment_grams IS ? AND bar_weight_grams IS ?
        AND unilateral IS ? AND busy_level IS ? AND json(settings_json)=json(?)
        AND json(attachments_json)=json(?) AND notes IS ? AND created_at IS ?
        AND updated_at IS ?)`,
      params: [
        row.id,
        row.venue_id,
        row.name,
        row.kind,
        row.area,
        row.quantity,
        row.status,
        row.load_mode,
        row.load_semantics,
        row.min_load_grams,
        row.max_load_grams,
        row.increment_grams,
        row.bar_weight_grams,
        Number(row.unilateral),
        row.busy_level,
        JSON.stringify(row.settings),
        JSON.stringify(row.attachments),
        row.notes,
        row.created_at,
        row.updated_at,
      ],
    };
  }

  function programLoadPredicate(row: FitnessEquipmentLoad): ProgramPredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_equipment_loads WHERE id=?
        AND equipment_id IS ? AND load_grams IS ? AND quantity IS ? AND label IS ?
        AND available IS ? AND created_at IS ?)`,
      params: [
        row.id,
        row.equipment_id,
        row.load_grams,
        row.quantity,
        row.label,
        Number(row.available),
        row.created_at,
      ],
    };
  }

  function programConstraintPredicate(row: FitnessConstraint): ProgramPredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_constraints WHERE id=? AND label IS ?
        AND body_area IS ? AND severity IS ? AND json(movement_patterns_json)=json(?)
        AND json(exercise_ids_json)=json(?) AND note IS ? AND active IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id,
        row.label,
        row.body_area,
        row.severity,
        JSON.stringify(row.movement_patterns),
        JSON.stringify(row.exercise_ids),
        row.note,
        Number(row.active),
        row.created_at,
        row.updated_at,
      ],
    };
  }

  function programEnvironmentPredicate(
    environment: FitnessProgramEnvironmentExpectation,
    key: ProgramLogicalKey,
  ): ProgramPredicate {
    return joinedProgramPredicate([
      programVenuePredicate(environment.venue),
      {
        sql: "(SELECT COUNT(*) FROM fitness_programs WHERE status='active')=?",
        params: [environment.activePrograms.length],
      },
      ...environment.activePrograms.map(programRowPredicate),
      {
        sql: `(SELECT COUNT(*) FROM fitness_programs
          WHERE venue_id=? AND name=? AND goal=? AND split=?)=?`,
        params: [key.venueId, key.name, key.goal, key.split, environment.logicalPrograms.length],
      },
      ...environment.logicalPrograms.map(programRowPredicate),
      {
        sql: "(SELECT COUNT(*) FROM fitness_equipment WHERE venue_id=?)=?",
        params: [environment.venue.id, environment.equipment.length],
      },
      ...environment.equipment.map(programEquipmentPredicate),
      {
        sql: `(SELECT COUNT(*) FROM fitness_equipment_loads equipment_load
          JOIN fitness_equipment equipment ON equipment.id=equipment_load.equipment_id
          WHERE equipment.venue_id=?)=?`,
        params: [environment.venue.id, environment.equipmentLoads.length],
      },
      ...environment.equipmentLoads.map(programLoadPredicate),
      {
        sql: "(SELECT COUNT(*) FROM fitness_constraints WHERE active=1)=?",
        params: [environment.activeConstraints.length],
      },
      ...environment.activeConstraints.map(programConstraintPredicate),
    ]);
  }

  function programTreePredicate(
    program: FitnessProgram,
    days: readonly FitnessProgramDay[],
    items: readonly FitnessProgramItem[],
  ): ProgramPredicate {
    return joinedProgramPredicate([
      programRowPredicate(program),
      {
        sql: "(SELECT COUNT(*) FROM fitness_program_days WHERE program_id=?)=?",
        params: [program.id, days.length],
      },
      ...days.map(programDayRowPredicate),
      {
        sql: `(SELECT COUNT(*) FROM fitness_program_items item
          JOIN fitness_program_days day ON day.id=item.program_day_id
          WHERE day.program_id=?)=?`,
        params: [program.id, items.length],
      },
      ...items.map(programItemRowPredicate),
    ]);
  }

  function weekExpectationPredicate(
    expected: FitnessProgramWeekScheduleExpectation,
    scheduleTimeZone: string,
  ): ProgramPredicate {
    const occurrenceByKey = new Map(expected.occurrences.map((event) => [
      `${event.program_day_id ?? ""}\u0000${event.occurrence_key ?? ""}`,
      event,
    ]));
    const occurrencePredicates = programScheduleSlots(
      expected.days,
      expected.anchorAt,
      scheduleTimeZone,
    ).flatMap(({ day, occurrenceKey }) => {
        const event = occurrenceByKey.get(`${day.id}\u0000${occurrenceKey}`);
        return [
          {
            sql: `(SELECT COUNT(*) FROM fitness_calendar_events
              WHERE program_day_id=? AND occurrence_key=?)=?`,
            params: [day.id, occurrenceKey, event ? 1 : 0],
          },
          ...(event ? [programEventRowPredicate(event)] : []),
        ];
    });
    return joinedProgramPredicate([
      programEnvironmentPredicate(expected, programLogicalKeyFromProgram(expected.program)),
      programTreePredicate(expected.program, expected.days, expected.items),
      ...occurrencePredicates,
    ]);
  }

  function programAbsentPredicate(table: string, id: string): ProgramPredicate {
    return { sql: `NOT EXISTS(SELECT 1 FROM ${table} WHERE id=?)`, params: [id] };
  }

  function programMarkerAbsentPredicate(
    receipt: FitnessProgramWriteReceipt,
  ): ProgramPredicate {
    return {
      sql: "NOT EXISTS(SELECT 1 FROM fitness_settings WHERE key=?)",
      params: [programReceiptMarkerKey(receipt)],
    };
  }

  function programCasSentinel(predicate: ProgramPredicate): SqlStatement {
    return {
      sql: `INSERT INTO fitness_settings(key,value,updated_at)
        SELECT '__fitness_program_cas_abort__',NULL,0 WHERE NOT (${predicate.sql})`,
      params: predicate.params,
    };
  }

  function insertProgram(row: FitnessProgram): SqlStatement {
    return {
      sql: `INSERT INTO fitness_programs(
        id,name,venue_id,goal,split,status,version,source,assumptions_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        row.id,
        row.name,
        row.venue_id,
        row.goal,
        row.split,
        row.status,
        row.version,
        row.source,
        JSON.stringify(row.assumptions),
        row.created_at,
        row.updated_at,
      ],
    };
  }

  function insertProgramDay(row: FitnessProgramDay): SqlStatement {
    return {
      sql: `INSERT INTO fitness_program_days(
        id,program_id,day_index,weekday,kind,name,focus,estimated_minutes,variant,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      params: [
        row.id,
        row.program_id,
        row.day_index,
        row.weekday,
        row.kind,
        row.name,
        row.focus,
        row.estimated_minutes,
        row.variant,
        row.created_at,
      ],
    };
  }

  function insertProgramItem(row: FitnessProgramItem): SqlStatement {
    return {
      sql: `INSERT INTO fitness_program_items(
        id,program_day_id,exercise_id,equipment_id,resource_equipment_ids_json,
        order_index,sets,rep_min,rep_max,duration_seconds,target_rir,rest_seconds,
        load_grams,load_guidance,rationale,substitution_exercise_ids_json,
        equipment_snapshot,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        row.id,
        row.program_day_id,
        row.exercise_id,
        row.equipment_id,
        JSON.stringify(row.resource_equipment_ids),
        row.order_index,
        row.sets,
        row.rep_min,
        row.rep_max,
        row.duration_seconds,
        row.target_rir,
        row.rest_seconds,
        row.load_grams,
        row.load_guidance,
        row.rationale,
        JSON.stringify(row.substitution_exercise_ids),
        row.equipment_snapshot,
        row.created_at,
      ],
    };
  }

  function insertProgramEvent(row: FitnessCalendarEvent): SqlStatement {
    return {
      sql: `INSERT INTO fitness_calendar_events(
        id,program_day_id,venue_id,title,kind,starts_at,occurrence_key,planned_minutes,
        status,rescheduled_from_id,note,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        row.id,
        row.program_day_id,
        row.venue_id,
        row.title,
        row.kind,
        row.starts_at,
        row.occurrence_key,
        row.planned_minutes,
        row.status,
        row.rescheduled_from_id,
        row.note,
        row.created_at,
        row.updated_at,
      ],
    };
  }

  function insertProgramMarker(receipt: FitnessProgramWriteReceipt): SqlStatement {
    return {
      sql: "INSERT INTO fitness_settings(key,value,updated_at) VALUES(?,?,?)",
      params: [
        programReceiptMarkerKey(receipt),
        programReceiptMarkerValue(receipt),
        receipt.preparedAt,
      ],
    };
  }

  function receiptStatements(receipt: FitnessProgramWriteReceipt): SqlStatement[] {
    if (receipt.kind === "program-version-schedule") {
      const predicate = joinedProgramPredicate([
        programEnvironmentPredicate(
          receipt.before,
          programLogicalKeyFromDraft(receipt.request.draft),
        ),
        programAbsentPredicate("fitness_programs", receipt.after.program.id),
        ...receipt.after.days.map(({ id }) =>
          programAbsentPredicate("fitness_program_days", id)),
        ...receipt.after.items.map(({ id }) =>
          programAbsentPredicate("fitness_program_items", id)),
        ...receipt.after.events.map(({ id }) =>
          programAbsentPredicate("fitness_calendar_events", id)),
        programMarkerAbsentPredicate(receipt),
      ]);
      return [
        programCasSentinel(predicate),
        {
          sql: "UPDATE fitness_programs SET status='archived',updated_at=? WHERE status='active'",
          params: [receipt.preparedAt],
        },
        insertProgram(receipt.after.program),
        ...receipt.after.days.map(insertProgramDay),
        ...receipt.after.items.map(insertProgramItem),
        ...receipt.after.events.map(insertProgramEvent),
        insertProgramMarker(receipt),
      ];
    }
    const createdIds = new Set(receipt.after.createdEventIds);
    const predicate = joinedProgramPredicate([
      weekExpectationPredicate(receipt.before, receipt.request.scheduleTimeZone),
      ...receipt.after.createdEventIds.map((id) =>
        programAbsentPredicate("fitness_calendar_events", id)),
      programMarkerAbsentPredicate(receipt),
    ]);
    return [
      programCasSentinel(predicate),
      ...receipt.after.events.filter(({ id }) => createdIds.has(id)).map(insertProgramEvent),
      insertProgramMarker(receipt),
    ];
  }

  function safeBroadcast(reason: string): void {
    try {
      runtime.broadcast(reason);
    } catch {
      // A refresh hint cannot reverse a durable program transaction.
    }
  }

  async function inspectWrite(value: unknown): Promise<FitnessProgramWriteInspection> {
    if (!isFitnessProgramWriteReceipt(value)) return "invalid_receipt";
    let receipt: FitnessProgramWriteReceipt;
    try {
      receipt = snapshotProgramInput(value);
    } catch {
      return "invalid_receipt";
    }
    if (!isFitnessProgramWriteReceipt(receipt)) return "invalid_receipt";
    try {
      if (!await programReceiptHashIsValid(receipt)) return "invalid_receipt";
    } catch {
      return "invalid_receipt";
    }
    try {
      return await runtime.withExclusiveLock(() => receiptStateUnlocked(receipt));
    } catch {
      return "still_unknown";
    }
  }

  async function commitWrite(value: unknown): Promise<FitnessProgramWriteResult> {
    if (!isFitnessProgramWriteReceipt(value)) {
      throw programError("invalid_receipt", "计划写入回执无效；没有改动计划或日历。");
    }
    let receipt: FitnessProgramWriteReceipt;
    try {
      receipt = snapshotProgramInput(value);
    } catch {
      throw programError("invalid_receipt", "计划写入回执无效；没有改动计划或日历。");
    }
    if (!isFitnessProgramWriteReceipt(receipt)) {
      throw programError("invalid_receipt", "计划写入回执无效；没有改动计划或日历。");
    }
    try {
      if (!await programReceiptHashIsValid(receipt)) {
        throw programError("invalid_receipt", "计划写入回执无法验证；没有改动计划或日历。");
      }
    } catch (error) {
      if (error instanceof FitnessProgramMutationError) throw error;
      throw programError("invalid_receipt", "计划写入回执无法验证；没有改动计划或日历。");
    }
    const entityId = receipt.kind === "program-version-schedule"
      ? receipt.after.program.id
      : receipt.before.program.id;
    try {
      return await runtime.withExclusiveLock(async () => {
        const before = await receiptStateUnlocked(receipt);
        if (before === "exact_saved") {
          safeBroadcast(receipt.kind === "program-version-schedule"
            ? "program-saved"
            : "program-scheduled");
          return {
            outcome: "already_saved" as const,
            receipt,
            entityId,
            updatedAt: receipt.preparedAt,
          };
        }
        if (before === "changed") {
          return { outcome: "changed" as const, receipt, entityId, retryable: false as const };
        }
        try {
          await runtime.batch(receiptStatements(receipt));
        } catch {
          // The transaction may have committed even when its response was lost.
        }
        const after = await receiptStateUnlocked(receipt);
        if (after === "exact_saved") {
          safeBroadcast(receipt.kind === "program-version-schedule"
            ? "program-saved"
            : "program-scheduled");
          return {
            outcome: "saved" as const,
            receipt,
            entityId,
            updatedAt: receipt.preparedAt,
          };
        }
        if (after === "expected") {
          throw programError(
            "write_failed",
            "计划确定没有写入；保留回执后可以重试。",
            receipt,
          );
        }
        return { outcome: "changed" as const, receipt, entityId, retryable: false as const };
      });
    } catch (error) {
      if (error instanceof FitnessProgramMutationError) throw error;
      return {
        outcome: "outcome_uncertain",
        receipt,
        entityId,
        retryable: true,
      };
    }
  }

  return {
    prepareFitnessProgramVersionSchedule: prepareVersionSchedule,
    prepareFitnessProgramWeekSchedule: prepareWeekSchedule,
    inspectFitnessProgramWrite: inspectWrite,
    commitFitnessProgramWrite: commitWrite,
  } as const;
}

const defaultFitnessProgramStorageService = createFitnessProgramStorageService();

export const prepareFitnessProgramVersionSchedule =
  defaultFitnessProgramStorageService.prepareFitnessProgramVersionSchedule;
export const prepareFitnessProgramWeekSchedule =
  defaultFitnessProgramStorageService.prepareFitnessProgramWeekSchedule;
export const inspectFitnessProgramWrite =
  defaultFitnessProgramStorageService.inspectFitnessProgramWrite;
export const commitFitnessProgramWrite =
  defaultFitnessProgramStorageService.commitFitnessProgramWrite;

function calendarTransition(receipt: FitnessCalendarWriteReceipt): boolean {
  const { before, after, preparedAt } = receipt;
  if (!isFitnessLiveEvent(before) || !isFitnessLiveEvent(after) ||
      before.status !== "planned" || before.id !== after.id ||
      !strictlyAfterEvery(preparedAt, [before.created_at, before.updated_at]) ||
      after.updated_at !== preparedAt || after.created_at !== before.created_at) return false;
  if (receipt.kind === "calendar-reschedule") {
    return after.starts_at !== before.starts_at && sameProjection(after, {
      ...before,
      starts_at: after.starts_at,
      updated_at: preparedAt,
    });
  }
  return safeString(after.note, 4_000) && after.note === after.note.trim() &&
    sameProjection(after, {
      ...before,
      status: "not_performed",
      note: after.note,
      updated_at: preparedAt,
    });
}

function hasValidCalendarReceiptBase(
  value: object,
  kind: FitnessCalendarWriteReceipt["kind"],
): boolean {
  const receipt = value as Partial<FitnessCalendarWriteReceipt>;
  return exactObjectKeys(value, [
    "purpose", "version", "operationId", "generationId", "generationSequence",
    "preparedAt", "kind", "projectionSha256", "before", "after",
  ]) && receipt.purpose === "fitness-calendar-write" && receipt.version === 1 &&
    receipt.kind === kind && typeof receipt.operationId === "string" &&
    CALENDAR_OPERATION_ID_PATTERN.test(receipt.operationId) &&
    typeof receipt.generationId === "string" &&
    CONFIG_GENERATION_ID_PATTERN.test(receipt.generationId) &&
    liveInteger(receipt.generationSequence, 0, Number.MAX_SAFE_INTEGER) &&
    safeTimestamp(receipt.preparedAt) && typeof receipt.projectionSha256 === "string" &&
    CONFIG_HASH_PATTERN.test(receipt.projectionSha256);
}

function isFitnessCalendarWriteReceiptUnchecked(
  value: unknown,
): value is FitnessCalendarWriteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !jsonWithinUnits(value, LIVE_MAX_RECEIPT_JSON_UNITS)) return false;
  const receipt = value as Partial<FitnessCalendarWriteReceipt>;
  if (receipt.kind !== "calendar-reschedule" && receipt.kind !== "calendar-not-performed") {
    return false;
  }
  return hasValidCalendarReceiptBase(value, receipt.kind) &&
    calendarTransition(receipt as FitnessCalendarWriteReceipt);
}

export function isFitnessCalendarWriteReceipt(
  value: unknown,
): value is FitnessCalendarWriteReceipt {
  try {
    return isFitnessCalendarWriteReceiptUnchecked(value);
  } catch {
    return false;
  }
}

async function sealCalendarReceipt<Receipt extends FitnessCalendarWriteReceipt>(
  draft: Omit<Receipt, "projectionSha256">,
): Promise<Receipt> {
  const projectionSha256 = await sha256Hex(canonicalJson(draft));
  return { ...draft, projectionSha256 } as Receipt;
}

async function calendarReceiptHashIsValid(
  receipt: FitnessCalendarWriteReceipt,
): Promise<boolean> {
  const { projectionSha256, ...projection } = receipt;
  return projectionSha256 === await sha256Hex(canonicalJson(projection));
}

function snapshotCalendarInput<Input>(value: Input): Input {
  try {
    return JSON.parse(JSON.stringify(value)) as Input;
  } catch {
    throw calendarError("invalid_input", "日历写入内容不能安全复制。");
  }
}

export function createFitnessCalendarStorageService(
  runtime: FitnessLiveStorageRuntime = {
    withExclusiveLock: (operation) => withFitnessWriteLock(operation, { requireSupport: true }),
    query: async <Result extends object>(sql: string, params?: SqlParams) => ({
      rows: await rawQuery<Result>(sql, params),
    }),
    batch: (statements) => rawBatch(statements),
    currentGeneration: () => localDb.currentGeneration(DB),
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    broadcast: broadcastFitnessChange,
  },
) {
  type CalendarPredicate = Readonly<{ sql: string; params: readonly unknown[] }>;

  async function prepareLocked<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await runtime.withExclusiveLock(operation);
    } catch (error) {
      if (error instanceof FitnessCalendarMutationError) throw error;
      if (error instanceof TypeError) throw calendarError("invalid_input", error.message);
      throw calendarError("inspect_failed", "暂时无法核对日历安排；没有开始写入。");
    }
  }

  async function readEvent(id: string): Promise<FitnessCalendarEvent | null> {
    const rows = await liveRows<FitnessCalendarEvent>(
      runtime,
      "SELECT * FROM fitness_calendar_events WHERE id=? LIMIT 1",
      [id],
    );
    return rows[0] ?? null;
  }

  async function prepareReschedule(
    input: PrepareFitnessCalendarRescheduleInput,
    expected: FitnessCalendarEvent,
  ): Promise<FitnessCalendarRescheduleReceipt> {
    const stableInput = snapshotCalendarInput(input);
    const stableExpected = snapshotCalendarInput(expected);
    return prepareLocked(async () => {
      if (!stableInput || typeof stableInput !== "object" || Array.isArray(stableInput) ||
          !exactObjectKeys(stableInput, ["eventId", "startsAt"]) ||
          !safeOpaqueId(stableInput.eventId) || !safeTimestamp(stableInput.startsAt) ||
          !isFitnessLiveEvent(stableExpected) || stableExpected.id !== stableInput.eventId) {
        throw calendarError("invalid_input", "日历安排、目标时间或画面快照无效。");
      }
      if (stableExpected.status !== "planned" ||
          stableExpected.starts_at === stableInput.startsAt) {
        throw calendarError("invalid_input", "只能把尚未开始的安排改到另一个时间。");
      }
      const current = await readEvent(stableInput.eventId);
      if (!sameProjection(current, stableExpected)) {
        throw calendarError("changed", "日历安排已变化；没有准备改期。");
      }
      const generation = await readConfigGeneration(runtime);
      const preparedAt = nextLiveTimestamp(runtime.now(), [
        stableExpected.created_at,
        stableExpected.updated_at,
      ]);
      const receipt = await sealCalendarReceipt<FitnessCalendarRescheduleReceipt>({
        purpose: "fitness-calendar-write",
        version: 1,
        operationId: generatedCalendarOperationId(runtime),
        ...generation,
        preparedAt,
        kind: "calendar-reschedule",
        before: stableExpected,
        after: {
          ...stableExpected,
          starts_at: stableInput.startsAt,
          updated_at: preparedAt,
        },
      });
      if (!isFitnessCalendarWriteReceipt(receipt)) {
        throw calendarError("invalid_input", "无法构造可靠的日历改期回执。");
      }
      return receipt;
    });
  }

  async function prepareNotPerformed(
    input: PrepareFitnessCalendarNotPerformedInput,
    expected: FitnessCalendarEvent,
  ): Promise<FitnessCalendarNotPerformedReceipt> {
    const stableInput = snapshotCalendarInput(input);
    const stableExpected = snapshotCalendarInput(expected);
    const stableNote = stableInput && typeof stableInput === "object" &&
        !Array.isArray(stableInput) && typeof stableInput.note === "string"
      ? stableInput.note.trim()
      : "";
    return prepareLocked(async () => {
      if (!stableInput || typeof stableInput !== "object" || Array.isArray(stableInput) ||
          !Object.keys(stableInput).every((key) => key === "eventId" || key === "note") ||
          !safeOpaqueId(stableInput.eventId) ||
          !(stableInput.note === undefined || safeString(stableInput.note, 4_000)) ||
          !safeString(stableNote, 4_000) || !isFitnessLiveEvent(stableExpected) ||
          stableExpected.id !== stableInput.eventId) {
        throw calendarError("invalid_input", "日历安排、说明或画面快照无效。");
      }
      if (stableExpected.status !== "planned") {
        throw calendarError("invalid_input", "只能标记尚未开始的日历安排。");
      }
      const current = await readEvent(stableInput.eventId);
      if (!sameProjection(current, stableExpected)) {
        throw calendarError("changed", "日历安排已变化；没有准备标记未进行。");
      }
      const generation = await readConfigGeneration(runtime);
      const preparedAt = nextLiveTimestamp(runtime.now(), [
        stableExpected.created_at,
        stableExpected.updated_at,
      ]);
      const receipt = await sealCalendarReceipt<FitnessCalendarNotPerformedReceipt>({
        purpose: "fitness-calendar-write",
        version: 1,
        operationId: generatedCalendarOperationId(runtime),
        ...generation,
        preparedAt,
        kind: "calendar-not-performed",
        before: stableExpected,
        after: {
          ...stableExpected,
          status: "not_performed",
          note: stableNote,
          updated_at: preparedAt,
        },
      });
      if (!isFitnessCalendarWriteReceipt(receipt)) {
        throw calendarError("invalid_input", "无法构造可靠的日历未进行回执。");
      }
      return receipt;
    });
  }

  async function receiptStateUnlocked(
    receipt: FitnessCalendarWriteReceipt,
  ): Promise<Exclude<FitnessCalendarWriteInspection, "still_unknown" | "invalid_receipt">> {
    const generation = await readConfigGeneration(runtime);
    if (generation.generationId !== receipt.generationId ||
        generation.generationSequence !== receipt.generationSequence) return "changed";
    const current = await readEvent(receipt.before.id);
    if (sameProjection(current, receipt.after)) return "exact_saved";
    return sameProjection(current, receipt.before) ? "expected" : "changed";
  }

  function eventPredicate(row: FitnessCalendarEvent): CalendarPredicate {
    return {
      sql: `EXISTS(SELECT 1 FROM fitness_calendar_events WHERE id=?
        AND program_day_id IS ? AND venue_id IS ? AND title IS ? AND kind IS ?
        AND starts_at IS ? AND occurrence_key IS ? AND planned_minutes IS ?
        AND status IS ? AND rescheduled_from_id IS ? AND note IS ?
        AND created_at IS ? AND updated_at IS ?)`,
      params: [
        row.id,
        row.program_day_id,
        row.venue_id,
        row.title,
        row.kind,
        row.starts_at,
        row.occurrence_key,
        row.planned_minutes,
        row.status,
        row.rescheduled_from_id,
        row.note,
        row.created_at,
        row.updated_at,
      ],
    };
  }

  function receiptStatements(receipt: FitnessCalendarWriteReceipt): SqlStatement[] {
    const predicate = eventPredicate(receipt.before);
    const sentinel: SqlStatement = {
      sql: `INSERT INTO fitness_settings(key,value,updated_at)
        SELECT '__fitness_calendar_cas_abort__',NULL,0 WHERE NOT (${predicate.sql})`,
      params: predicate.params,
    };
    if (receipt.kind === "calendar-reschedule") {
      return [sentinel, {
        sql: "UPDATE fitness_calendar_events SET starts_at=?,updated_at=? WHERE id=?",
        params: [receipt.after.starts_at, receipt.after.updated_at, receipt.after.id],
      }];
    }
    return [sentinel, {
      sql: "UPDATE fitness_calendar_events SET status='not_performed',note=?,updated_at=? WHERE id=?",
      params: [receipt.after.note, receipt.after.updated_at, receipt.after.id],
    }];
  }

  function safeBroadcast(reason: string): void {
    try {
      runtime.broadcast(reason);
    } catch {
      // A refresh hint cannot reverse a durable calendar transaction.
    }
  }

  async function inspectWrite(value: unknown): Promise<FitnessCalendarWriteInspection> {
    if (!isFitnessCalendarWriteReceipt(value)) return "invalid_receipt";
    let receipt: FitnessCalendarWriteReceipt;
    try {
      receipt = snapshotCalendarInput(value);
    } catch {
      return "invalid_receipt";
    }
    if (!isFitnessCalendarWriteReceipt(receipt)) return "invalid_receipt";
    try {
      if (!await calendarReceiptHashIsValid(receipt)) return "invalid_receipt";
    } catch {
      return "invalid_receipt";
    }
    try {
      return await runtime.withExclusiveLock(() => receiptStateUnlocked(receipt));
    } catch {
      return "still_unknown";
    }
  }

  async function commitWrite(value: unknown): Promise<FitnessCalendarWriteResult> {
    if (!isFitnessCalendarWriteReceipt(value)) {
      throw calendarError("invalid_receipt", "日历写入回执无效；没有改动日历。 ");
    }
    let receipt: FitnessCalendarWriteReceipt;
    try {
      receipt = snapshotCalendarInput(value);
    } catch {
      throw calendarError("invalid_receipt", "日历写入回执无效；没有改动日历。");
    }
    if (!isFitnessCalendarWriteReceipt(receipt)) {
      throw calendarError("invalid_receipt", "日历写入回执无效；没有改动日历。");
    }
    try {
      if (!await calendarReceiptHashIsValid(receipt)) {
        throw calendarError("invalid_receipt", "日历写入回执无法验证；没有改动日历。");
      }
    } catch (error) {
      if (error instanceof FitnessCalendarMutationError) throw error;
      throw calendarError("invalid_receipt", "日历写入回执无法验证；没有改动日历。");
    }
    const entityId = receipt.before.id;
    const reason = receipt.kind === "calendar-reschedule"
      ? "event-rescheduled"
      : "event-not-performed";
    try {
      return await runtime.withExclusiveLock(async () => {
        const before = await receiptStateUnlocked(receipt);
        if (before === "exact_saved") {
          safeBroadcast(reason);
          return {
            outcome: "already_saved" as const,
            receipt,
            entityId,
            updatedAt: receipt.preparedAt,
          };
        }
        if (before === "changed") {
          return { outcome: "changed" as const, receipt, entityId, retryable: false as const };
        }
        try {
          await runtime.batch(receiptStatements(receipt));
        } catch {
          // The transaction may have committed even when its response was lost.
        }
        const after = await receiptStateUnlocked(receipt);
        if (after === "exact_saved") {
          safeBroadcast(reason);
          return {
            outcome: "saved" as const,
            receipt,
            entityId,
            updatedAt: receipt.preparedAt,
          };
        }
        if (after === "expected") {
          throw calendarError(
            "write_failed",
            "日历安排确定没有写入；保留回执后可以重试。",
            receipt,
          );
        }
        return { outcome: "changed" as const, receipt, entityId, retryable: false as const };
      });
    } catch (error) {
      if (error instanceof FitnessCalendarMutationError) throw error;
      return {
        outcome: "outcome_uncertain",
        receipt,
        entityId,
        retryable: true,
      };
    }
  }

  return {
    prepareFitnessCalendarReschedule: prepareReschedule,
    prepareFitnessCalendarNotPerformed: prepareNotPerformed,
    inspectFitnessCalendarWrite: inspectWrite,
    commitFitnessCalendarWrite: commitWrite,
  } as const;
}

const defaultFitnessCalendarStorageService = createFitnessCalendarStorageService();

export const prepareFitnessCalendarReschedule =
  defaultFitnessCalendarStorageService.prepareFitnessCalendarReschedule;
export const prepareFitnessCalendarNotPerformed =
  defaultFitnessCalendarStorageService.prepareFitnessCalendarNotPerformed;
export const inspectFitnessCalendarWrite =
  defaultFitnessCalendarStorageService.inspectFitnessCalendarWrite;
export const commitFitnessCalendarWrite =
  defaultFitnessCalendarStorageService.commitFitnessCalendarWrite;

function canComposePlateLoadedWeight(
  targetGrams: number,
  primary: FitnessEquipment,
  resources: readonly FitnessEquipment[],
  loads: readonly FitnessEquipmentLoad[],
): boolean {
  if (primary.bar_weight_grams === null || targetGrams < primary.bar_weight_grams) return false;
  const added = targetGrams - primary.bar_weight_grams;
  if (added % 2 !== 0) return false;
  const perSideTarget = added / 2;
  const plateEquipmentIds = new Set(
    resources.filter(({ kind }) => kind === "plates").map(({ id }) => id),
  );
  const available = loads.filter((load) =>
    plateEquipmentIds.has(load.equipment_id) && load.available && load.load_grams > 0
  );
  let reachable = new Set([0]);
  for (const load of available) {
    const copiesPerSide = Math.floor(load.quantity / 2);
    for (let copy = 0; copy < copiesPerSide; copy += 1) {
      const next = new Set(reachable);
      for (const current of reachable) {
        const combined = current + load.load_grams;
        if (combined <= perSideTarget) next.add(combined);
      }
      reachable = next;
    }
  }
  return reachable.has(perSideTarget);
}

function canonicalEquipmentSnapshot(
  resources: readonly FitnessEquipment[],
  loads: readonly FitnessEquipmentLoad[],
): string {
  const resourceIds = new Set(resources.map(({ id }) => id));
  return JSON.stringify(resources.map((resource) => ({
    id: resource.id,
    venue_id: resource.venue_id,
    name: resource.name,
    kind: resource.kind,
    quantity: resource.quantity,
    status: resource.status,
    load_mode: resource.load_mode,
    load_semantics: resource.load_semantics,
    min_load_grams: resource.min_load_grams,
    max_load_grams: resource.max_load_grams,
    increment_grams: resource.increment_grams,
    bar_weight_grams: resource.bar_weight_grams,
    loads: loads.filter((load) => resourceIds.has(load.equipment_id) && load.equipment_id === resource.id)
      .map((load) => ({
        load_grams: load.load_grams,
        quantity: load.quantity,
        label: load.label,
        available: load.available,
      })),
  })));
}

function snapshotResourceIds(value: string | undefined): string[] {
  const source = value?.trim();
  if (!source) return [];
  if (source.length > 100_000) throw new TypeError("器材快照过大");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new TypeError("器材快照不是有效 JSON");
  }
  if (!Array.isArray(parsed) || parsed.length > 20) {
    throw new TypeError("器材快照必须是不超过 20 项的清单");
  }
  const ids = parsed.map((entry) => {
    if (typeof entry === "string") return requireNonEmpty(entry, "器材快照 ID");
    if (
      entry && typeof entry === "object" && "id" in entry &&
      typeof entry.id === "string"
    ) {
      return requireNonEmpty(entry.id, "器材快照 ID");
    }
    throw new TypeError("器材快照项缺少 ID");
  });
  requireUniqueStrings(ids, "器材快照");
  return ids;
}

async function resolveSessionEquipmentSnapshot(
  exercise: FitnessExercise,
  venueId: string,
  equipmentId: string | null,
  requestedSnapshot: string | undefined,
): Promise<string> {
  const ids = [...new Set([
    ...(equipmentId ? [equipmentId] : []),
    ...snapshotResourceIds(requestedSnapshot),
  ])];
  if (ids.length === 0) {
    if (exercise.requirements.some(({ optional }) => !optional)) {
      throw new Error("这个动作缺少当前场地的必需器材");
    }
    return "[]";
  }
  const placeholders = ids.map(() => "?").join(",");
  const rows = (await rawQuery<Row>(
    `SELECT * FROM fitness_equipment
      WHERE venue_id=? AND status IN ('available','limited') AND id IN (${placeholders})`,
    [venueId, ...ids],
  )).map(mapEquipment);
  const equipmentById = new Map(rows.map((entry) => [entry.id, entry]));
  const resources = ids.flatMap((id) => {
    const equipment = equipmentById.get(id);
    return equipment ? [equipment] : [];
  });
  if (resources.length !== ids.length) {
    throw new Error("器材快照包含不属于当前场地或不可用的器材");
  }
  const requirementKinds = new Set(exercise.requirements.map(({ kind }) => kind));
  if (resources.some(({ kind }) => !requirementKinds.has(kind))) {
    throw new Error("器材快照包含与这个动作无关的器材");
  }
  if (exercise.requirements.some((requirement) =>
    !requirement.optional && !resources.some((equipment) =>
      equipment.kind === requirement.kind
    )
  )) {
    throw new Error("这个动作缺少当前场地的完整器材资源");
  }
  const loads = (await rawQuery<Row>(
    `SELECT * FROM fitness_equipment_loads
      WHERE equipment_id IN (${placeholders}) ORDER BY equipment_id,load_grams`,
    ids,
  )).map(mapEquipmentLoad);
  for (const resource of resources) {
    if (!equipmentSupportsExercise(exercise, resource, loads)) {
      throw new Error(`动作「${exercise.name_zh}」的器材数量不足`);
    }
  }
  return canonicalEquipmentSnapshot(resources, loads);
}

function assertDraftReferences(
  draft: FitnessPlanDraft,
  venue: FitnessVenue,
  equipment: readonly FitnessEquipment[],
  loads: readonly FitnessEquipmentLoad[],
  constraints: readonly FitnessConstraint[],
): readonly (readonly string[])[] {
  requireNonEmpty(draft.name, "计划名称");
  requireUniqueStrings(draft.assumptions, "计划假设");
  draft.assumptions.forEach((assumption) => requireNonEmpty(assumption, "计划假设", 500));
  if (draft.venue_id !== venue.id || venue.status !== "active") {
    throw new Error("计划草稿引用了不可用的场地");
  }
  if (!Array.isArray(draft.days) || draft.days.length === 0 || draft.days.length > 28) {
    throw new TypeError("计划必须包含 1 至 28 个训练日");
  }
  const equipmentById = new Map(equipment.map((entry) => [entry.id, entry]));
  const snapshots: string[][] = [];
  for (const day of draft.days) {
    requireNonEmpty(day.name, "训练日名称");
    requireInteger(day.estimated_minutes, "计划时长", 0, 240);
    if (day.weekday !== null) requireInteger(day.weekday, "计划星期", 0, 6);
    if (day.kind === "rest" && day.items.length > 0) throw new Error("休息日不能包含训练动作");
    if (day.kind !== "rest" && day.items.length === 0) throw new Error("训练日不能是空计划");
    const daySnapshots: string[] = [];
    for (const [itemIndex, item] of day.items.entries()) {
      const exercise = getFitnessExercise(item.exercise_id);
      if (!exercise) throw new Error(`计划引用了未知动作：${item.exercise_id}`);
      requireInteger(item.order_index, `动作「${exercise.name_zh}」的顺序`, 0, 10_000);
      if (item.order_index !== itemIndex) {
        throw new TypeError(`动作「${exercise.name_zh}」的顺序与草稿不一致`);
      }
      requireInteger(item.sets, `动作「${exercise.name_zh}」的组数`, 1, 20);
      requireInteger(item.rest_seconds, `动作「${exercise.name_zh}」的休息时间`, 0, 1200);
      if (item.rep_min !== null) requireInteger(item.rep_min, "最低次数", 1, 1000);
      if (item.rep_max !== null) requireInteger(item.rep_max, "最高次数", 1, 1000);
      if (item.duration_seconds !== null) {
        requireInteger(item.duration_seconds, "动作持续时间", 1, 86_400);
      }
      if (item.target_rir !== null) requireInteger(item.target_rir, "目标 RIR", 0, 5);
      if ((item.rep_min === null) !== (item.rep_max === null)) {
        throw new TypeError(`动作「${exercise.name_zh}」的次数范围不完整`);
      }
      if (item.rep_min !== null && item.rep_max !== null && item.rep_max < item.rep_min) {
        throw new TypeError(`动作「${exercise.name_zh}」的次数范围前后颠倒`);
      }
      if (item.rep_min === null && item.duration_seconds === null) {
        throw new TypeError(`动作「${exercise.name_zh}」缺少次数或时长`);
      }
      requireUniqueStrings(item.resource_equipment_ids, "器材资源清单");
      requireUniqueStrings(item.substitution_exercise_ids, "替代动作清单");
      if (item.substitution_exercise_ids.some((id: string) => id === item.exercise_id || !getFitnessExercise(id))) {
        throw new Error(`动作「${exercise.name_zh}」包含无效替代动作`);
      }
      if (exerciseIsAvoided(exercise, constraints)) {
        throw new Error(`动作「${exercise.name_zh}」与当前避用限制冲突`);
      }
      const resources = item.resource_equipment_ids.map((id: string) => equipmentById.get(id));
      if (resources.some((entry: FitnessEquipment | undefined) => !entry || entry.venue_id !== venue.id || !["available", "limited"].includes(entry.status))) {
        throw new Error(`动作「${exercise.name_zh}」引用了当前场地不可用的器材`);
      }
      const availableResources = resources as FitnessEquipment[];
      const requirementKinds = new Set(exercise.requirements.map(({ kind }) => kind));
      if (availableResources.some(({ kind }) => !requirementKinds.has(kind))) {
        throw new Error(`动作「${exercise.name_zh}」包含与动作无关的器材`);
      }
      if (exercise.requirements.some((requirement) =>
        !requirement.optional && !availableResources.some((entry) =>
          entry.kind === requirement.kind
        )
      )) {
        throw new Error(`动作「${exercise.name_zh}」缺少完整器材资源`);
      }
      for (const resource of availableResources) {
        if (!equipmentSupportsExercise(exercise, resource, loads)) {
          throw new Error(`动作「${exercise.name_zh}」没有数量足够的同档器材`);
        }
      }
      if (item.equipment_id && !item.resource_equipment_ids.includes(item.equipment_id)) {
        throw new Error(`动作「${exercise.name_zh}」的主要器材不在资源清单中`);
      }
      if (
        item.equipment_id &&
        !requirementKinds.has(equipmentById.get(item.equipment_id)?.kind ?? "other")
      ) {
        throw new Error(`动作「${exercise.name_zh}」的主要器材与动作不匹配`);
      }
      if (item.load_grams !== null) {
        if (!item.equipment_id) throw new Error(`动作「${exercise.name_zh}」的重量没有绑定主要器材`);
        requireInteger(item.load_grams, "计划重量", 0, 10_000_000);
        const primary = equipmentById.get(item.equipment_id);
        if (!primary) throw new Error(`动作「${exercise.name_zh}」的主要器材不存在`);
        if (primary.load_mode === "none") {
          throw new Error(`动作「${exercise.name_zh}」的器材不接受重量处方`);
        }
        if (primary.load_mode === "discrete") {
          const selected = loads.filter((load) =>
            load.equipment_id === primary.id && load.available && load.load_grams === item.load_grams
          );
          if (selected.length === 0) throw new Error(`动作「${exercise.name_zh}」使用了器材清单中不存在的重量`);
          if (
            selected.reduce((sum, load) => sum + load.quantity, 0) <
              requiredEquipmentQuantity(exercise, primary)
          ) {
            throw new Error(`动作「${exercise.name_zh}」在这一档重量下器材数量不足`);
          }
          if (
            (primary.min_load_grams !== null && item.load_grams < primary.min_load_grams) ||
            (primary.max_load_grams !== null && item.load_grams > primary.max_load_grams)
          ) {
            throw new Error(`动作「${exercise.name_zh}」的重量超出器材范围`);
          }
        }
        if (primary.load_mode === "range") {
          if (
            primary.min_load_grams === null || primary.max_load_grams === null ||
            primary.increment_grams === null
          ) {
            throw new Error(`动作「${exercise.name_zh}」的器材重量范围尚未确认`);
          }
          const minimum = primary.min_load_grams;
          const maximum = primary.max_load_grams;
          if (item.load_grams < minimum || (maximum !== null && item.load_grams > maximum)) {
            throw new Error(`动作「${exercise.name_zh}」的重量超出器材范围`);
          }
          if (primary.increment_grams && (item.load_grams - minimum) % primary.increment_grams !== 0) {
            throw new Error(`动作「${exercise.name_zh}」的重量不符合器材增量`);
          }
        }
        if (
          primary.load_mode === "plate_loaded" &&
          !canComposePlateLoadedWeight(item.load_grams, primary, availableResources, loads)
        ) {
          throw new Error(`动作「${exercise.name_zh}」的重量无法用当前杠铃片组成`);
        }
      }
      daySnapshots.push(canonicalEquipmentSnapshot(availableResources, loads));
    }
    snapshots.push(daySnapshots);
  }
  return snapshots;
}

export async function saveProgramDraft(
  draft: FitnessPlanDraft,
  source: FitnessProgram["source"] = "local",
  activate = true,
): Promise<string> {
  return write("program-saved", async () => {
    const venue = (await rawQuery<Row>("SELECT * FROM fitness_venues WHERE id=?", [draft.venue_id])).map(mapVenue)[0];
    if (!venue) throw new Error("计划场地不存在");
    const equipment = (await rawQuery<Row>("SELECT * FROM fitness_equipment WHERE venue_id=?", [draft.venue_id])).map(mapEquipment);
    const loads = (await rawQuery<Row>("SELECT l.* FROM fitness_equipment_loads l JOIN fitness_equipment e ON e.id=l.equipment_id WHERE e.venue_id=?", [draft.venue_id])).map(mapEquipmentLoad);
    const constraints = (await rawQuery<Row>("SELECT * FROM fitness_constraints WHERE active=1")).map(mapConstraint);
    const equipmentSnapshots = assertDraftReferences(draft, venue, equipment, loads, constraints);

    const name = requireNonEmpty(draft.name, "计划名称", 160);
    const previousVersion = (await rawQuery<{ version: number }>(
      `SELECT COALESCE(MAX(version),0) version
        FROM fitness_programs
        WHERE venue_id=? AND name=? AND goal=? AND split=?`,
      [draft.venue_id, name, draft.goal, draft.split],
    ))[0]?.version ?? 0;
    const version = requireInteger(Number(previousVersion) + 1, "计划版本", 1, Number.MAX_SAFE_INTEGER);
    const now = Date.now();
    const programId = uid("program");
    const statements: SqlStatement[] = [];
    if (activate) statements.push({ sql: "UPDATE fitness_programs SET status='archived',updated_at=? WHERE status='active'", params: [now] });
    statements.push({
      sql: "INSERT INTO fitness_programs(id,name,venue_id,goal,split,status,version,source,assumptions_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      params: [programId, name, draft.venue_id, draft.goal, draft.split, activate ? "active" : "draft", version, source, JSON.stringify(draft.assumptions), now, now],
    });
    draft.days.forEach((day, dayIndex) => {
      const dayId = uid("program-day");
      statements.push({
        sql: "INSERT INTO fitness_program_days(id,program_id,day_index,weekday,kind,name,focus,estimated_minutes,variant,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        params: [dayId, programId, dayIndex, day.weekday, day.kind, day.name, day.focus, day.estimated_minutes, "standard", now],
      });
      day.items.forEach((item, itemIndex) => statements.push({
        sql: `INSERT INTO fitness_program_items(
          id,program_day_id,exercise_id,equipment_id,resource_equipment_ids_json,
          order_index,sets,rep_min,rep_max,duration_seconds,target_rir,rest_seconds,
          load_grams,load_guidance,rationale,substitution_exercise_ids_json,
          equipment_snapshot,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [uid("program-item"), dayId, item.exercise_id, item.equipment_id, JSON.stringify(item.resource_equipment_ids), itemIndex, item.sets, item.rep_min, item.rep_max, item.duration_seconds, item.target_rir, item.rest_seconds, item.load_grams, item.load_guidance, item.rationale, JSON.stringify(item.substitution_exercise_ids), equipmentSnapshots[dayIndex]?.[itemIndex] ?? "[]", now],
      }));
    });
    await rawBatch(statements);
    return programId;
  });
}

function nextDateForWeekday(start: Date, weekday: number) {
  const next = new Date(start);
  const delta = (weekday - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + delta);
  next.setHours(18, 0, 0, 0);
  if (next.getTime() < start.getTime()) next.setDate(next.getDate() + 7);
  return next.getTime();
}

function occurrenceKeyFor(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new TypeError("排期日期无效");
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export async function scheduleProgramWeek(programId: string, from = new Date()): Promise<string[]> {
  return write("program-scheduled", async () => {
    if (!Number.isFinite(from.getTime())) throw new TypeError("排期起始日期无效");
    const program = (await rawQuery<FitnessProgram>(
      `SELECT p.* FROM fitness_programs p
        JOIN fitness_venues v ON v.id=p.venue_id
        WHERE p.id=? AND p.status='active' AND v.status='active'`,
      [programId],
    ))[0];
    if (!program) throw new Error("只能安排当前启用的计划");
    const days = await rawQuery<FitnessProgramDay>("SELECT * FROM fitness_program_days WHERE program_id=? ORDER BY day_index", [programId]);
    const [items, constraints] = await Promise.all([
      rawQuery<{ exercise_id: string }>(
        `SELECT i.exercise_id
          FROM fitness_program_items i
          JOIN fitness_program_days d ON d.id=i.program_day_id
          WHERE d.program_id=?`,
        [programId],
      ),
      loadActiveAvoidConstraints(),
    ]);
    const conflicts = items.flatMap(({ exercise_id: exerciseId }) => {
      const exercise = getFitnessExercise(exerciseId);
      if (!exercise) throw new Error(`计划包含当前版本不识别的动作：${exerciseId}`);
      return exerciseIsAvoided(exercise, constraints) ? [exercise.name_zh] : [];
    });
    if (conflicts.length > 0) {
      throw new Error(`身体边界已更新，这版计划含有需要避开的动作「${[...new Set(conflicts)].join("、")}」；计划会保留，请生成适用版本后再排期`);
    }
    const now = Date.now();
    const ids: string[] = [];
    const statements: SqlStatement[] = [];
    for (const day of days) {
      if (day.weekday === null || day.kind === "rest") continue;
      const startsAt = nextDateForWeekday(from, day.weekday);
      const occurrenceKey = occurrenceKeyFor(startsAt);
      const duplicate = (await rawQuery<{ id: string }>(
        `SELECT e.id
          FROM fitness_calendar_events e
          JOIN fitness_program_days d ON d.id=e.program_day_id
          WHERE d.program_id=? AND e.program_day_id=?
            AND e.occurrence_key=?
          ORDER BY e.created_at,e.id
          LIMIT 1`,
        [programId, day.id, occurrenceKey],
      ))[0];
      if (duplicate) {
        ids.push(duplicate.id);
        continue;
      }
      const id = uid("event");
      ids.push(id);
      statements.push({
        sql: "INSERT INTO fitness_calendar_events(id,program_day_id,venue_id,title,kind,starts_at,occurrence_key,planned_minutes,status,rescheduled_from_id,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params: [id, day.id, program.venue_id, day.name, day.kind, startsAt, occurrenceKey, day.estimated_minutes, "planned", null, "", now, now],
      });
    }
    if (statements.length) await rawBatch(statements);
    return ids;
  });
}

export async function rescheduleCalendarEvent(id: string, startsAt: number, venueId?: string) {
  return write("event-rescheduled", async () => {
    requireInteger(startsAt, "新的日历时间", 0, Number.MAX_SAFE_INTEGER);
    const event = (await rawQuery<{ id: string; program_venue_id: string | null }>(
      `SELECT e.id,p.venue_id program_venue_id
        FROM fitness_calendar_events e
        LEFT JOIN fitness_program_days d ON d.id=e.program_day_id
        LEFT JOIN fitness_programs p ON p.id=d.program_id
        WHERE e.id=? AND e.status='planned'`,
      [id],
    ))[0];
    if (!event) throw new Error("只能改期尚未开始的日历安排");
    if (venueId) {
      if (event.program_venue_id && event.program_venue_id !== venueId) {
        throw new Error("计划日历不能直接改到另一个场地；请先按新器材重做计划");
      }
      const venue = (await rawQuery<{ id: string }>(
        "SELECT id FROM fitness_venues WHERE id=? AND status='active'",
        [venueId],
      ))[0];
      if (!venue) throw new Error("改期所选场地不可用");
    }
    await rawBatch([{ sql: "UPDATE fitness_calendar_events SET starts_at=?,venue_id=COALESCE(?,venue_id),updated_at=? WHERE id=? AND status='planned'", params: [startsAt, venueId ?? null, Date.now(), id] }]);
  });
}

export async function markCalendarEventNotPerformed(id: string, note = "") {
  return write("event-not-performed", async () => {
    const event = (await rawQuery<{ id: string }>(
      "SELECT id FROM fitness_calendar_events WHERE id=? AND status='planned'",
      [id],
    ))[0];
    if (!event) throw new Error("只能标记尚未开始的日历安排");
    await rawBatch([{ sql: "UPDATE fitness_calendar_events SET status='not_performed',note=?,updated_at=? WHERE id=? AND status='planned'", params: [note.trim(), Date.now(), id] }]);
  });
}

export async function startFitnessSession(input: {
  eventId?: string | null;
  venueId: string;
  programDayId?: string | null;
  availableMinutes?: number | null;
  energyNote?: FitnessSession["energy_note"];
  sorenessNote?: string;
}): Promise<string> {
  return write("session-started", async () => {
    if (input.availableMinutes !== undefined && input.availableMinutes !== null) {
      requireInteger(input.availableMinutes, "现场可用时间", 1, 1440);
    }
    const active = (await rawQuery<{
      id: string;
      event_id: string | null;
      venue_id: string;
      program_day_id: string | null;
    }>("SELECT id,event_id,venue_id,program_day_id FROM fitness_sessions WHERE status='active' LIMIT 1"))[0];
    if (active) {
      const sameRequest = active.venue_id === input.venueId &&
        active.event_id === (input.eventId ?? null) &&
        (input.programDayId === undefined || active.program_day_id === input.programDayId);
      if (sameRequest) return active.id;
      throw new Error("已有一场进行中的训练，请先回到现场记录或结束它");
    }
    const venue = (await rawQuery<{ id: string }>("SELECT id FROM fitness_venues WHERE id=? AND status='active'", [input.venueId]))[0];
    if (!venue) throw new Error("当前场地不可用");
    const now = Date.now();
    const sessionId = uid("session");
    const event = input.eventId
      ? (await rawQuery<FitnessCalendarEvent>("SELECT * FROM fitness_calendar_events WHERE id=? AND status='planned'", [input.eventId]))[0]
      : null;
    if (input.eventId && !event) throw new Error("这项日历安排已开始、取消或不存在");
    if (event?.venue_id && event.venue_id !== input.venueId) {
      throw new Error("请先在日历中切换场地，再开始这场训练");
    }
    if (
      event?.program_day_id &&
      input.programDayId !== undefined &&
      input.programDayId !== event.program_day_id
    ) {
      throw new Error("日历安排与指定训练日不一致");
    }
    const programDayId = input.programDayId ?? event?.program_day_id ?? null;
    if (programDayId) {
      const day = (await rawQuery<{ id: string; venue_id: string }>(
        `SELECT d.id,p.venue_id
          FROM fitness_program_days d
          JOIN fitness_programs p ON p.id=d.program_id
          WHERE d.id=?`,
        [programDayId],
      ))[0];
      if (!day) throw new Error("训练日不存在");
      if (day.venue_id !== input.venueId) throw new Error("训练日与当前场地不一致");
    }
    const items = programDayId
      ? await rawQuery<Row>("SELECT * FROM fitness_program_items WHERE program_day_id=? ORDER BY order_index", [programDayId])
      : [];
    const currentItems: Array<{ item: Row; snapshot: string }> = [];
    for (const item of items) {
      const exerciseId = String(item.exercise_id ?? "");
      const exercise = getFitnessExercise(exerciseId);
      if (!exercise) throw new Error("训练日包含当前版本不识别的动作");
      await assertExerciseIsAllowed(exercise);
      currentItems.push({
        item,
        snapshot: await resolveSessionEquipmentSnapshot(
          exercise,
          input.venueId,
          typeof item.equipment_id === "string" ? item.equipment_id : null,
          typeof item.equipment_snapshot === "string" ? item.equipment_snapshot : undefined,
        ),
      });
    }
    const statements: SqlStatement[] = [{
      sql: "INSERT INTO fitness_sessions(id,event_id,venue_id,program_day_id,started_at,ended_at,status,available_minutes,energy_note,soreness_note,reflection,created_at,updated_at) VALUES(?,?,?,?,?,NULL,'active',?,?,?,?,?,?)",
      params: [sessionId, event?.id ?? null, input.venueId, programDayId, now, input.availableMinutes ?? null, input.energyNote ?? "", input.sorenessNote?.trim() ?? "", "", now, now],
    }];
    currentItems.forEach(({ item, snapshot }, index) => statements.push({
      sql: "INSERT INTO fitness_session_exercises(id,session_id,exercise_id,equipment_id,planned_item_id,order_index,status,substituted_for_exercise_id,substitution_reason,equipment_snapshot,note,created_at,updated_at) VALUES(?,?,?,?,?,?,? ,NULL,'',?,'',?,?)",
      params: [uid("session-exercise"), sessionId, item.exercise_id, item.equipment_id, item.id, index, index === 0 ? "active" : "pending", snapshot, now, now],
    }));
    if (event) statements.push({ sql: "UPDATE fitness_calendar_events SET status='in_progress',updated_at=? WHERE id=?", params: [now, event.id] });
    await rawBatch(statements);
    return sessionId;
  });
}

export async function cancelEmptyFitnessSession(sessionId: string): Promise<void> {
  return write("session-cancelled", async () => {
    const id = requireNonEmpty(sessionId, "训练标识");
    const session = (await rawQuery<{
      event_id: string | null;
      status: FitnessSession["status"];
    }>(
      "SELECT event_id,status FROM fitness_sessions WHERE id=?",
      [id],
    ))[0];
    if (!session) throw new Error("这场训练不存在");
    if (session.status !== "active") throw new Error("只能撤销正在进行的空训练");

    const facts = (await rawQuery<{
      has_set_fact: number;
      has_cardio_fact: number;
    }>(
      `SELECT
        EXISTS(
          SELECT 1
          FROM fitness_sets recorded_set
          JOIN fitness_session_exercises exercise
            ON exercise.id=recorded_set.session_exercise_id
          WHERE exercise.session_id=?
            AND (
              recorded_set.completed=1
              OR recorded_set.reps IS NOT NULL
              OR recorded_set.duration_seconds IS NOT NULL
            )
        ) has_set_fact,
        EXISTS(
          SELECT 1 FROM fitness_cardio_entries cardio
          WHERE cardio.session_id=? AND cardio.duration_seconds IS NOT NULL
        ) has_cardio_fact`,
      [id, id],
    ))[0];
    if (Number(facts?.has_set_fact) === 1 || Number(facts?.has_cardio_fact) === 1) {
      throw new Error("这场训练已有完成组、次数或时长记录，不能作为空训练撤销");
    }

    if (session.event_id) {
      const event = (await rawQuery<{ status: FitnessCalendarEvent["status"] }>(
        "SELECT status FROM fitness_calendar_events WHERE id=?",
        [session.event_id],
      ))[0];
      if (!event) throw new Error("关联的日历安排不存在，未撤销训练");
      if (event.status !== "in_progress") {
        throw new Error("关联的日历安排已不在进行中，未撤销训练");
      }
    }

    const statements: SqlStatement[] = [{
      sql: `CREATE TEMP TABLE __fitness_cancel_empty_session_guard(
        value INTEGER NOT NULL CHECK(value=1)
      )`,
    }, {
      sql: `INSERT INTO temp.__fitness_cancel_empty_session_guard(value)
        SELECT CASE WHEN
          EXISTS(
            SELECT 1 FROM fitness_sessions
            WHERE id=? AND status='active'
          )
          AND NOT EXISTS(
            SELECT 1
            FROM fitness_sets recorded_set
            JOIN fitness_session_exercises exercise
              ON exercise.id=recorded_set.session_exercise_id
            WHERE exercise.session_id=?
              AND (
                recorded_set.completed=1
                OR recorded_set.reps IS NOT NULL
                OR recorded_set.duration_seconds IS NOT NULL
              )
          )
          AND NOT EXISTS(
            SELECT 1 FROM fitness_cardio_entries cardio
            WHERE cardio.session_id=? AND cardio.duration_seconds IS NOT NULL
          )
          AND (
            (SELECT event_id FROM fitness_sessions WHERE id=?) IS NULL
            OR EXISTS(
              SELECT 1
              FROM fitness_sessions active_session
              JOIN fitness_calendar_events event
                ON event.id=active_session.event_id
              WHERE active_session.id=?
                AND active_session.status='active'
                AND event.status='in_progress'
            )
          )
        THEN 1 ELSE 0 END`,
      params: [id, id, id, id, id],
    }];
    if (session.event_id) {
      statements.push({
        // This is an undo: preserve the immutable occurrence, appointment,
        // and every authored field exactly as they are now.
        sql: "UPDATE fitness_calendar_events SET status='planned' WHERE id=? AND status='in_progress'",
        params: [session.event_id],
      });
    }
    statements.push(
      // ON DELETE CASCADE removes the session's exercises, their empty sets,
      // and session cardio rows. The guards above prevent measured facts from
      // ever reaching this delete.
      { sql: "DELETE FROM fitness_sessions WHERE id=? AND status='active'", params: [id] },
      { sql: "DROP TABLE temp.__fitness_cancel_empty_session_guard" },
    );
    await rawBatch(statements);
  });
}

export async function addSessionExercise(
  sessionId: string,
  exerciseId: string,
  equipmentId: string | null,
  equipmentSnapshot?: string,
): Promise<string> {
  return write("session-exercise-added", async () => {
    const session = (await rawQuery<{ id: string; venue_id: string }>(
      "SELECT id,venue_id FROM fitness_sessions WHERE id=? AND status='active'",
      [sessionId],
    ))[0];
    if (!session) throw new Error("只能向进行中的训练添加动作");
    const exercise = getFitnessExercise(exerciseId);
    if (!exercise) throw new Error("动作不存在");
    await assertExerciseIsAllowed(exercise);
    const snapshot = await resolveSessionEquipmentSnapshot(
      exercise,
      session.venue_id,
      equipmentId,
      equipmentSnapshot,
    );

    const [position, unfinished] = await Promise.all([
      rawQuery<{ next_index: number }>(
        "SELECT COALESCE(MAX(order_index),-1)+1 next_index FROM fitness_session_exercises WHERE session_id=?",
        [sessionId],
      ),
      rawQuery<{ present: number }>(
        "SELECT 1 present FROM fitness_session_exercises WHERE session_id=? AND status IN ('active','pending') LIMIT 1",
        [sessionId],
      ),
    ]);
    const id = uid("session-exercise");
    const now = Date.now();
    await rawBatch([{
      sql: `INSERT INTO fitness_session_exercises(
        id,session_id,exercise_id,equipment_id,planned_item_id,order_index,status,
        substituted_for_exercise_id,substitution_reason,equipment_snapshot,note,
        created_at,updated_at
      ) VALUES(?,?,?,?,NULL,?,?,NULL,'',?,'',?,?)`,
      params: [
        id,
        sessionId,
        exerciseId,
        equipmentId,
        Number(position[0]?.next_index ?? 0),
        unfinished.length > 0 ? "pending" : "active",
        snapshot,
        now,
        now,
      ],
    }]);
    return id;
  });
}

export type RecordFitnessSetInput = {
  sessionExerciseId: string;
  setIndex: number;
  setKind?: FitnessSet["set_kind"];
  loadGrams?: number | null;
  reps?: number | null;
  durationSeconds?: number | null;
  rir?: number | null;
  rpe?: number | null;
  painNote?: string;
  clientMutationId: string;
};

export async function recordFitnessSet(input: RecordFitnessSetInput): Promise<string> {
  return write("set-recorded", async () => {
    requireInteger(input.setIndex, "组序号", 0, 10_000);
    const clientMutationId = requireNonEmpty(input.clientMutationId, "本次记录标识");
    const setKind = input.setKind ?? "work";
    const loadGrams = input.loadGrams ?? null;
    const reps = input.reps ?? null;
    const durationSeconds = input.durationSeconds ?? null;
    const rir = input.rir ?? null;
    const rpe = input.rpe ?? null;
    const painNote = input.painNote?.trim() ?? "";
    if (loadGrams !== null) requireInteger(loadGrams, "重量", 0, 10_000_000);
    if (reps !== null) requireInteger(reps, "次数", 0, 10_000);
    if (durationSeconds !== null) requireInteger(durationSeconds, "持续时间", 0, 86_400);
    if (rir !== null) requireInteger(rir, "RIR", 0, 5);
    if (rpe !== null) requireInteger(rpe, "RPE", 1, 10);
    if (reps === null && durationSeconds === null) throw new TypeError("每组至少记录次数或时长");

    const existing = (await rawQuery<{
      id: string;
      session_exercise_id: string;
      set_index: number;
      set_kind: FitnessSet["set_kind"];
      load_grams: number | null;
      reps: number | null;
      duration_seconds: number | null;
      rir: number | null;
      rpe: number | null;
      pain_note: string;
    }>("SELECT * FROM fitness_sets WHERE client_mutation_id=?", [clientMutationId]))[0];
    if (existing) {
      const identical = existing.session_exercise_id === input.sessionExerciseId &&
        existing.set_index === input.setIndex && existing.set_kind === setKind &&
        existing.load_grams === loadGrams && existing.reps === reps &&
        existing.duration_seconds === durationSeconds && existing.rir === rir &&
        existing.rpe === rpe && existing.pain_note === painNote;
      if (!identical) throw new Error("这次组记录标识已用于另一份数据，未覆盖原记录");
      return existing.id;
    }

    const exercise = (await rawQuery<{ id: string; session_id: string; status: string }>(
      "SELECT id,session_id,status FROM fitness_session_exercises WHERE id=?",
      [input.sessionExerciseId],
    ))[0];
    if (!exercise) throw new Error("当前动作不存在");
    if (exercise.status === "completed" || exercise.status === "skipped") {
      throw new Error("这个动作已经结束；请先恢复动作状态再补记");
    }
    const activeSession = (await rawQuery<{ id: string }>("SELECT id FROM fitness_sessions WHERE id=? AND status='active'", [exercise.session_id]))[0];
    if (!activeSession) throw new Error("这场训练已经结束");
    const occupiedIndex = (await rawQuery<{ id: string }>(
      "SELECT id FROM fitness_sets WHERE session_exercise_id=? AND set_index=?",
      [input.sessionExerciseId, input.setIndex],
    ))[0];
    if (occupiedIndex) throw new Error("这个组序号已经有记录，请编辑或撤销原记录");
    const now = Date.now();
    const id = uid("set");
    await rawBatch([{
      sql: `INSERT INTO fitness_sets(
        id,session_exercise_id,set_index,set_kind,load_grams,reps,duration_seconds,
        rir,rpe,completed,pain_note,completed_at,client_mutation_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
      params: [id, input.sessionExerciseId, input.setIndex, setKind, loadGrams, reps, durationSeconds, rir, rpe, painNote, now, clientMutationId, now, now],
    }, { sql: "UPDATE fitness_session_exercises SET status='active',updated_at=? WHERE id=?", params: [now, input.sessionExerciseId] }, { sql: "UPDATE fitness_sessions SET updated_at=? WHERE id=?", params: [now, exercise.session_id] }]);
    const stored = (await rawQuery<{ id: string }>("SELECT id FROM fitness_sets WHERE client_mutation_id=?", [input.clientMutationId]))[0];
    return stored?.id ?? id;
  });
}

export async function undoFitnessSet(setId: string) {
  return write("set-undone", async () => {
    const set = (await rawQuery<{ session_exercise_id: string; session_id: string }>(
      `SELECT s.session_exercise_id,se.session_id
       FROM fitness_sets s
       JOIN fitness_session_exercises se ON se.id=s.session_exercise_id
       JOIN fitness_sessions session ON session.id=se.session_id
       WHERE s.id=? AND session.status='active'`,
      [setId],
    ))[0];
    if (!set) throw new Error("只能撤销进行中训练的组记录");
    const now = Date.now();
    await rawBatch([
      { sql: "DELETE FROM fitness_sets WHERE id=?", params: [setId] },
      {
        sql: "UPDATE fitness_session_exercises SET status='active',updated_at=? WHERE id=?",
        params: [now, set.session_exercise_id],
      },
      { sql: "UPDATE fitness_sessions SET updated_at=? WHERE id=?", params: [now, set.session_id] },
    ]);
  });
}

export async function substituteSessionExercise(input: {
  sessionExerciseId: string;
  exerciseId: string;
  equipmentId: string | null;
  equipmentSnapshot?: string;
  reason: string;
}) {
  return write("exercise-substituted", async () => {
    const current = (await rawQuery<{
      exercise_id: string;
      venue_id: string;
      session_id: string;
      status: FitnessSessionExercise["status"];
    }>(
      `SELECT se.exercise_id,se.status,s.venue_id,s.id session_id
       FROM fitness_session_exercises se
       JOIN fitness_sessions s ON s.id=se.session_id
       WHERE se.id=? AND s.status='active'`,
      [input.sessionExerciseId],
    ))[0];
    const replacement = getFitnessExercise(input.exerciseId);
    if (!current || !replacement) throw new Error("替代动作不可用");
    if (current.status !== "active" && current.status !== "pending") {
      throw new Error("只能替换尚未结束的动作");
    }
    await assertExerciseIsAllowed(replacement);
    const priorSet = (await rawQuery<{ present: number }>(
      "SELECT 1 present FROM fitness_sets WHERE session_exercise_id=? LIMIT 1",
      [input.sessionExerciseId],
    ))[0];
    if (priorSet) throw new Error("已有组记录的动作不能改写；请新增一个替代动作以保留历史");
    const snapshot = await resolveSessionEquipmentSnapshot(
      replacement,
      current.venue_id,
      input.equipmentId,
      input.equipmentSnapshot,
    );
    await rawBatch([{ sql: "UPDATE fitness_session_exercises SET exercise_id=?,equipment_id=?,substituted_for_exercise_id=COALESCE(substituted_for_exercise_id,?),substitution_reason=?,equipment_snapshot=?,updated_at=? WHERE id=?", params: [input.exerciseId, input.equipmentId, current.exercise_id, input.reason.trim(), snapshot, Date.now(), input.sessionExerciseId] }]);
  });
}

export async function completeSessionExercise(id: string, skipped = false) {
  return write("session-exercise-updated", async () => {
    const row = (await rawQuery<{ session_id: string; order_index: number }>(
      `SELECT se.session_id,se.order_index
       FROM fitness_session_exercises se
       JOIN fitness_sessions s ON s.id=se.session_id
       WHERE se.id=? AND s.status='active'`,
      [id],
    ))[0];
    if (!row) throw new Error("只能更新进行中训练里的动作");
    const now = Date.now();
    await rawBatch([
      { sql: "UPDATE fitness_session_exercises SET status=?,updated_at=? WHERE id=?", params: [skipped ? "skipped" : "completed", now, id] },
      { sql: "UPDATE fitness_session_exercises SET status='active',updated_at=? WHERE session_id=? AND order_index=(SELECT MIN(order_index) FROM fitness_session_exercises WHERE session_id=? AND order_index>? AND status='pending')", params: [now, row.session_id, row.session_id, row.order_index] },
    ]);
  });
}

export async function finishFitnessSession(id: string, input: { endedEarly?: boolean; reflection?: string } = {}) {
  return write("session-finished", async () => {
    const session = (await rawQuery<{ event_id: string | null }>("SELECT event_id FROM fitness_sessions WHERE id=? AND status='active'", [id]))[0];
    if (!session) throw new Error("这场训练已经结束");
    const now = Date.now();
    const completedSets = await rawQuery<{
      id: string;
      exercise_id: string;
      equipment_id: string | null;
      load_grams: number | null;
      reps: number | null;
      rir: number | null;
      rpe: number | null;
      completed_at: number;
    }>(
      `SELECT s.id,se.exercise_id,se.equipment_id,s.load_grams,s.reps,s.rir,s.rpe,s.completed_at
       FROM fitness_sets s
       JOIN fitness_session_exercises se ON se.id=s.session_exercise_id
       WHERE se.session_id=? AND s.completed=1 AND s.set_kind='work'
         AND s.pain_note='' AND s.completed_at IS NOT NULL
         AND (s.reps IS NOT NULL OR s.load_grams IS NOT NULL)`,
      [id],
    );
    const statements: SqlStatement[] = [{
      sql: "UPDATE fitness_sessions SET status=?,ended_at=?,reflection=COALESCE(?,reflection),updated_at=? WHERE id=?",
      params: [input.endedEarly ? "ended_early" : "completed", now, input.reflection === undefined ? null : input.reflection.trim(), now, id],
    }, {
      sql: `UPDATE fitness_session_exercises
        SET status=CASE
          WHEN EXISTS(SELECT 1 FROM fitness_sets s WHERE s.session_exercise_id=fitness_session_exercises.id AND s.completed=1)
            THEN 'completed'
          ELSE 'skipped'
        END,
        updated_at=?
        WHERE session_id=? AND status IN ('pending','active','substituted')`,
      params: [now, id],
    }];
    if (session.event_id) statements.push({ sql: "UPDATE fitness_calendar_events SET status='completed',updated_at=? WHERE id=?", params: [now, session.event_id] });
    for (const set of completedSets) {
      statements.push({
        sql: `INSERT INTO fitness_capabilities(
          id,exercise_id,equipment_id,source_set_id,load_grams,reps,rir,rpe,
          confidence,recorded_at,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source_set_id) DO NOTHING`,
        params: [
          crypto.randomUUID(),
          set.exercise_id,
          set.equipment_id,
          set.id,
          set.load_grams,
          set.reps,
          set.rir,
          set.rpe,
          "observed",
          set.completed_at,
          now,
        ],
      });
    }
    await rawBatch(statements);
  });
}

export async function updateSessionReflection(id: string, reflection: string): Promise<void> {
  return write("session-reflection-updated", async () => {
    const present = (await rawQuery<{ id: string }>(
      "SELECT id FROM fitness_sessions WHERE id=?",
      [id],
    ))[0];
    if (!present) throw new Error("这场训练不存在");
    await rawBatch([{
      sql: "UPDATE fitness_sessions SET reflection=?,updated_at=? WHERE id=?",
      params: [reflection.trim(), Date.now(), id],
    }]);
  });
}

export async function saveFitnessSettings(settings: FitnessSettings) {
  return write("settings-saved", async () => {
    const now = Date.now();
    await rawBatch(Object.entries(settings).map(([key, value]) => ({
      sql: "INSERT INTO fitness_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      params: [key, String(value), now],
    })));
  });
}
