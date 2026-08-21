import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);
const NOW = 1_800_000_000_000;

function dataModule(source, sourceName) {
  const sourceUrl = `\n//# sourceURL=${sourceName.replaceAll(" ", "%20")}`;
  return `data:text/javascript;base64,${Buffer.from(`${source}${sourceUrl}`).toString("base64")}`;
}

async function transpile(relativePath) {
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
  assert.deepEqual(diagnostics.filter((entry) => entry.category === ts.DiagnosticCategory.Error), []);
  return outputText;
}

async function loadModules() {
  const catalogUrl = dataModule(await transpile("lib/fitness/catalog.ts"), "lib/fitness/catalog.ts");
  const inputOutput = (await transpile("lib/fitness/ai-input.ts"))
    .replaceAll('"./catalog"', JSON.stringify(catalogUrl));
  const contractOutput = await transpile("lib/fitness/ai-contract.ts");
  return {
    input: await import(dataModule(inputOutput, "lib/fitness/ai-input.ts")),
    contract: await import(dataModule(contractOutput, "lib/fitness/ai-contract.ts")),
  };
}

const { input, contract } = await loadModules();

function equipment(id, kind, overrides = {}) {
  return {
    id,
    venue_id: "venue-sensitive",
    name: `PRIVATE_EQUIPMENT_${id}`,
    kind,
    area: "PRIVATE_AREA",
    quantity: kind === "dumbbell" ? 2 : 1,
    status: "available",
    load_mode: kind === "dumbbell" ? "discrete" : "none",
    load_semantics: kind === "dumbbell" ? "per_hand" : "total",
    min_load_grams: null,
    max_load_grams: null,
    increment_grams: null,
    bar_weight_grams: null,
    unilateral: false,
    busy_level: "unknown",
    settings: {},
    attachments: [],
    notes: "PRIVATE_EQUIPMENT_NOTE",
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function snapshot() {
  return {
    profile: {
      id: "profile",
      goals: ["general_health"],
      experience: "new",
      resistance_days_per_week: 2,
      cardio_days_per_week: 1,
      session_minutes: 30,
      split: "full_body",
      preferred_weekdays: [1, 3, 5],
      preferred_rir: 3,
      rest_seconds: 90,
      unit: "kg",
      notes: "PRIVATE_PROFILE_NOTE",
      created_at: NOW,
      updated_at: NOW,
    },
    venues: [],
    equipment: [
      equipment("space", "open_space"),
      equipment("bench", "bench"),
      equipment("db", "dumbbell"),
    ],
    equipmentLoads: [{
      id: "load-db-10",
      equipment_id: "db",
      load_grams: 10_000,
      quantity: 2,
      label: "PRIVATE_LOAD_LABEL",
      available: true,
      created_at: NOW,
    }],
    constraints: [{
      id: "constraint-private",
      label: "PRIVATE_BODY_LABEL",
      body_area: "PRIVATE_BODY_AREA",
      severity: "avoid",
      movement_patterns: ["horizontal_push"],
      exercise_ids: [],
      note: "PRIVATE_BODY_NOTE",
      active: true,
      created_at: NOW,
      updated_at: NOW,
    }],
    programs: [],
    programDays: [],
    programItems: [],
    events: [],
    sessions: [],
    sessionExercises: [],
    sets: [],
    cardioEntries: [],
    capabilities: [
      { id: "blocked-history", exercise_id: "dumbbell-bench", equipment_id: "db", source_set_id: "set-a", load_grams: 10_000, reps: 8, rir: 2, rpe: null, confidence: "observed", recorded_at: NOW, created_at: NOW },
      { id: "allowed-history", exercise_id: "goblet-squat", equipment_id: "db", source_set_id: "set-b", load_grams: 10_000, reps: 10, rir: 3, rpe: null, confidence: "observed", recorded_at: NOW, created_at: NOW },
    ],
    files: [],
    settings: { unit: "kg", rest_timer_enabled: true, sound_enabled: false, ai_enabled: true },
  };
}

const venue = {
  id: "venue-sensitive",
  name: "PRIVATE_VENUE_NAME",
  venue_type: "commercial",
  location: "PRIVATE_LOCATION",
  area_notes: "PRIVATE_VENUE_AREA_NOTE",
  busy_notes: "PRIVATE_BUSY_NOTE",
  default_session_minutes: 30,
  supersets_allowed: false,
  is_default: true,
  status: "active",
  last_verified_at: NOW,
  created_at: NOW,
  updated_at: NOW,
};

test("plan AI input contains no user-authored free text and filters avoided history", () => {
  const result = input.buildPrivateFitnessPlanInput(snapshot(), venue);
  assert.doesNotThrow(() => contract.parsePlanDraftInput(result));
  assert.equal(result.venue.name, "当前场地");
  assert.deepEqual(result.constraints, []);
  assert.deepEqual(result.preferences, []);
  assert.equal(result.allowed_exercises.some((entry) => entry.exercise_id === "dumbbell-bench"), false);
  assert.deepEqual(result.known_capabilities.map((entry) => entry.exercise_id), ["goblet-squat"]);

  const serialized = JSON.stringify(result);
  for (const token of [
    "PRIVATE_VENUE_NAME",
    "PRIVATE_LOCATION",
    "PRIVATE_AREA",
    "PRIVATE_EQUIPMENT_",
    "PRIVATE_EQUIPMENT_NOTE",
    "PRIVATE_LOAD_LABEL",
    "PRIVATE_PROFILE_NOTE",
    "PRIVATE_BODY_LABEL",
    "PRIVATE_BODY_AREA",
    "PRIVATE_BODY_NOTE",
    "PRIVATE_BUSY_NOTE",
    "PRIVATE_VENUE_AREA_NOTE",
  ]) {
    assert.equal(serialized.includes(token), false, `${token} must stay local`);
  }
});
