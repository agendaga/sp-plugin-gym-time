/**
 * Pure domain model for Gym Time: hypertrophy tracking with RIR and
 * ORM-driven progression.
 *
 * No DOM, no PluginAPI, no I/O. Two rules hold everywhere:
 * - Rep targets are per-exercise ranges capped at 100.
 * - Recorded set values have a separate safety cap.
 * - Only completed plan exercises (isComplete) and their explicitly logged
 *   sets count as performance. Planned targets and incomplete items are never
 *   treated as work done.
 * - Every logged set carries RIR (reps in reserve). Estimated one-rep-max
 *   (ORM) values are always derived from completed logged sets and never
 *   persisted as a duplicate field.
 */

/** Safety cap for set input and recorded set values. */
export const SET_REPS_MAX = 1000;
/** Highest RIR (reps in reserve) a set may record. */
export const RIR_MAX = 10;
/** RIR assumed for legacy sets recorded without one, and the UI default. */
export const DEFAULT_RIR = 1;
/** Sets with at most this many performed reps estimate ORM with Epley; above it, Lombardi. */
export const EPLEY_MAX_REPS = 10;
/** Completed sessions required before a plateau verdict is surfaced. */
export const PLATEAU_MIN_SESSIONS = 3;

export interface ExerciseDef {
  /** Stable id; the synced storage key is derived from it. */
  id: string;
  name: string;
  muscleGroup: string;
  /** ORM increase target after each completed workout. */
  overloadPct: number;
  /** Reps per set at the start of a fresh load level. */
  targetRepMin: number;
  /** Highest target reps before load increases. */
  targetRepMax: number;
  /** Sets per session. */
  targetSets: number;
  /** Load (kg) used when no completed session exists yet. */
  startWeight: number;
}

export interface LoggedSet {
  /** 1..SET_REPS_MAX */
  reps: number;
  /** kg, >= 0 */
  weight: number;
  /** Reps in reserve, 0..RIR_MAX. Legacy stored sets without it parse as DEFAULT_RIR. */
  rir: number;
}

export interface PlannedExercise {
  exerciseId: string;
  targetReps: number;
  targetSets: number;
  /** Prescribed load (kg) for this session. */
  weight: number;
  /** Explicitly logged sets; never inferred from the plan targets. */
  loggedSets: LoggedSet[];
  /** Explicit completion state, set only by a user action. */
  isComplete: boolean;
}

export interface WorkoutPlan {
  id: string;
  /** Logical day, YYYY-MM-DD. */
  day: string;
  exercises: PlannedExercise[];
}

/** Performance record derived from one completed planned exercise. */
export interface SessionRecord {
  planId: string;
  day: string;
  exerciseId: string;
  sets: LoggedSet[];
}

export type PlateauStatus = 'unknown' | 'progressing' | 'plateau';

export interface ProgressionTarget {
  targetReps: number;
  weight: number;
}

export interface ProgressAssessment {
  sessions: SessionRecord[];
  /** Highest-ORM set across all completed sessions. */
  bestSet: LoggedSet | null;
}

export class ParseError extends Error {}

// --- shared invariants -------------------------------------------------

export function clampReps(reps: number): number {
  return Math.min(SET_REPS_MAX, Math.max(1, Math.round(reps)));
}

export function roundToHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

/**
 * Estimated one-rep max (ORM) for a set performed at `weight` for `reps`
 * reps with `rir` reps in reserve, in kg.
 *
 * The formula is chosen by performed reps alone, never reps + RIR:
 * - Epley for reps <= EPLEY_MAX_REPS: `weight * (1 + (reps + rir) / 30)`.
 * - Lombardi above that: `weight * (reps + rir)^0.10`
 *   (https://www.vcalc.com/wiki/lombardi-one-1-rep-maximum, extended with RIR;
 *   at RIR 0 it is exactly the published formula).
 */
export function estimateOrm(weight: number, reps: number, rir: number): number {
  return reps <= EPLEY_MAX_REPS
    ? weight * (1 + (reps + rir) / 30)
    : weight * Math.pow(reps + rir, 0.10);
}

export function setOrm(set: LoggedSet): number {
  return estimateOrm(set.weight, set.reps, set.rir);
}

/** A session's ORM: its highest-ORM set. 0 for a session without sets. */
export function sessionOrm(sets: LoggedSet[]): number {
  return sets.reduce((best, s) => Math.max(best, setOrm(s)), 0);
}

/**
 * Load (kg) estimated to achieve `orm` at `reps` reps assuming DEFAULT_RIR:
 * the matching estimator inverted, then rounded to the nearest 0.5 kg.
 * Because the prescribed load is rounded, the ORM actually achieved at it can
 * differ from the target.
 */
export function weightForOrm(orm: number, reps: number): number {
  const raw = reps <= EPLEY_MAX_REPS
    ? orm / (1 + (reps + DEFAULT_RIR) / 30)
    : orm / Math.pow(reps + DEFAULT_RIR, 0.10);
  return roundToHalf(Math.round(raw * 100) / 100);
}

// --- parsing and validation (the API boundary) --------------------------
// Synced JSON is untrusted: reject structurally invalid records, clamp rep
// values above the cap so old or hand-edited data cannot break the model.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ParseError(`${what}: expected object`);
  }
  return raw as Record<string, unknown>;
}

function reqString(o: Record<string, unknown>, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ParseError(`${what}: ${key} must be a non-empty string`);
  }
  return v;
}

function reqNumber(o: Record<string, unknown>, key: string, what: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ParseError(`${what}: ${key} must be a finite number`);
  }
  return v;
}

function reqBoolean(o: Record<string, unknown>, key: string, what: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') {
    throw new ParseError(`${what}: ${key} must be a boolean`);
  }
  return v;
}

export function parseLoggedSet(raw: unknown, what = 'set'): LoggedSet {
  const o = assertObject(raw, what);
  const reps = reqNumber(o, 'reps', what);
  const weight = reqNumber(o, 'weight', what);
  if (!Number.isInteger(reps) || reps < 1 || reps > SET_REPS_MAX) {
    throw new ParseError(`${what}: reps must be an integer from 1 to ${SET_REPS_MAX}`);
  }
  if (weight < 0) {
    throw new ParseError(`${what}: weight must be >= 0`);
  }
  // Sets recorded before RIR tracking have no rir field and parse with the
  // default; a value that is present must still be a valid integer.
  const rir = o['rir'] === undefined ? DEFAULT_RIR : reqNumber(o, 'rir', what);
  if (!Number.isInteger(rir) || rir < 0 || rir > RIR_MAX) {
    throw new ParseError(`${what}: rir must be an integer from 0 to ${RIR_MAX}`);
  }
  return { reps: clampReps(reps), weight, rir };
}

function parseLoggedSets(raw: unknown, what: string): LoggedSet[] {
  if (!Array.isArray(raw)) {
    throw new ParseError(`${what}: loggedSets must be an array`);
  }
  return raw.map((s, i) => parseLoggedSet(s, `${what}.loggedSets[${i}]`));
}

export function parseExerciseDef(raw: unknown): ExerciseDef {
  const what = 'exercise';
  const o = assertObject(raw, what);
  const id = reqString(o, 'id', what);
  if (!/^[\w-]+$/.test(id)) {
    throw new ParseError(`${what}: id must match [\\w-]+`);
  }
  const overloadPct = reqNumber(o, 'overloadPct', what);
  if (overloadPct <= 0 || overloadPct > 100) {
    throw new ParseError(`${what}: overloadPct must be in (0, 100]`);
  }
  let targetRepMin: number;
  let targetRepMax: number;
  if (o['targetRepMin'] !== undefined || o['targetRepMax'] !== undefined) {
    targetRepMin = reqNumber(o, 'targetRepMin', what);
    targetRepMax = o['targetRepMax'] === undefined ? 15 : reqNumber(o, 'targetRepMax', what);
  } else if (o['repTarget'] !== undefined) {
    targetRepMin = reqNumber(o, 'repTarget', what);
    targetRepMax = 15;
  } else {
    throw new ParseError(`${what}: targetRepMin is required`);
  }
  if (!Number.isInteger(targetRepMin) || targetRepMin < 1) {
    throw new ParseError(`${what}: targetRepMin must be an integer >= 1`);
  }
  if (!Number.isInteger(targetRepMax) || targetRepMax < targetRepMin) {
    throw new ParseError(`${what}: targetRepMax must be an integer >= targetRepMin`);
  }
  if (targetRepMax > 100) {
    throw new ParseError(`${what}: targetRepMax must be <= 100`);
  }
  const targetSets = reqNumber(o, 'targetSets', what);
  if (!Number.isInteger(targetSets) || targetSets < 1) {
    throw new ParseError(`${what}: targetSets must be an integer >= 1`);
  }
  const startWeight = reqNumber(o, 'startWeight', what);
  if (startWeight < 0) {
    throw new ParseError(`${what}: startWeight must be >= 0`);
  }
  return {
    id,
    name: reqString(o, 'name', what),
    muscleGroup: typeof o['muscleGroup'] === 'string' ? o['muscleGroup'] : '',
    overloadPct,
    targetRepMin,
    targetRepMax,
    targetSets,
    startWeight,
  };
}

export function parsePlannedExercise(raw: unknown): PlannedExercise {
  const what = 'plannedExercise';
  const o = assertObject(raw, what);
  const targetReps = reqNumber(o, 'targetReps', what);
  if (!Number.isInteger(targetReps) || targetReps < 1 || targetReps > 100) {
    throw new ParseError(`${what}: targetReps must be an integer from 1 to 100`);
  }
  const targetSets = reqNumber(o, 'targetSets', what);
  if (!Number.isInteger(targetSets) || targetSets < 1) {
    throw new ParseError(`${what}: targetSets must be an integer >= 1`);
  }
  const weight = reqNumber(o, 'weight', what);
  if (weight < 0) {
    throw new ParseError(`${what}: weight must be >= 0`);
  }
  return {
    exerciseId: reqString(o, 'exerciseId', what),
    targetReps,
    targetSets,
    weight,
    loggedSets: parseLoggedSets(o['loggedSets'], what),
    isComplete: reqBoolean(o, 'isComplete', what),
  };
}

export function parseWorkoutPlan(raw: unknown): WorkoutPlan {
  const what = 'plan';
  const o = assertObject(raw, what);
  const day = reqString(o, 'day', what);
  if (!DAY_RE.test(day)) {
    throw new ParseError(`${what}: day must be YYYY-MM-DD`);
  }
  const exercisesRaw = o['exercises'];
  if (!Array.isArray(exercisesRaw)) {
    throw new ParseError(`${what}: exercises must be an array`);
  }
  return {
    id: reqString(o, 'id', what),
    day,
    exercises: exercisesRaw.map((e) => parsePlannedExercise(e)),
  };
}

// --- completed-only derivation ------------------------------------------

/** Sessions derived from a plan. Incomplete planned exercises contribute nothing. */
export function completedSessionsOfPlan(plan: WorkoutPlan): SessionRecord[] {
  return plan.exercises
    .filter((pe) => pe.isComplete && pe.loggedSets.length > 0)
    .map((pe) => ({
      planId: plan.id,
      day: plan.day,
      exerciseId: pe.exerciseId,
      sets: pe.loggedSets,
    }));
}

function sortSessions(sessions: SessionRecord[]): SessionRecord[] {
  return [...sessions].sort(
    (a, b) => a.day.localeCompare(b.day) || a.planId.localeCompare(b.planId),
  );
}

/** All completed sessions across plans, oldest first. */
export function collectSessions(plans: WorkoutPlan[]): SessionRecord[] {
  return sortSessions(plans.flatMap(completedSessionsOfPlan));
}

/** Assessment for one exercise. Built only from its completed sessions. */
export function assessProgress(
  exerciseId: string,
  plans: WorkoutPlan[],
): ProgressAssessment {
  const sessions = collectSessions(plans).filter((s) => s.exerciseId === exerciseId);
  let bestSet: LoggedSet | null = null;
  for (const s of sessions) {
    for (const set of s.sets) {
      if (!bestSet || setOrm(set) > setOrm(bestSet)) {
        bestSet = set;
      }
    }
  }
  return { sessions, bestSet };
}

// --- progression ---------------------------------------------------------
// Rep-range progression: each successful session adds one rep until the
// configured maximum; the next success resets to the minimum. Load targets
// come from the completed sessions' estimated one-rep max (ORM).

/**
 * Next target for one exercise, replaying completed sessions oldest first.
 *
 * Reps follow the configured range: a successful session (at least
 * targetSets sets whose lowest reps reach the current target) advances one
 * rep; a success at targetRepMax resets to targetRepMin; a failed session
 * holds the reps.
 *
 * After every completed workout the next load target is derived from that
 * workout's best set: target ORM = best set ORM x (1 + overloadPct / 100),
 * inverted for the next target reps at DEFAULT_RIR and rounded to 0.5 kg.
 * The explicit percentage applies even when a failed workout keeps the same
 * reps, because the overload target is per completed workout. The prescribed
 * load follows the latest completed workout's ORM, even when that means a
 * lower weight after estimated ORM falls. A first workout uses startWeight.
 */
export function nextTarget(
  ex: ExerciseDef,
  sessions: SessionRecord[],
): ProgressionTarget {
  let targetReps = ex.targetRepMin;
  let weight = ex.startWeight;
  for (const s of sortSessions(sessions)) {
    if (s.sets.length === 0) continue;
    const minReps = Math.min(...s.sets.map((x) => x.reps));
    const succeeded = s.sets.length >= ex.targetSets && minReps >= targetReps;
    const nextReps = succeeded
      ? (targetReps >= ex.targetRepMax ? ex.targetRepMin : targetReps + 1)
      : targetReps;
    const targetOrm = sessionOrm(s.sets) * (1 + ex.overloadPct / 100);
    weight = weightForOrm(targetOrm, nextReps);
    targetReps = nextReps;
  }
  return { targetReps, weight };
}

/**
 * Plateau verdict for one exercise. Only completed sessions are compared:
 * fewer than PLATEAU_MIN_SESSIONS is 'unknown'; a plateau is when the last
 * two sessions each failed to beat the best-set ORM of the one before them.
 * Zero-load sessions fall back to their best reps + RIR so bodyweight
 * progress stays visible.
 */
export function plateauStatus(sessions: SessionRecord[]): PlateauStatus {
  const sorted = sortSessions(sessions);
  if (sorted.length < PLATEAU_MIN_SESSIONS) {
    return 'unknown';
  }
  const scores = sorted.map((session) => {
    const orm = sessionOrm(session.sets);
    return orm > 0
      ? orm
      : session.sets.reduce((best, set) => Math.max(best, set.reps + set.rir), 0);
  });
  const n = scores.length;
  if (scores[n - 1]! <= scores[n - 2]! && scores[n - 2]! <= scores[n - 3]!) {
    return 'plateau';
  }
  return 'progressing';
}

// --- plan generation -----------------------------------------------------

export function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function generatePlan(
  defs: ExerciseDef[],
  plans: WorkoutPlan[],
  day: string,
): WorkoutPlan {
  const byExercise = new Map<string, SessionRecord[]>();
  for (const s of collectSessions(plans)) {
    const list = byExercise.get(s.exerciseId) ?? [];
    list.push(s);
    byExercise.set(s.exerciseId, list);
  }
  return {
    id: newId(),
    day,
    exercises: defs.map((ex) => {
      const t = nextTarget(ex, byExercise.get(ex.id) ?? []);
      return {
        exerciseId: ex.id,
        targetReps: t.targetReps,
        targetSets: ex.targetSets,
        weight: t.weight,
        loggedSets: [],
        isComplete: false,
      };
    }),
  };
}

// --- seed data -----------------------------------------------------------

export const DEFAULT_EXERCISES: ExerciseDef[] = [
  { id: 'squat', name: 'Back Squat', muscleGroup: 'Legs', overloadPct: 2.5, targetRepMin: 8, targetRepMax: 15, targetSets: 3, startWeight: 60 },
  { id: 'bench-press', name: 'Bench Press', muscleGroup: 'Chest', overloadPct: 2.5, targetRepMin: 8, targetRepMax: 15, targetSets: 3, startWeight: 50 },
  { id: 'deadlift', name: 'Deadlift', muscleGroup: 'Back', overloadPct: 5, targetRepMin: 5, targetRepMax: 15, targetSets: 3, startWeight: 80 },
  { id: 'overhead-press', name: 'Overhead Press', muscleGroup: 'Shoulders', overloadPct: 2.5, targetRepMin: 8, targetRepMax: 15, targetSets: 3, startWeight: 35 },
  { id: 'barbell-row', name: 'Barbell Row', muscleGroup: 'Back', overloadPct: 2.5, targetRepMin: 10, targetRepMax: 15, targetSets: 3, startWeight: 45 },
  { id: 'lat-pulldown', name: 'Lat Pulldown', muscleGroup: 'Back', overloadPct: 5, targetRepMin: 12, targetRepMax: 15, targetSets: 3, startWeight: 50 },
];
