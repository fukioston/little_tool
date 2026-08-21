import {
  EQUIPMENT_KIND_LABELS,
  equipmentResourcesForExercise,
  exercisesForVenue,
} from "./catalog";
import type { PlanDraftInput } from "./ai-contract";
import type {
  FitnessConstraint,
  FitnessExercise,
  FitnessSnapshot,
  FitnessVenue,
} from "./types";

function constraintApplies(constraint: FitnessConstraint, exercise: FitnessExercise) {
  return constraint.exercise_ids.includes(exercise.id) ||
    constraint.movement_patterns.includes(exercise.pattern);
}

/**
 * Builds a plan request without user-authored free text. Body-boundary text stays
 * local: hard avoids shape the allowed action pool, while softer reminders are
 * applied by the local planner and live-session UI after the model responds.
 */
export function buildPrivateFitnessPlanInput(
  snapshot: FitnessSnapshot,
  venue: FitnessVenue,
): PlanDraftInput {
  if (!snapshot.profile) throw new Error("请先保存训练偏好");
  if (venue.status !== "active") throw new Error("只能为当前可用场地生成草稿");

  const venueEquipment = snapshot.equipment.filter((entry) => entry.venue_id === venue.id);
  const avoidConstraints = snapshot.constraints.filter((entry) => entry.active && entry.severity === "avoid");
  const allowedDefinitions = exercisesForVenue(venueEquipment, snapshot.equipmentLoads).filter((exercise) =>
    !avoidConstraints.some((constraint) => constraintApplies(constraint, exercise)),
  );
  const allowedExercises = allowedDefinitions.map((exercise) => {
    const resourceIds = equipmentResourcesForExercise(
      exercise,
      venueEquipment,
      snapshot.equipmentLoads,
    )?.map((entry) => entry.id) ?? [];
    return {
      exercise_id: exercise.id,
      name: `${exercise.name_zh} / ${exercise.name_en}`,
      movement_pattern: exercise.pattern,
      required_equipment_ids: resourceIds,
      is_bodyweight: exercise.requirements.length === 0 || exercise.requirements.every((requirement) =>
        requirement.kind === "open_space" || requirement.kind === "mat"),
    };
  });
  const allowedById = new Map(allowedExercises.map((exercise) => [exercise.exercise_id, exercise]));

  return {
    venue: {
      venue_id: venue.id,
      name: "当前场地",
      equipment: venueEquipment.map((entry) => ({
        equipment_id: entry.id,
        name: EQUIPMENT_KIND_LABELS[entry.kind],
        category: entry.kind,
        quantity: entry.quantity,
        status: entry.status,
        details: [],
        available_loads: snapshot.equipmentLoads
          .filter((load) => load.equipment_id === entry.id)
          .map((load) => ({
            load_grams: load.load_grams,
            quantity: load.quantity,
            label: null,
            available: load.available,
          })),
      })),
    },
    allowed_exercises: allowedExercises,
    goals: [...snapshot.profile.goals],
    experience: snapshot.profile.experience,
    weekly_schedule: {
      strength_sessions: snapshot.profile.resistance_days_per_week,
      cardio_sessions: snapshot.profile.cardio_days_per_week,
      session_minutes: snapshot.profile.session_minutes,
      available_days: snapshot.profile.preferred_weekdays.map(String),
    },
    constraints: [],
    preferences: [],
    known_capabilities: snapshot.capabilities
      .filter((capability) => {
        const exercise = allowedById.get(capability.exercise_id);
        if (!exercise) return false;
        return exercise.is_bodyweight
          ? capability.equipment_id === null
          : capability.equipment_id !== null && exercise.required_equipment_ids.includes(capability.equipment_id);
      })
      .slice(0, 40)
      .map((capability) => ({
        equipment_id: capability.equipment_id,
        exercise_id: capability.exercise_id,
        load_grams: capability.load_grams,
        reps: capability.reps,
        rir: capability.rir,
        note: "",
      })),
  };
}
