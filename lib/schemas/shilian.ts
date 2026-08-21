import type { LocalDatabaseSchema } from "./types";

/** SQLite application_id for the ASCII marker "SHLN" (适练 / shilian). */
export const SHILIAN_APPLICATION_ID = 0x53484c4e;
export const SHILIAN_USER_VERSION = 2;
export const SHILIAN_V1_MIGRATION_NAME = "initial-truthful-fitness-runtime";
export const SHILIAN_V2_MIGRATION_NAME = "calendar-occurrence-identity";
/** @deprecated Prefer the versioned migration-name exports. */
export const SHILIAN_MIGRATION_NAME = SHILIAN_V1_MIGRATION_NAME;

export const SHILIAN_TABLE_COLUMNS = {
  fitness_schema_migrations: ["version", "name", "applied_at"],
  fitness_profiles: ["id", "goals_json", "experience", "resistance_days_per_week", "cardio_days_per_week", "session_minutes", "split", "preferred_weekdays_json", "preferred_rir", "rest_seconds", "unit", "notes", "created_at", "updated_at"],
  fitness_venues: ["id", "name", "venue_type", "location", "area_notes", "busy_notes", "default_session_minutes", "supersets_allowed", "is_default", "status", "last_verified_at", "created_at", "updated_at"],
  fitness_equipment: ["id", "venue_id", "name", "kind", "area", "quantity", "status", "load_mode", "load_semantics", "min_load_grams", "max_load_grams", "increment_grams", "bar_weight_grams", "unilateral", "busy_level", "settings_json", "attachments_json", "notes", "created_at", "updated_at"],
  fitness_equipment_loads: ["id", "equipment_id", "load_grams", "quantity", "label", "available", "created_at"],
  fitness_constraints: ["id", "label", "body_area", "severity", "movement_patterns_json", "exercise_ids_json", "note", "active", "created_at", "updated_at"],
  fitness_programs: ["id", "name", "venue_id", "goal", "split", "status", "version", "source", "assumptions_json", "created_at", "updated_at"],
  fitness_program_days: ["id", "program_id", "day_index", "weekday", "kind", "name", "focus", "estimated_minutes", "variant", "created_at"],
  fitness_program_items: ["id", "program_day_id", "exercise_id", "equipment_id", "resource_equipment_ids_json", "order_index", "sets", "rep_min", "rep_max", "duration_seconds", "target_rir", "rest_seconds", "load_grams", "load_guidance", "rationale", "substitution_exercise_ids_json", "equipment_snapshot", "created_at"],
  fitness_calendar_events: ["id", "program_day_id", "venue_id", "title", "kind", "starts_at", "occurrence_key", "planned_minutes", "status", "rescheduled_from_id", "note", "created_at", "updated_at"],
  fitness_sessions: ["id", "event_id", "venue_id", "program_day_id", "started_at", "ended_at", "status", "available_minutes", "energy_note", "soreness_note", "reflection", "created_at", "updated_at"],
  fitness_session_exercises: ["id", "session_id", "exercise_id", "equipment_id", "planned_item_id", "order_index", "status", "substituted_for_exercise_id", "substitution_reason", "equipment_snapshot", "note", "created_at", "updated_at"],
  fitness_sets: ["id", "session_exercise_id", "set_index", "set_kind", "load_grams", "reps", "duration_seconds", "rir", "rpe", "completed", "pain_note", "completed_at", "client_mutation_id", "created_at", "updated_at"],
  fitness_cardio_entries: ["id", "session_id", "equipment_id", "mode", "duration_seconds", "distance_meters", "resistance", "average_heart_rate", "effort", "note", "created_at"],
  fitness_capabilities: ["id", "exercise_id", "equipment_id", "source_set_id", "load_grams", "reps", "rir", "rpe", "confidence", "recorded_at", "created_at"],
  fitness_files: ["id", "entity_type", "entity_id", "purpose", "file_key", "file_name", "mime_type", "byte_size", "sha256", "status", "created_at", "updated_at"],
  fitness_settings: ["key", "value", "updated_at"],
} as const;

export const SHILIAN_TABLES = Object.keys(SHILIAN_TABLE_COLUMNS) as ReadonlyArray<keyof typeof SHILIAN_TABLE_COLUMNS>;

export const SHILIAN_V1_TABLE_COLUMNS = {
  ...SHILIAN_TABLE_COLUMNS,
  fitness_calendar_events: ["id", "program_day_id", "venue_id", "title", "kind", "starts_at", "planned_minutes", "status", "rescheduled_from_id", "note", "created_at", "updated_at"],
} as const;

export const SHILIAN_INDEXES = [
  "fitness_equipment_venue_idx",
  "fitness_loads_equipment_idx",
  "fitness_events_date_idx",
  "fitness_events_occurrence_idx",
  "fitness_sessions_date_idx",
  "fitness_session_exercises_idx",
  "fitness_sets_exercise_idx",
  "fitness_capabilities_idx",
  "fitness_files_entity_idx",
] as const;

export const SHILIAN_V1_INDEXES = SHILIAN_INDEXES.filter(
  (name) => name !== "fitness_events_occurrence_idx",
);

/** Pure SQL shared by the runtime installer and the reference contract. */
export const SHILIAN_SCHEMA_STATEMENTS: readonly Readonly<{ sql: string }>[] = [
  { sql: `CREATE TABLE fitness_schema_migrations(
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL CHECK(applied_at>=0)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_profiles(
      id TEXT PRIMARY KEY CHECK(id='profile'),
      goals_json TEXT NOT NULL CHECK(json_valid(goals_json)),
      experience TEXT NOT NULL CHECK(experience IN ('new','returning','consistent','advanced')),
      resistance_days_per_week INTEGER NOT NULL CHECK(resistance_days_per_week BETWEEN 0 AND 7),
      cardio_days_per_week INTEGER NOT NULL CHECK(cardio_days_per_week BETWEEN 0 AND 7),
      session_minutes INTEGER NOT NULL CHECK(session_minutes BETWEEN 10 AND 240),
      split TEXT NOT NULL CHECK(split IN ('auto','full_body','upper_lower','push_pull_legs','custom')),
      preferred_weekdays_json TEXT NOT NULL CHECK(json_valid(preferred_weekdays_json)),
      preferred_rir INTEGER NOT NULL CHECK(preferred_rir BETWEEN 0 AND 5),
      rest_seconds INTEGER NOT NULL CHECK(rest_seconds BETWEEN 15 AND 600),
      unit TEXT NOT NULL CHECK(unit IN ('kg','lb')),
      notes TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_venues(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
      venue_type TEXT NOT NULL CHECK(venue_type IN ('commercial','home','office','hotel','outdoor','other')),
      location TEXT NOT NULL,
      area_notes TEXT NOT NULL,
      busy_notes TEXT NOT NULL,
      default_session_minutes INTEGER NOT NULL CHECK(default_session_minutes BETWEEN 10 AND 240),
      supersets_allowed INTEGER NOT NULL CHECK(supersets_allowed IN (0,1)),
      is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),
      status TEXT NOT NULL CHECK(status IN ('active','archived')),
      last_verified_at INTEGER CHECK(last_verified_at IS NULL OR last_verified_at>=0),
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_equipment(
      id TEXT PRIMARY KEY,
      venue_id TEXT NOT NULL REFERENCES fitness_venues(id),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
      kind TEXT NOT NULL CHECK(kind IN ('barbell','plates','rack','bench','dumbbell','kettlebell','cable','fixed_machine','smith_machine','pullup_bar','dip_station','bands','mat','treadmill','bike','rower','elliptical','stair_climber','open_space','other')),
      area TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000),
      status TEXT NOT NULL CHECK(status IN ('available','limited','maintenance','removed')),
      load_mode TEXT NOT NULL CHECK(load_mode IN ('none','discrete','range','plate_loaded')),
      load_semantics TEXT NOT NULL CHECK(load_semantics IN ('total','per_hand','per_side','stack_label','resistance_level')),
      min_load_grams INTEGER CHECK(min_load_grams IS NULL OR min_load_grams>=0),
      max_load_grams INTEGER CHECK(max_load_grams IS NULL OR max_load_grams>=0),
      increment_grams INTEGER CHECK(increment_grams IS NULL OR increment_grams>0),
      bar_weight_grams INTEGER CHECK(bar_weight_grams IS NULL OR bar_weight_grams>=0),
      unilateral INTEGER NOT NULL CHECK(unilateral IN (0,1)),
      busy_level TEXT NOT NULL CHECK(busy_level IN ('unknown','low','medium','high')),
      settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
      attachments_json TEXT NOT NULL CHECK(json_valid(attachments_json)),
      notes TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
      CHECK(max_load_grams IS NULL OR min_load_grams IS NULL OR max_load_grams>=min_load_grams)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_equipment_loads(
      id TEXT PRIMARY KEY,
      equipment_id TEXT NOT NULL REFERENCES fitness_equipment(id) ON DELETE CASCADE,
      load_grams INTEGER NOT NULL CHECK(load_grams>=0),
      quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000),
      label TEXT NOT NULL,
      available INTEGER NOT NULL CHECK(available IN (0,1)),
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      UNIQUE(equipment_id,load_grams,label)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_constraints(
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
      body_area TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('monitor','modify','avoid')),
      movement_patterns_json TEXT NOT NULL CHECK(json_valid(movement_patterns_json)),
      exercise_ids_json TEXT NOT NULL CHECK(json_valid(exercise_ids_json)),
      note TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0,1)),
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_programs(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
      venue_id TEXT NOT NULL REFERENCES fitness_venues(id),
      goal TEXT NOT NULL CHECK(goal IN ('strength','muscle','cardio','general_health','sport','mobility')),
      split TEXT NOT NULL CHECK(split IN ('auto','full_body','upper_lower','push_pull_legs','custom')),
      status TEXT NOT NULL CHECK(status IN ('draft','active','archived')),
      version INTEGER NOT NULL CHECK(version>=1),
      source TEXT NOT NULL CHECK(source IN ('local','ai_draft','manual')),
      assumptions_json TEXT NOT NULL CHECK(json_valid(assumptions_json)),
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_program_days(
      id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL REFERENCES fitness_programs(id) ON DELETE CASCADE,
      day_index INTEGER NOT NULL CHECK(day_index>=0),
      weekday INTEGER CHECK(weekday IS NULL OR weekday BETWEEN 0 AND 6),
      kind TEXT NOT NULL CHECK(kind IN ('resistance','cardio','rest')),
      name TEXT NOT NULL,
      focus TEXT NOT NULL,
      estimated_minutes INTEGER NOT NULL CHECK(estimated_minutes BETWEEN 0 AND 240),
      variant TEXT NOT NULL CHECK(variant IN ('standard','short','low_fatigue','busy_gym')),
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      UNIQUE(program_id,day_index)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_program_items(
      id TEXT PRIMARY KEY,
      program_day_id TEXT NOT NULL REFERENCES fitness_program_days(id) ON DELETE CASCADE,
      exercise_id TEXT NOT NULL,
      equipment_id TEXT REFERENCES fitness_equipment(id),
      resource_equipment_ids_json TEXT NOT NULL CHECK(json_valid(resource_equipment_ids_json)),
      order_index INTEGER NOT NULL CHECK(order_index>=0),
      sets INTEGER NOT NULL CHECK(sets BETWEEN 1 AND 20),
      rep_min INTEGER CHECK(rep_min IS NULL OR rep_min BETWEEN 1 AND 1000),
      rep_max INTEGER CHECK(rep_max IS NULL OR rep_max BETWEEN 1 AND 1000),
      duration_seconds INTEGER CHECK(duration_seconds IS NULL OR duration_seconds BETWEEN 1 AND 86400),
      target_rir INTEGER CHECK(target_rir IS NULL OR target_rir BETWEEN 0 AND 5),
      rest_seconds INTEGER NOT NULL CHECK(rest_seconds BETWEEN 0 AND 1200),
      load_grams INTEGER CHECK(load_grams IS NULL OR load_grams>=0),
      load_guidance TEXT NOT NULL,
      rationale TEXT NOT NULL,
      substitution_exercise_ids_json TEXT NOT NULL CHECK(json_valid(substitution_exercise_ids_json)),
      equipment_snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      UNIQUE(program_day_id,order_index),
      CHECK(rep_max IS NULL OR rep_min IS NULL OR rep_max>=rep_min),
      CHECK(rep_min IS NOT NULL OR duration_seconds IS NOT NULL)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_calendar_events(
      id TEXT PRIMARY KEY,
      program_day_id TEXT REFERENCES fitness_program_days(id),
      venue_id TEXT REFERENCES fitness_venues(id),
      title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('resistance','cardio','rest','note')),
      starts_at INTEGER NOT NULL CHECK(starts_at>=0),
      occurrence_key TEXT,
      planned_minutes INTEGER NOT NULL CHECK(planned_minutes BETWEEN 0 AND 1440),
      status TEXT NOT NULL CHECK(status IN ('planned','in_progress','completed','not_performed','cancelled')),
      rescheduled_from_id TEXT REFERENCES fitness_calendar_events(id),
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
      CHECK(program_day_id IS NULL OR occurrence_key IS NOT NULL)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_sessions(
      id TEXT PRIMARY KEY,
      event_id TEXT UNIQUE REFERENCES fitness_calendar_events(id),
      venue_id TEXT NOT NULL REFERENCES fitness_venues(id),
      program_day_id TEXT REFERENCES fitness_program_days(id),
      started_at INTEGER NOT NULL CHECK(started_at>=0),
      ended_at INTEGER CHECK(ended_at IS NULL OR ended_at>=started_at),
      status TEXT NOT NULL CHECK(status IN ('active','completed','ended_early')),
      available_minutes INTEGER CHECK(available_minutes IS NULL OR available_minutes BETWEEN 1 AND 1440),
      energy_note TEXT NOT NULL CHECK(energy_note IN ('','lower','usual','higher')),
      soreness_note TEXT NOT NULL,
      reflection TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_session_exercises(
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES fitness_sessions(id) ON DELETE CASCADE,
      exercise_id TEXT NOT NULL,
      equipment_id TEXT REFERENCES fitness_equipment(id),
      planned_item_id TEXT REFERENCES fitness_program_items(id),
      order_index INTEGER NOT NULL CHECK(order_index>=0),
      status TEXT NOT NULL CHECK(status IN ('pending','active','completed','skipped','substituted')),
      substituted_for_exercise_id TEXT,
      substitution_reason TEXT NOT NULL,
      equipment_snapshot TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
      UNIQUE(session_id,order_index)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_sets(
      id TEXT PRIMARY KEY,
      session_exercise_id TEXT NOT NULL REFERENCES fitness_session_exercises(id) ON DELETE CASCADE,
      set_index INTEGER NOT NULL CHECK(set_index>=0),
      set_kind TEXT NOT NULL CHECK(set_kind IN ('warmup','work','drop','amrap')),
      load_grams INTEGER CHECK(load_grams IS NULL OR load_grams>=0),
      reps INTEGER CHECK(reps IS NULL OR reps BETWEEN 0 AND 10000),
      duration_seconds INTEGER CHECK(duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 86400),
      rir INTEGER CHECK(rir IS NULL OR rir BETWEEN 0 AND 5),
      rpe INTEGER CHECK(rpe IS NULL OR rpe BETWEEN 1 AND 10),
      completed INTEGER NOT NULL CHECK(completed IN (0,1)),
      pain_note TEXT NOT NULL,
      completed_at INTEGER,
      client_mutation_id TEXT NOT NULL UNIQUE CHECK(length(client_mutation_id) BETWEEN 1 AND 160),
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
      UNIQUE(session_exercise_id,set_index),
      CHECK(reps IS NOT NULL OR duration_seconds IS NOT NULL)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_cardio_entries(
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES fitness_sessions(id) ON DELETE CASCADE,
      equipment_id TEXT REFERENCES fitness_equipment(id),
      mode TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 1 AND 86400),
      distance_meters INTEGER CHECK(distance_meters IS NULL OR distance_meters>=0),
      resistance TEXT NOT NULL,
      average_heart_rate INTEGER CHECK(average_heart_rate IS NULL OR average_heart_rate BETWEEN 20 AND 260),
      effort TEXT NOT NULL CHECK(effort IN ('','easy','moderate','hard')),
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK(created_at>=0)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_capabilities(
      id TEXT PRIMARY KEY,
      exercise_id TEXT NOT NULL,
      equipment_id TEXT REFERENCES fitness_equipment(id),
      source_set_id TEXT UNIQUE REFERENCES fitness_sets(id) ON DELETE RESTRICT,
      load_grams INTEGER CHECK(load_grams IS NULL OR load_grams>=0),
      reps INTEGER CHECK(reps IS NULL OR reps>=0),
      rir INTEGER CHECK(rir IS NULL OR rir BETWEEN 0 AND 5),
      rpe INTEGER CHECK(rpe IS NULL OR rpe BETWEEN 1 AND 10),
      confidence TEXT NOT NULL CHECK(confidence IN ('observed','user_entered')),
      recorded_at INTEGER NOT NULL CHECK(recorded_at>=0),
      created_at INTEGER NOT NULL CHECK(created_at>=0)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_files(
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('venue','equipment','exercise','session')),
      entity_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('photo','instruction','other')),
      file_key TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK(byte_size>=0),
      sha256 TEXT NOT NULL CHECK(length(sha256)=64),
      status TEXT NOT NULL CHECK(status IN ('ready','missing','deleting')),
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
    ) STRICT` },
  { sql: `CREATE TABLE fitness_settings(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL CHECK(updated_at>=0)
    ) STRICT` },
  { sql: "CREATE INDEX fitness_equipment_venue_idx ON fitness_equipment(venue_id,status,kind)" },
  { sql: "CREATE INDEX fitness_loads_equipment_idx ON fitness_equipment_loads(equipment_id,available,load_grams)" },
  { sql: "CREATE INDEX fitness_events_date_idx ON fitness_calendar_events(starts_at,status)" },
  { sql: "CREATE UNIQUE INDEX fitness_events_occurrence_idx ON fitness_calendar_events(program_day_id,occurrence_key) WHERE program_day_id IS NOT NULL AND occurrence_key IS NOT NULL" },
  { sql: "CREATE INDEX fitness_sessions_date_idx ON fitness_sessions(started_at DESC,status)" },
  { sql: "CREATE INDEX fitness_session_exercises_idx ON fitness_session_exercises(session_id,order_index)" },
  { sql: "CREATE INDEX fitness_sets_exercise_idx ON fitness_sets(session_exercise_id,set_index)" },
  { sql: "CREATE INDEX fitness_capabilities_idx ON fitness_capabilities(exercise_id,equipment_id,recorded_at DESC)" },
  { sql: "CREATE INDEX fitness_files_entity_idx ON fitness_files(entity_type,entity_id,status)" },
];

const SHILIAN_V1_CALENDAR_EVENTS_SQL = `CREATE TABLE fitness_calendar_events(
      id TEXT PRIMARY KEY,
      program_day_id TEXT REFERENCES fitness_program_days(id),
      venue_id TEXT REFERENCES fitness_venues(id),
      title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('resistance','cardio','rest','note')),
      starts_at INTEGER NOT NULL CHECK(starts_at>=0),
      planned_minutes INTEGER NOT NULL CHECK(planned_minutes BETWEEN 0 AND 1440),
      status TEXT NOT NULL CHECK(status IN ('planned','in_progress','completed','not_performed','cancelled')),
      rescheduled_from_id TEXT REFERENCES fitness_calendar_events(id),
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
    ) STRICT`;

export const SHILIAN_V1_SCHEMA_STATEMENTS: readonly Readonly<{ sql: string }>[] =
  SHILIAN_SCHEMA_STATEMENTS.flatMap(({ sql }) => {
    if (sql.includes("CREATE TABLE fitness_calendar_events(")) {
      return [{ sql: SHILIAN_V1_CALENDAR_EVENTS_SQL }];
    }
    if (sql.includes("CREATE UNIQUE INDEX fitness_events_occurrence_idx")) {
      return [];
    }
    return [{ sql }];
  });

function objectSql(statements: readonly Readonly<{ sql: string }>[]) {
  return Object.fromEntries(statements.map(({ sql }) => {
    const match = /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(
      sql.trim(),
    );
    if (!match) throw new Error("适练参考结构包含无法识别的 SQL");
    return [match[1], sql] as const;
  }));
}

export const SHILIAN_OBJECT_SQL: Readonly<Record<string, string>> = objectSql(
  SHILIAN_SCHEMA_STATEMENTS,
);

export const SHILIAN_V1_OBJECT_SQL: Readonly<Record<string, string>> = objectSql(
  SHILIAN_V1_SCHEMA_STATEMENTS,
);

export const SHILIAN_OCCURRENCE_KEY_SQL =
  "strftime('%Y-%m-%d',starts_at / 1000,'unixepoch','localtime')";

export const SHILIAN_V2_SCHEMA_MIGRATION_STATEMENTS: readonly Readonly<{ sql: string }>[] = [
  {
    sql: `CREATE TEMP TABLE __fitness_occurrence_migration_guard(
      value INTEGER NOT NULL CHECK(value=1)
    )`,
  },
  {
    sql: `INSERT INTO temp.__fitness_occurrence_migration_guard(value)
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM fitness_calendar_events
        WHERE program_day_id IS NOT NULL
        GROUP BY program_day_id,${SHILIAN_OCCURRENCE_KEY_SQL}
        HAVING COUNT(*)>1
      ) THEN 1 ELSE 0 END`,
  },
  { sql: "DROP TABLE temp.__fitness_occurrence_migration_guard" },
  { sql: "PRAGMA defer_foreign_keys=ON" },
  {
    sql: `CREATE TEMP TABLE __fitness_calendar_events_v2_stage AS
      SELECT id,program_day_id,venue_id,title,kind,starts_at,
        CASE WHEN program_day_id IS NULL THEN NULL
          ELSE ${SHILIAN_OCCURRENCE_KEY_SQL} END occurrence_key,
        planned_minutes,status,rescheduled_from_id,note,created_at,updated_at
      FROM fitness_calendar_events`,
  },
  { sql: "DROP TABLE fitness_calendar_events" },
  { sql: SHILIAN_OBJECT_SQL.fitness_calendar_events },
  {
    sql: `INSERT INTO fitness_calendar_events(
        id,program_day_id,venue_id,title,kind,starts_at,occurrence_key,
        planned_minutes,status,rescheduled_from_id,note,created_at,updated_at
      ) SELECT id,program_day_id,venue_id,title,kind,starts_at,occurrence_key,
        planned_minutes,status,rescheduled_from_id,note,created_at,updated_at
      FROM temp.__fitness_calendar_events_v2_stage`,
  },
  { sql: "DROP TABLE temp.__fitness_calendar_events_v2_stage" },
  { sql: SHILIAN_OBJECT_SQL.fitness_events_date_idx },
  { sql: SHILIAN_OBJECT_SQL.fitness_events_occurrence_idx },
];

const referenceMigrationV1Sql = [
  `PRAGMA application_id=${SHILIAN_APPLICATION_ID}`,
  ...SHILIAN_V1_SCHEMA_STATEMENTS.map(({ sql }) => sql),
  `INSERT INTO fitness_schema_migrations(version,name,applied_at) VALUES(1,'${SHILIAN_V1_MIGRATION_NAME}',0)`,
].join(";\n");

const referenceMigrationV2Sql = [
  ...SHILIAN_V2_SCHEMA_MIGRATION_STATEMENTS.map(({ sql }) => sql),
  `INSERT INTO fitness_schema_migrations(version,name,applied_at) VALUES(2,'${SHILIAN_V2_MIGRATION_NAME}',0)`,
].join(";\n");

export const shilianSchema: LocalDatabaseSchema = {
  name: "shilian",
  filename: "shilian.sqlite3",
  applicationId: SHILIAN_APPLICATION_ID,
  seedVersion: 0,
  migrations: [{
    version: 1,
    description: "Create the truthful equipment-constrained fitness runtime",
    sql: referenceMigrationV1Sql,
  }, {
    version: SHILIAN_USER_VERSION,
    description: "Give every scheduled program occurrence an immutable identity",
    sql: referenceMigrationV2Sql,
  }],
  seedSql: "",
};
