import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

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
  assert.deepEqual(
    diagnostics.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  return outputText;
}

async function loadPlanner() {
  const catalogOutput = await transpile("lib/fitness/catalog.ts");
  const catalogUrl = dataModule(catalogOutput, "lib/fitness/catalog.ts");
  const plannerOutput = (await transpile("lib/fitness/planner.ts"))
    .replaceAll('"./catalog"', JSON.stringify(catalogUrl));
  return import(dataModule(plannerOutput, "lib/fitness/planner.ts"));
}

const planner = await loadPlanner();
const NOW = 1_800_000_000_000;

function venue(id = "venue-a", overrides = {}) {
  return {
    id,
    name: id === "venue-a" ? "街角健身房" : "出差酒店",
    venue_type: "commercial",
    location: "",
    area_notes: "",
    busy_notes: "",
    default_session_minutes: 30,
    supersets_allowed: false,
    is_default: id === "venue-a",
    status: "active",
    last_verified_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    id: "profile",
    goals: ["general_health"],
    experience: "new",
    resistance_days_per_week: 2,
    cardio_days_per_week: 1,
    session_minutes: 30,
    split: "full_body",
    preferred_weekdays: [1, 3, 5],
    preferred_rir: 2,
    rest_seconds: 90,
    unit: "kg",
    notes: "",
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function equipment(id, kind, venueId = "venue-a", overrides = {}) {
  return {
    id,
    venue_id: venueId,
    name: id,
    kind,
    area: "",
    quantity: 1,
    status: "available",
    load_mode: "none",
    load_semantics: "total",
    min_load_grams: null,
    max_load_grams: null,
    increment_grams: null,
    bar_weight_grams: null,
    unilateral: false,
    busy_level: "unknown",
    settings: {},
    attachments: [],
    notes: "",
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function load(id, equipmentId, kilograms, quantity = 1, overrides = {}) {
  return {
    id,
    equipment_id: equipmentId,
    load_grams: kilograms * 1000,
    quantity,
    label: `${kilograms} kg`,
    available: true,
    created_at: NOW,
    ...overrides,
  };
}

function standardEquipment() {
  return [
    equipment("space-a", "open_space"),
    equipment("mat-a", "mat"),
    equipment("bench-a", "bench"),
    equipment("rack-a", "rack"),
    equipment("db-a", "dumbbell", "venue-a", {
      load_mode: "discrete",
      load_semantics: "per_hand",
      min_load_grams: 5000,
      max_load_grams: 10000,
    }),
    equipment("bar-a", "barbell", "venue-a", {
      load_mode: "plate_loaded",
      bar_weight_grams: 20000,
    }),
    equipment("plates-a", "plates", "venue-a", {
      load_mode: "discrete",
      load_semantics: "per_side",
    }),
    equipment("cable-a", "cable", "venue-a", {
      load_mode: "discrete",
      load_semantics: "stack_label",
    }),
    equipment("treadmill-a", "treadmill", "venue-a", {
      load_mode: "range",
      load_semantics: "resistance_level",
    }),
  ];
}

function standardLoads() {
  return [
    load("db-5", "db-a", 5, 2),
    load("db-7-5", "db-a", 7.5, 2),
    load("db-10", "db-a", 10, 2),
    load("db-12-single", "db-a", 12, 1),
    load("plate-5", "plates-a", 5, 4),
    load("plate-10", "plates-a", 10, 2),
    load("cable-10", "cable-a", 10),
    load("cable-15", "cable-a", 15),
  ];
}

function context(overrides = {}) {
  return {
    profile: profile(),
    venue: venue(),
    equipment: standardEquipment(),
    equipmentLoads: standardLoads(),
    constraints: [],
    loadHistory: [],
    ...overrides,
  };
}

test("discrete loads never invent 8 kg and respect bilateral dumbbell quantity", () => {
  const db = standardEquipment().find((entry) => entry.id === "db-a");
  const options = planner.availableLoadsForEquipment(db, standardLoads());
  assert.deepEqual(options, [5000, 7500, 10000]);
  assert.equal(planner.nearestAvailableLoad(8000, options), 7500);
  assert.equal(
    planner.nearestAvailableLoad(8000, options, "at_or_above"),
    10000,
  );
  assert.equal(options.includes(8000), false);
  assert.equal(options.includes(12000), false, "one dumbbell is not a bilateral pair");
});

test("barbell totals use symmetric pairs without exceeding plate inventory", () => {
  const totals = planner.computeBarbellLoads(20000, [
    load("five", "plates", 5, 4),
    load("ten", "plates", 10, 2),
    load("unpaired-twenty", "plates", 20, 1),
  ]);
  assert.deepEqual(totals, [20000, 30000, 40000, 50000, 60000]);
  assert.equal(totals.includes(80000), false);
});

test("no comparable history means null load plus RIR guidance", () => {
  const draft = planner.buildFitnessPlanDraft(context());
  const resistanceItems = draft.days
    .filter((day) => day.kind === "resistance")
    .flatMap((day) => day.items);

  assert.ok(resistanceItems.length > 0);
  assert.ok(resistanceItems.every((item) => item.load_grams === null));
  assert.ok(resistanceItems.every((item) => item.target_rir === 2));
  assert.match(draft.assumptions.join(" "), /重量保持为空/);
  assert.equal(planner.validateFitnessPlanDraft(draft, context()).valid, true);
});

test("a comparable 8 kg history maps down to the real 7.5 kg option", () => {
  const input = context({
    loadHistory: [{
      exercise_id: "dumbbell-rdl",
      equipment_id: "db-a",
      load_grams: 8000,
      completed_at: NOW - 1000,
      completed: true,
      pain: false,
    }],
  });
  const draft = planner.buildFitnessPlanDraft(input);
  const hinge = draft.days
    .flatMap((day) => day.items)
    .find((item) => item.exercise_id === "dumbbell-rdl");
  assert.equal(hinge?.load_grams, 7500);
  assert.equal(planner.validateFitnessPlanDraft(draft, input).valid, true);
});

test("avoid constraints filter both primary and substitute exercises", () => {
  const input = context({
    constraints: [
      {
        id: "avoid-push",
        label: "暂时避开推类动作",
        body_area: "shoulder",
        severity: "avoid",
        movement_patterns: ["horizontal_push", "vertical_push"],
        exercise_ids: ["bodyweight-squat"],
        note: "",
        active: true,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
  });
  const draft = planner.buildFitnessPlanDraft(input);
  const ids = draft.days.flatMap((day) =>
    day.items.flatMap((item) => [item.exercise_id, ...item.substitution_exercise_ids])
  );
  assert.equal(ids.includes("bodyweight-squat"), false);
  assert.equal(ids.some((id) => id.includes("push-up") || id.includes("press")), false);
  assert.equal(planner.validateFitnessPlanDraft(draft, input).valid, true);
});

test("switching venue never reuses equipment from the previous venue", () => {
  const venueB = venue("venue-b", { venue_type: "hotel" });
  const allEquipment = [
    ...standardEquipment(),
    equipment("space-b", "open_space", "venue-b"),
    equipment("mat-b", "mat", "venue-b"),
    equipment("bike-b", "bike", "venue-b", {
      load_mode: "range",
      load_semantics: "resistance_level",
    }),
  ];
  const inputA = context({ equipment: allEquipment });
  const inputB = context({
    venue: venueB,
    equipment: allEquipment,
    profile: profile({ resistance_days_per_week: 1, cardio_days_per_week: 1 }),
  });
  const draftA = planner.buildFitnessPlanDraft(inputA);
  const draftB = planner.buildFitnessPlanDraft(inputB);
  const bResourceIds = draftB.days.flatMap((day) =>
    day.items.flatMap((item) => item.resource_equipment_ids)
  );

  assert.ok(bResourceIds.length > 0);
  assert.ok(bResourceIds.every((id) => id.endsWith("-b")));
  assert.equal(bResourceIds.includes("db-a"), false);
  assert.equal(planner.validateFitnessPlanDraft(draftB, inputB).valid, true);
  assert.equal(planner.validateFitnessPlanDraft(draftA, inputB).valid, false);
});

test("maintenance equipment is excluded while limited equipment remains explicit", () => {
  const onlyExercise = {
    id: "test-cable-row",
    name_zh: "测试绳索划船",
    name_en: "Test cable row",
    pattern: "horizontal_pull",
    primary_muscles: ["back"],
    secondary_muscles: [],
    requirements: [{ kind: "cable" }],
    difficulty: "beginner",
    setup_cues: [],
    safety_note: "",
  };
  const maintenanceInput = context({
    exercises: [onlyExercise],
    profile: profile({ resistance_days_per_week: 1, cardio_days_per_week: 0 }),
    equipment: [equipment("cable-off", "cable", "venue-a", {
      status: "maintenance",
      load_mode: "discrete",
      load_semantics: "stack_label",
    })],
    equipmentLoads: [load("cable-off-10", "cable-off", 10)],
  });
  assert.deepEqual(
    planner.availableLoadsForEquipment(
      maintenanceInput.equipment[0],
      maintenanceInput.equipmentLoads,
    ),
    [],
  );
  assert.equal(planner.buildFitnessPlanDraft(maintenanceInput).days.length, 0);

  const limitedInput = {
    ...maintenanceInput,
    equipment: [{ ...maintenanceInput.equipment[0], status: "limited" }],
  };
  const limitedDraft = planner.buildFitnessPlanDraft(limitedInput);
  assert.equal(limitedDraft.days[0].items[0].equipment_id, "cable-off");
  assert.match(limitedDraft.warnings.join(" "), /标记为受限/);
  assert.equal(planner.validateFitnessPlanDraft(limitedDraft, limitedInput).valid, true);
});

test("multi-resource exercises list every requirement and validator rejects omissions", () => {
  const barbellSquat = {
    id: "test-barbell-squat",
    name_zh: "测试杠铃深蹲",
    name_en: "Test barbell squat",
    pattern: "squat",
    primary_muscles: ["legs"],
    secondary_muscles: [],
    requirements: [
      { kind: "barbell" },
      { kind: "plates" },
      { kind: "rack" },
    ],
    difficulty: "beginner",
    setup_cues: [],
    safety_note: "",
  };
  const input = context({
    exercises: [barbellSquat],
    profile: profile({ resistance_days_per_week: 1, cardio_days_per_week: 0 }),
  });
  const draft = planner.buildFitnessPlanDraft(input);
  const item = draft.days[0].items[0];
  assert.deepEqual(
    new Set(item.resource_equipment_ids),
    new Set(["bar-a", "plates-a", "rack-a"]),
  );
  assert.equal(item.equipment_id, "bar-a");
  assert.equal(planner.validateFitnessPlanDraft(draft, input).valid, true);

  const incomplete = {
    ...draft,
    days: [{
      ...draft.days[0],
      items: [{
        ...item,
        resource_equipment_ids: item.resource_equipment_ids.filter(
          (id) => id !== "rack-a",
        ),
      }],
    }],
  };
  const result = planner.validateFitnessPlanDraft(incomplete, input);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /没有列齐/);
});

test("30-minute plans keep rest intact and stay inside the full time budget", () => {
  const input = context();
  const draft = planner.buildFitnessPlanDraft(input);
  for (const day of draft.days) {
    assert.ok(day.estimated_minutes <= 30);
    for (const item of day.items) {
      if (day.kind === "resistance") assert.equal(item.rest_seconds, 90);
    }
  }
  assert.equal(planner.validateFitnessPlanDraft(draft, input).valid, true);
});

test("identical input produces a byte-for-byte stable plan structure", () => {
  const input = context();
  const first = planner.buildFitnessPlanDraft(input);
  const second = planner.buildFitnessPlanDraft(input);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});
