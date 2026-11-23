import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  DEFAULT_RIR,
  PLATEAU_MIN_SESSIONS,
  ParseError,
  assessProgress,
  completedSessionsOfPlan,
  generatePlan,
  nextTarget,
  parseExerciseDef,
  parseLoggedSet,
  parseWorkoutPlan,
  plateauStatus,
  sessionOrm,
  setOrm,
  weightForOrm,
  type ExerciseDef,
  type LoggedSet,
  type SessionRecord,
  type WorkoutPlan,
} from './domain.js';

const EX: ExerciseDef = {
  id: 'bench-press',
  name: 'Bench Press',
  muscleGroup: 'Chest',
  overloadPct: 2.5,
  targetRepMin: 8,
  targetRepMax: 12,
  targetSets: 3,
  startWeight: 50,
};

function session(
  exerciseId: string,
  day: string,
  sets: Array<[reps: number, weight: number, rir?: number]>,
): SessionRecord {
  return {
    planId: 'p1',
    day,
    exerciseId,
    sets: sets.map(([reps, weight, rir]): LoggedSet => ({ reps, weight, rir: rir ?? DEFAULT_RIR })),
  };
}

test('range progression adds reps until the configured maximum', () => {
  const sessions = [session('bench-press', '2026-11-20', [[8, 50], [8, 50], [8, 50]])];
  assert.deepEqual(nextTarget(EX, sessions), { targetReps: 9, weight: 50 });
});

test('range cap resets to minimum after a successful maximum session', () => {
  const range: ExerciseDef = { ...EX, targetRepMin: 8, targetRepMax: 10 };
  const one = session('bench-press', '2026-11-18', [[8, 50], [8, 50], [8, 50]]);
  const two = session('bench-press', '2026-11-19', [[9, 50], [9, 50], [9, 50]]);
  const three = session('bench-press', '2026-11-20', [[10, 50], [10, 50], [10, 50]]);
  // While reps advance, the inverted ORM target cancels the overload bump and
  // the load holds at 50 kg.
  assert.deepEqual(nextTarget(range, [one]), { targetReps: 9, weight: 50 });
  assert.deepEqual(nextTarget(range, [one, two]), { targetReps: 10, weight: 50 });
  // Reset step, exactly: best set ORM 50·(1+11/30) = 68.3333, times the
  // overload (×1.025) = 70.0417, inverted for 8 reps at RIR 1 (÷1.3) =
  // 53.878 → rounded to 54.0 kg.
  assert.deepEqual(nextTarget(range, [one, two, three]), { targetReps: 8, weight: 54 });
});

test('rep reset converts Lombardi ORM to the lower Epley rep target', () => {
  const range: ExerciseDef = { ...EX, targetRepMin: 8, targetRepMax: 12 };
  const sessions = [
    session('bench-press', '2026-11-16', [[8, 50], [8, 50], [8, 50]]),
    session('bench-press', '2026-11-17', [[9, 50], [9, 50], [9, 50]]),
    session('bench-press', '2026-11-18', [[10, 50], [10, 50], [10, 50]]),
    session('bench-press', '2026-11-19', [[11, 54.5], [11, 54.5], [11, 54.5]]),
    session('bench-press', '2026-11-20', [[12, 55.5], [12, 55.5], [12, 55.5]]),
  ];
  // The final set ORM uses Lombardi at 12 reps + 1 RIR. The next 8-rep
  // target uses Epley and rounds the 2.5% ORM increase to 56.5 kg.
  assert.deepEqual(nextTarget(range, sessions), { targetReps: 8, weight: 56.5 });
});

test('a failed session keeps target reps and still applies the overload percent', () => {
  // The overload target is per completed workout: even though the session
  // fails (min reps 7 < 8), the next load is the session's best-set ORM
  // (55·1.3 = 71.5) ×1.025 = 73.2875 inverted for the held 8 reps (÷1.3) =
  // 56.375 → 56.5 kg, above the 55 kg lifted.
  const sessions = [session('bench-press', '2026-11-20', [[7, 55], [8, 55], [8, 55]])];
  assert.deepEqual(nextTarget(EX, sessions), { targetReps: 8, weight: 56.5 });
});

test('no sessions return the base range and start weight', () => {
  assert.deepEqual(nextTarget(EX, []), { targetReps: 8, weight: 50 });
});

test('the next load follows latest ORM even when it is below the lifted weight', () => {
  // A failed 7-rep set at RIR 0 estimates an ORM of 123.33 kg. The next target
  // is 126.42 kg, which inverts to 97 kg for 8 reps at RIR 1.
  const sessions = [session('bench-press', '2026-11-20', [[7, 100, 0]])];
  const next = nextTarget(EX, sessions);
  assert.equal(next.targetReps, 8);
  assert.equal(next.weight, 97);
});

test('logged sets default to RIR 1 when the field is missing', () => {
  assert.equal(parseLoggedSet({ reps: 8, weight: 50 }).rir, DEFAULT_RIR);
  assert.equal(parseLoggedSet({ reps: 8, weight: 50, rir: 3 }).rir, 3);
  const plan = parseWorkoutPlan({
    id: 'p1',
    day: '2026-11-20',
    exercises: [{
      exerciseId: 'bench-press',
      targetReps: 8,
      targetSets: 3,
      weight: 50,
      loggedSets: [{ reps: 8, weight: 50 }],
      isComplete: false,
    }],
  });
  assert.equal(plan.exercises[0]!.loggedSets[0]!.rir, DEFAULT_RIR);
});

test('RIR boundaries: 0 and 10 are valid, everything else is rejected', () => {
  assert.equal(parseLoggedSet({ reps: 8, weight: 50, rir: 0 }).rir, 0);
  assert.equal(parseLoggedSet({ reps: 8, weight: 50, rir: 10 }).rir, 10);
  assert.throws(() => parseLoggedSet({ reps: 8, weight: 50, rir: -1 }), ParseError);
  assert.throws(() => parseLoggedSet({ reps: 8, weight: 50, rir: 11 }), ParseError);
  assert.throws(() => parseLoggedSet({ reps: 8, weight: 50, rir: 1.5 }), ParseError);
  assert.throws(() => parseLoggedSet({ reps: 8, weight: 50, rir: '2' }), ParseError);
});

test('Epley ORM applies at 10 or fewer performed reps', () => {
  assert.equal(setOrm({ reps: 8, weight: 100, rir: 2 }), 100 * (1 + 10 / 30));
  assert.equal(setOrm({ reps: 10, weight: 100, rir: 0 }), 100 * (1 + 10 / 30));
});

test('Lombardi ORM applies above 10 performed reps', () => {
  // Lombardi: weight * reps^0.10 (vcalc.com/wiki/lombardi-one-1-rep-maximum),
  // extended with RIR as reps + rir.
  assert.equal(setOrm({ reps: 12, weight: 100, rir: 2 }), 100 * Math.pow(14, 0.10));
  assert.equal(setOrm({ reps: 11, weight: 100, rir: 0 }), 100 * Math.pow(11, 0.10));
});

test('the formula is chosen by performed reps, not reps plus RIR', () => {
  // 10 performed reps with RIR 5 stays Epley (150 kg); Lombardi at 15 total
  // reps would estimate 100·15^0.10 ≈ 141.3 kg.
  assert.equal(setOrm({ reps: 10, weight: 100, rir: 5 }), 100 * (1 + 15 / 30));
  assert.notEqual(setOrm({ reps: 10, weight: 100, rir: 5 }), 100 * Math.pow(15, 0.10));
});

test('session ORM is its highest-ORM set', () => {
  const sets: LoggedSet[] = [
    { reps: 8, weight: 80, rir: 0 },
    { reps: 6, weight: 100, rir: 2 },
  ];
  // 80·(1+8/30) = 101.33 vs 100·(1+8/30) = 126.67.
  assert.equal(sessionOrm(sets), 100 * (1 + 8 / 30));
  assert.equal(sessionOrm([]), 0);
});

test('weightForOrm inverts the matching estimator at default RIR', () => {
  // Epley branch: a 9-rep inversion divides by 1 + (9+1)/30.
  assert.equal(weightForOrm(130, 9), 97.5);
  // Round-trips: inverting a set's own ORM at its reps returns its weight.
  assert.equal(weightForOrm(setOrm({ reps: 9, weight: 97.5, rir: 1 }), 9), 97.5);
  // Lombardi branch for target reps above 10.
  assert.equal(weightForOrm(setOrm({ reps: 12, weight: 100, rir: 1 }), 12), 100);
  // Results snap to the nearest 0.5 kg.
  assert.equal(weightForOrm(100, 1), 94);
});

test('range fields migrate legacy repTarget with a 15 maximum', () => {
  const parsed = parseExerciseDef({
    id: 'legacy',
    name: 'Legacy',
    muscleGroup: '',
    overloadPct: 2.5,
    repTarget: 8,
    targetSets: 3,
    startWeight: 40,
  });
  assert.deepEqual(
    { targetRepMin: parsed.targetRepMin, targetRepMax: parsed.targetRepMax },
    { targetRepMin: 8, targetRepMax: 15 },
  );
});

test('range validation rejects invalid bounds', () => {
  assert.throws(() => parseExerciseDef({ ...EX, targetRepMin: 0 }), ParseError);
  assert.throws(() => parseExerciseDef({ ...EX, targetRepMin: 11, targetRepMax: 10 }), ParseError);
  assert.throws(() => parseExerciseDef({ ...EX, targetRepMax: 101 }), ParseError);
  assert.throws(() => parseExerciseDef({ ...EX, targetRepMin: 8.5 }), ParseError);
});

test('recorded sets have a safety limit instead of a 15 progression cap', () => {
  assert.equal(parseLoggedSet({ reps: 100, weight: 50 }).reps, 100);
  assert.throws(() => parseLoggedSet({ reps: 1001, weight: 50 }), ParseError);
});

test('parse rejects invalid workout data', () => {
  assert.throws(() => parseExerciseDef({ ...EX, overloadPct: 'lots' }), ParseError);
  assert.throws(() => parseLoggedSet({ reps: 0, weight: 50 }), ParseError);
  assert.throws(() => parseWorkoutPlan({ id: 'p1', day: '20-11-2026', exercises: [] }), ParseError);
});

test('completed-only assessment ignores incomplete plans', () => {
  const plan: WorkoutPlan = {
    id: 'p1',
    day: '2026-11-20',
    exercises: [{
      exerciseId: 'bench-press',
      targetReps: 8,
      targetSets: 3,
      weight: 50,
      loggedSets: [{ reps: 10, weight: 60, rir: 1 }],
      isComplete: false,
    }],
  };
  assert.deepEqual(completedSessionsOfPlan(plan), []);
  assert.equal(assessProgress('bench-press', [plan]).sessions.length, 0);
});

test('best set and ORM come from completed sessions only', () => {
  const done: WorkoutPlan = {
    id: 'p1',
    day: '2026-11-20',
    exercises: [{
      exerciseId: 'bench-press',
      targetReps: 8,
      targetSets: 3,
      weight: 50,
      loggedSets: [{ reps: 8, weight: 50, rir: 1 }],
      isComplete: true,
    }],
  };
  const incomplete: WorkoutPlan = {
    id: 'p2',
    day: '2026-11-21',
    exercises: [{
      exerciseId: 'bench-press',
      targetReps: 8,
      targetSets: 3,
      weight: 50,
      loggedSets: [{ reps: 12, weight: 90, rir: 0 }],
      isComplete: false,
    }],
  };
  const a = assessProgress('bench-press', [done, incomplete]);
  assert.equal(a.sessions.length, 1);
  assert.equal(a.bestSet, done.exercises[0]!.loggedSets[0]!);
  assert.equal(setOrm(a.bestSet!), 50 * (1 + 9 / 30));
});

test('plateau needs three completed sessions', () => {
  const sessions = [
    session('bench', '2026-11-16', [[8, 50], [8, 50], [8, 50]]),
    session('bench', '2026-11-18', [[8, 50], [8, 50], [8, 50]]),
    session('bench', '2026-11-20', [[8, 50], [8, 50], [8, 50]]),
  ];
  assert.equal(plateauStatus(sessions), 'plateau');
  assert.equal(plateauStatus(sessions.slice(0, 2)), 'unknown');
});

test('plateau compares session ORM, not tonnage', () => {
  // Tonnage falls (600 → 560 → 560 kg·reps), which the volume-based verdict
  // read as a plateau; best-set ORM rises (82 → 91 → 91 kg), so it is not one.
  const sessions = [
    session('bench', '2026-11-16', [[10, 60]]),
    session('bench', '2026-11-18', [[8, 70]]),
    session('bench', '2026-11-20', [[8, 70]]),
  ];
  assert.equal(plateauStatus(sessions), 'progressing');
});

test('zero-load sessions fall back to reps plus RIR for plateau', () => {
  const sessions = [
    session('pullup', '2026-11-16', [[8, 0]]),
    session('pullup', '2026-11-18', [[8, 0]]),
    session('pullup', '2026-11-20', [[9, 0]]),
  ];
  assert.equal(plateauStatus(sessions), 'progressing');
});

test('generatePlan uses range targets and base weight without sessions', () => {
  const next = generatePlan([EX], [], '2026-11-22');
  assert.equal(next.exercises[0]!.targetReps, 8);
  assert.equal(next.exercises[0]!.weight, 50);
  assert.equal(next.exercises[0]!.loggedSets.length, 0);
  assert.equal(next.exercises[0]!.isComplete, false);
});

test('PLATEAU_MIN_SESSIONS is 3', () => {
  assert.equal(PLATEAU_MIN_SESSIONS, 3);
});
