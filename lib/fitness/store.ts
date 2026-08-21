import { localDb } from "@/lib/local-db/client";
import type { SqlParams, SqlStatement } from "@/lib/local-db/types";
import {
  SHILIAN_APPLICATION_ID,
  SHILIAN_INDEXES,
  SHILIAN_MIGRATION_NAME,
  SHILIAN_OBJECT_SQL,
  SHILIAN_SCHEMA_STATEMENTS,
  SHILIAN_TABLE_COLUMNS,
  SHILIAN_TABLES,
  SHILIAN_USER_VERSION,
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

async function assertRuntimeIdentity() {
  const identity = (await rawQuery<{ application_id: number; user_version: number }>(
    "SELECT (SELECT application_id FROM pragma_application_id) application_id, (SELECT user_version FROM pragma_user_version) user_version",
  ))[0];
  if (!identity) throw new Error("无法读取适练数据库身份");
  if (identity.application_id !== FITNESS_APPLICATION_ID || identity.user_version !== FITNESS_USER_VERSION) {
    throw new Error("适练数据库身份或版本不受支持；当前数据没有被改动");
  }
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
    !sameStrings(actualIndexes, [...SHILIAN_INDEXES].sort()) ||
    unsafeObjects.length > 0
  ) {
    throw new Error("适练数据库结构与当前版本不一致；已停止打开以保护数据");
  }
  for (const object of objects) {
    const expected = SHILIAN_OBJECT_SQL[object.name];
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
    if (!sameStrings(columns.map(({ name }) => name), SHILIAN_TABLE_COLUMNS[table])) {
      throw new Error(`适练数据库表 ${table} 的列结构不完整；已停止打开以保护数据`);
    }
  }
  const ledger = await rawQuery<{ version: number; name: string }>(
    "SELECT version,name FROM fitness_schema_migrations ORDER BY version",
  );
  if (
    ledger.length !== 1 ||
    Number(ledger[0]?.version) !== FITNESS_USER_VERSION ||
    ledger[0]?.name !== SHILIAN_MIGRATION_NAME
  ) {
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
          params: [FITNESS_USER_VERSION, SHILIAN_MIGRATION_NAME, now],
        },
        { sql: `PRAGMA application_id=${FITNESS_APPLICATION_ID}` },
        { sql: `PRAGMA user_version=${FITNESS_USER_VERSION}` },
      ]);
    }
    await assertRuntimeIdentity();
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
    broadcastFitnessChange(reason);
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
    const windowStartDate = new Date(from);
    windowStartDate.setHours(0, 0, 0, 0);
    const windowEndDate = new Date(windowStartDate);
    windowEndDate.setDate(windowEndDate.getDate() + 7);
    const windowStart = windowStartDate.getTime();
    const windowEnd = windowEndDate.getTime();
    const now = Date.now();
    const ids: string[] = [];
    const statements: SqlStatement[] = [];
    for (const day of days) {
      if (day.weekday === null || day.kind === "rest") continue;
      const startsAt = nextDateForWeekday(from, day.weekday);
      const duplicate = (await rawQuery<{ id: string }>(
        `SELECT e.id
          FROM fitness_calendar_events e
          JOIN fitness_program_days d ON d.id=e.program_day_id
          WHERE d.program_id=? AND e.program_day_id=?
            AND e.status IN ('planned','in_progress')
            AND e.starts_at>=? AND e.starts_at<?
          ORDER BY CASE e.status WHEN 'in_progress' THEN 0 ELSE 1 END,e.updated_at DESC
          LIMIT 1`,
        [programId, day.id, windowStart, windowEnd],
      ))[0];
      if (duplicate) {
        ids.push(duplicate.id);
        continue;
      }
      const id = uid("event");
      ids.push(id);
      statements.push({
        sql: "INSERT INTO fitness_calendar_events(id,program_day_id,venue_id,title,kind,starts_at,planned_minutes,status,rescheduled_from_id,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        params: [id, day.id, program.venue_id, day.name, day.kind, startsAt, day.estimated_minutes, "planned", null, "", now, now],
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
