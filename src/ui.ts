/**
 * Iframe UI for the Gym Time plugin.
 * Each exercise and workout plan is stored under its own synced key.
 */
import type { PluginAPI as PluginAPIType } from '@super-productivity/plugin-api';
declare const PluginAPI: PluginAPIType;

import {
  DEFAULT_EXERCISES,
  DEFAULT_RIR,
  SET_REPS_MAX,
  RIR_MAX,
  ParseError,
  assessProgress,
  estimateOrm,
  generatePlan,
  newId,
  nextTarget,
  parseExerciseDef,
  parseLoggedSet,
  parseWorkoutPlan,
  plateauStatus,
  sessionOrm,
  setOrm,
  type ExerciseDef,
  type PlannedExercise,
  type SessionRecord,
  type WorkoutPlan,
} from './domain.js';

// --- synced storage: one independent record per entity -------------------

const EX_PREFIX = 'ex:';
const PLAN_PREFIX = 'plan:';
const PROFILE_PREFIX = 'profile:';
const DEFAULT_PROFILE = 'default';

interface Profile {
  id: string;
  name: string;
}

interface Store {
  exercises: ExerciseDef[];
  plans: WorkoutPlan[];
}

let store: Store = { exercises: [], plans: [] };
let storageSupported = true;
let profiles: Profile[] = [{ id: DEFAULT_PROFILE, name: 'My workouts' }];
let activeProfile = DEFAULT_PROFILE;
let selectedPlanId: string | null = null;
let busy = false;
let refreshPending = false;

function exKey(id: string): string {
  return EX_PREFIX + id;
}

function planKey(id: string): string {
  return recordPrefix(PLAN_PREFIX) + id;
}

function recordPrefix(kind: string, profileId = activeProfile): string {
  return profileId === DEFAULT_PROFILE ? kind : `user:${profileId}:${kind}`;
}

function dayKey(a: WorkoutPlan): string {
  return a.day + a.id;
}

function parseProfile(raw: unknown): Profile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ParseError('Invalid user profile');
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || !/^[\w-]+$/.test(record.id) ||
      typeof record.name !== 'string' || !record.name.trim()) {
    throw new ParseError('Invalid user profile');
  }
  return { id: record.id, name: record.name.trim() };
}

async function loadStore(profileId = activeProfile): Promise<number> {
  if (typeof PluginAPI.listSyncedDataKeys !== 'function') {
    storageSupported = false;
    return 0;
  }
  const exercises: ExerciseDef[] = [];
  const plans: WorkoutPlan[] = [];
  const loadedProfiles: Profile[] = [];
  const keys = await PluginAPI.listSyncedDataKeys();
  const sharedExerciseKeys = new Set(keys.filter((key) => key.startsWith(EX_PREFIX)));
  let unreadable = 0;
  for (const key of keys) {
    const isProfile = key.startsWith(PROFILE_PREFIX);
    const isSharedExercise = key.startsWith(EX_PREFIX);
    const isLegacyProfileExercise = /^user:[\w-]+:ex:.+$/.test(key);
    const isExercise = isSharedExercise || isLegacyProfileExercise;
    const isPlan = key.startsWith(recordPrefix(PLAN_PREFIX, profileId));
    if (!isProfile && !isExercise && !isPlan) continue;
    const raw = await PluginAPI.loadSyncedData(key);
    if (raw === null || raw === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      unreadable++;
      continue;
    }
    if (isExercise) {
      let exercise: ExerciseDef;
      try {
        exercise = parseExerciseDef(parsed);
      } catch {
        unreadable++;
        continue;
      }
      const sharedKey = EX_PREFIX + exercise.id;
      if (isLegacyProfileExercise && !sharedExerciseKeys.has(sharedKey)) {
        await PluginAPI.persistDataSynced(JSON.stringify(exercise), sharedKey);
        sharedExerciseKeys.add(sharedKey);
      }
      const index = exercises.findIndex((item) => item.id === exercise.id);
      if (isSharedExercise || index < 0) {
        if (index >= 0) exercises[index] = exercise;
        else exercises.push(exercise);
      }
      continue;
    }
    try {
      if (isProfile) {
        const profile = parseProfile(parsed);
        if (key !== PROFILE_PREFIX + profile.id) throw new ParseError('User key does not match');
        loadedProfiles.push(profile);
      } else if (isPlan) {
        plans.push(parseWorkoutPlan(parsed));
      }
    } catch {
      unreadable++;
    }
  }
  plans.sort((a, b) => dayKey(b).localeCompare(dayKey(a)));
  const defaultProfile = loadedProfiles.find((profile) => profile.id === DEFAULT_PROFILE);
  profiles = [defaultProfile ?? { id: DEFAULT_PROFILE, name: 'My workouts' },
    ...loadedProfiles.filter((profile) => profile.id !== DEFAULT_PROFILE)];
  store = { exercises, plans };
  if (unreadable > 0) {
    snack(`Skipped ${unreadable} unreadable synced record(s)`, 'WARNING');
  }
  return unreadable;
}

async function saveExercise(def: ExerciseDef): Promise<void> {
  await PluginAPI.persistDataSynced(JSON.stringify(def), exKey(def.id));
}

async function deleteExercise(id: string): Promise<void> {
  await PluginAPI.persistDataSynced('', exKey(id));
}

async function savePlan(plan: WorkoutPlan): Promise<void> {
  await PluginAPI.persistDataSynced(JSON.stringify(plan), planKey(plan.id));
}

async function deletePlan(plan: WorkoutPlan): Promise<void> {
  const count = plan.exercises.reduce((total, exercise) => total + exercise.loggedSets.length, 0);
  const result = await PluginAPI.openDialog({
    title: 'Delete workout',
    content: `Permanently delete the workout on ${plan.day} and its ${count} logged sets? This cannot be undone.`,
    buttons: [{ label: 'Cancel' }, { label: 'Delete workout', color: 'warn', raised: true }],
  });
  if (result !== 'Delete workout') return;
  await PluginAPI.persistDataSynced('', planKey(plan.id));
  store.plans = store.plans.filter((item) => item.id !== plan.id);
  if (selectedPlanId === plan.id) selectedPlanId = null;
  renderAll();
  snack('Workout deleted', 'SUCCESS');
}

async function seedDefaults(): Promise<void> {
  // Deleted-everything is the one edge: reopening re-seeds the defaults.
  if (store.exercises.length === 0) {
    for (const def of DEFAULT_EXERCISES) {
      await saveExercise(def);
    }
    store.exercises = [...DEFAULT_EXERCISES];
  }
}

async function perform(action: () => Promise<void>): Promise<void> {
  if (busy) {
    snack('Please wait for the current action to finish', 'INFO');
    return;
  }
  busy = true;
  try {
    await action();
  } catch (e) {
    console.error('[gym-time]', e);
    snack(`Could not complete the action: ${String(e)}`, 'ERROR');
  } finally {
    busy = false;
    if (refreshPending) void refresh();
  }
}

async function refresh(): Promise<void> {
  if (busy) {
    refreshPending = true;
    return;
  }
  refreshPending = false;
  await perform(async () => {
    await loadStore();
    renderAll();
  });
}

// --- small DOM + feedback helpers ----------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<
    string,
    string | number | boolean | ((event: Event) => void)
  > = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') {
      // onclick -> click, oninput -> input, ...
      node.addEventListener(k.replace(/^on/, ''), v);
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function icon(name: string): HTMLSpanElement {
  return el('span', { class: 'material-icons', 'aria-hidden': 'true' }, name);
}

function snack(msg: string, type: 'SUCCESS' | 'ERROR' | 'WARNING' | 'INFO' = 'INFO'): void {
  PluginAPI.showSnack({ msg, type });
}

function callout(text: string, variant = ''): HTMLDivElement {
  return el('div', { class: `callout${variant ? ' callout--' + variant : ''}` }, el('p', {}, text));
}

/** One-decimal kg formatting for derived ORM estimates. */
function fmtKg(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function plateauChip(exerciseId: string): HTMLElement {
  const sessions = assessProgress(exerciseId, store.plans).sessions;
  const status = plateauStatus(sessions);
  if (status === 'plateau') {
    return el('span', { class: 'chip' }, 'Plateau');
  }
  if (status === 'progressing') {
    return el('span', { class: 'chip' }, 'Progressing');
  }
  return el('span', { class: 'chip text-muted' }, 'Not enough data');
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(
  tag: string,
  attrs: Record<string, string | number> = {},
  ...children: Array<Node | string | null | undefined>
): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const c of children) {
    if (c == null) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/**
 * Dependency-free SVG line chart of estimated session ORM over time,
 * oldest to newest, one point per completed session. Null when the
 * exercise has no completed sessions yet; a single completed session
 * renders as one centered point on a padded scale.
 */
function ormTrendChart(sessions: SessionRecord[]): HTMLElement | null {
  const points = sessions.map((s) => ({ day: s.day, orm: sessionOrm(s.sets) }));
  if (points.length === 0) return null;

  const width = 320;
  const height = 170;
  const padL = 40;
  const padR = 14;
  const padT = 16;
  const padB = 24;
  const orms = points.map((p) => p.orm);
  let lo = Math.min(...orms);
  let hi = Math.max(...orms);
  if (hi === lo) {
    const pad = Math.max(2.5, hi * 0.2);
    lo = Math.max(0, lo - pad);
    hi += pad;
  }
  const x = (i: number): number =>
    points.length === 1
      ? (padL + width - padR) / 2
      : padL + (i * (width - padL - padR)) / (points.length - 1);
  const y = (orm: number): number =>
    padT + (1 - (orm - lo) / (hi - lo)) * (height - padT - padB);

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label':
      `Estimated session ORM over ${points.length} completed ` +
      `${points.length === 1 ? 'session' : 'sessions'}, ${first.day} to ${last.day}`,
    style: 'width:100%;height:auto',
  });
  svg.append(svgEl('title', {}, 'Estimated session ORM per completed workout, oldest to newest'));

  if (points.length > 1) {
    svg.append(svgEl('polyline', {
      points: points.map((p, i) => `${x(i)},${y(p.orm)}`).join(' '),
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.5,
    }));
  }
  svg.append(svgEl('line', {
    x1: padL, y1: height - padB, x2: width - padR, y2: height - padB,
    stroke: 'currentColor', 'stroke-width': 1,
  }));
  svg.append(svgEl('text', { x: 2, y: y(hi) + 3, 'font-size': 9, fill: 'currentColor' }, `${fmtKg(hi)} kg`));
  if (lo !== hi) {
    svg.append(svgEl('text', { x: 2, y: y(lo) - 3, 'font-size': 9, fill: 'currentColor' }, `${fmtKg(lo)} kg`));
  }

  const labelEveryDate = points.length <= 6;
  points.forEach((p, i) => {
    const px = x(i);
    const py = y(p.orm);
    const dot = svgEl('circle', {
      cx: px, cy: py, r: 2.5, fill: 'currentColor',
      'data-day': p.day, 'data-orm': fmtKg(p.orm),
    });
    dot.append(svgEl('title', {}, `${p.day}: ${fmtKg(p.orm)} kg ORM`));
    svg.append(dot);
    svg.append(svgEl('text', {
      x: px, y: py - 5, 'font-size': 9, 'text-anchor': 'middle', fill: 'currentColor',
    }, fmtKg(p.orm)));
    if (labelEveryDate || i === 0 || i === points.length - 1) {
      svg.append(svgEl('text', {
        x: px, y: height - padB + 13, 'font-size': 9, 'text-anchor': 'middle', fill: 'currentColor',
      }, p.day.slice(5)));
    }
  });

  return el('figure', { class: 'orm-trend' },
    svg,
    el('figcaption', { class: 'text-muted text-sm' },
      'Estimated one-rep max (ORM) per completed session, oldest to newest.'),
  );
}

async function todayStr(): Promise<string> {
  if (typeof PluginAPI.getDayContext === 'function') {
    return (await PluginAPI.getDayContext()).todayStr;
  }
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function exerciseById(id: string): ExerciseDef | undefined {
  return store.exercises.find((e) => e.id === id);
}

// --- workout tab ----------------------------------------------------------

function latestPlan(): WorkoutPlan | undefined {
  return store.plans[0];
}

function selectedPlan(): WorkoutPlan | undefined {
  return store.plans.find((plan) => plan.id === selectedPlanId) ?? latestPlan();
}

function renderHistoryTab(section: HTMLElement): void {
  section.replaceChildren(el('h2', {}, 'Workout history'));
  if (store.plans.length === 0) {
    section.append(el('div', { class: 'empty-state' }, 'No workouts yet.'));
    return;
  }
  const list = el('ul', { class: 'list' });
  for (const plan of store.plans) {
    const completed = plan.exercises.filter((exercise) => exercise.isComplete).length;
    list.append(el('li', { class: 'list-item' },
      el('div', { class: 'grow' },
        el('strong', {}, plan.day),
        el('p', { class: 'text-muted text-sm' },
          `${plan.exercises.map((exercise) => exerciseById(exercise.exerciseId)?.name ?? exercise.exerciseId).join(', ') || 'No exercises'} · ${completed} complete`,
        ),
      ),
      el('button', { onclick: () => {
        selectedPlanId = plan.id;
        renderAll();
        showTab('workout');
      } }, 'View / edit'),
      el('button', {
        class: 'btn-danger',
        'aria-label': `Delete workout on ${plan.day}`,
        onclick: () => void perform(() => deletePlan(plan)),
      }, 'Delete'),
    ));
  }
  section.append(list);
}

function renderWorkoutTab(section: HTMLElement): void {
  section.replaceChildren();
  if (!storageSupported) {
    section.append(
      callout(
        'This host has no listSyncedDataKeys(); the plugin needs a newer Super Productivity version.',
        'danger',
      ),
    );
    return;
  }
  const plan = selectedPlan();
  section.append(
    el(
      'div',
      { class: 'row' },
      el('h2', { class: 'grow' }, 'Workout'),
      el(
        'button',
        { class: 'btn-primary', onclick: () => void openGenerateDialog() },
        'Generate next workout',
      ),
    ),
  );
  if (!plan) {
    section.append(
      el('div', { class: 'empty-state' }, 'No plan yet. Generate one from your recent completed work.'),
    );
    return;
  }
  const date = el('input', { type: 'date', value: plan.day, 'aria-label': 'Workout date' });
  section.append(el('div', { class: 'row' },
    el('label', {}, 'Workout date ', date),
    el('button', { onclick: () => void perform(async () => {
      if (!date.value || !date.validity.valid) {
        snack('Enter a valid workout date', 'WARNING');
        return;
      }
      const oldDay = plan.day;
      plan.day = date.value;
      try {
        await savePlan(plan);
      } catch (e) {
        plan.day = oldDay;
        throw e;
      }
      store.plans.sort((a, b) => dayKey(b).localeCompare(dayKey(a)));
      renderAll();
    }) }, 'Save date'),
    el('button', { onclick: () => openAddExerciseDialog(plan) }, 'Add exercise'),
  ));
  if (plan.exercises.length === 0) {
    section.append(el('div', { class: 'empty-state' }, 'This plan is empty. Generate a new one.'));
    return;
  }
  for (const planned of plan.exercises) {
    section.append(plannedExerciseCard(plan, planned));
  }
}

function plannedExerciseCard(plan: WorkoutPlan, planned: PlannedExercise): HTMLElement {
  const def = exerciseById(planned.exerciseId);
  const name = def?.name ?? planned.exerciseId;

  const repsInput = el('input', {
    type: 'number',
    min: '1',
    max: String(SET_REPS_MAX),
    step: '1',
    value: String(planned.targetReps),
    'aria-label': 'Reps',
  });
  const weightInput = el('input', {
    type: 'number',
    min: '0',
    step: '0.5',
    value: String(planned.weight),
    'aria-label': 'Weight (kg)',
  });
  const rirInput = el('input', {
    type: 'number',
    min: '0',
    max: String(RIR_MAX),
    step: '1',
    value: String(DEFAULT_RIR),
    'aria-label': 'RIR (reps in reserve)',
  });

  const setsRow = el(
    'p',
    { class: 'text-muted' },
    `${planned.targetSets} × ${planned.targetReps} @ ${planned.weight} kg · ORM ${fmtKg(estimateOrm(planned.weight, planned.targetReps, DEFAULT_RIR))} kg`,
    planned.isComplete ? el('span', { class: 'chip' }, 'Complete') : null,
  );

  const loggedRow = el('div', { class: 'row' });
  if (planned.loggedSets.length === 0) {
    loggedRow.append(el('span', { class: 'text-muted text-sm' }, 'No sets logged yet.'));
  } else {
    for (const [index, s] of planned.loggedSets.entries()) {
      const orm = setOrm(s);
      loggedRow.append(el('button', {
        class: 'chip',
        type: 'button',
        'aria-label': `Remove set ${index + 1}: ${s.reps} reps at ${s.weight} kg, RIR ${s.rir}, estimated ORM ${fmtKg(orm)} kg`,
        onclick: () => void perform(async () => {
          const removed = planned.loggedSets.splice(index, 1);
          try {
            await savePlan(plan);
          } catch (e) {
            planned.loggedSets.splice(index, 0, ...removed);
            throw e;
          }
          renderAll();
        }),
      }, `${s.reps}×${s.weight} kg @ RIR ${s.rir} · ${fmtKg(orm)} kg ORM ×`));
    }
  }

  const logSet = async (): Promise<void> => {
    if (repsInput.value.trim() === '' || weightInput.value.trim() === '' ||
        rirInput.value.trim() === '') {
      snack('Enter reps, weight and RIR before logging the set', 'WARNING');
      return;
    }
    let set: ReturnType<typeof parseLoggedSet>;
    try {
      set = parseLoggedSet({
        reps: Number(repsInput.value),
        weight: Number(weightInput.value),
        rir: Number(rirInput.value),
      });
    } catch (e) {
      snack(e instanceof ParseError ? e.message : 'Check the set values', 'WARNING');
      return;
    }
    planned.loggedSets.push(set);
    try {
      await savePlan(plan);
    } catch (e) {
      planned.loggedSets.pop();
      snack(`Could not save the set: ${String(e)}`, 'ERROR');
      return;
    }
    renderAll();
  };

  const toggleComplete = async (): Promise<void> => {
    planned.isComplete = !planned.isComplete;
    try {
      await savePlan(plan);
    } catch (e) {
      planned.isComplete = !planned.isComplete;
      snack(`Could not save: ${String(e)}`, 'ERROR');
      return;
    }
    renderAll();
  };

  const remove = async (): Promise<void> => {
    const previousExercises = plan.exercises;
    plan.exercises = plan.exercises.filter((pe) => pe !== planned);
    try {
      await savePlan(plan);
    } catch (e) {
      plan.exercises = previousExercises;
      snack(`Could not save: ${String(e)}`, 'ERROR');
      return;
    }
    renderAll();
  };

  return el(
    'div',
    { class: 'card stack' },
    el('div', { class: 'row' }, el('h3', { class: 'grow' }, name), plateauChip(planned.exerciseId)),
    setsRow,
    loggedRow,
    el(
      'div',
      { class: 'row' },
      repsInput,
      el('span', { class: 'text-muted' }, 'reps'),
      weightInput,
      el('span', { class: 'text-muted' }, 'kg'),
      rirInput,
      el('span', { class: 'text-muted' }, 'RIR'),
      el('button', { class: 'btn-primary', onclick: () => void perform(logSet) }, 'Log set'),
    ),
    el(
      'div',
      { class: 'actions' },
      el(
        'button',
        { class: planned.isComplete ? 'btn-text' : 'btn-outline', onclick: () => void perform(toggleComplete) },
        planned.isComplete ? 'Reopen' : 'Mark complete',
      ),
      el('button', { class: 'btn-icon btn-danger', 'aria-label': 'Remove from plan', onclick: () => void perform(remove) }, icon('delete')),
    ),
  );
}

function openAddExerciseDialog(plan: WorkoutPlan): void {
  const available = store.exercises.filter(
    (def) => !plan.exercises.some((planned) => planned.exerciseId === def.id),
  );
  if (available.length === 0) {
    snack('No more exercises available. Add one in Exercises first.', 'INFO');
    return;
  }
  const dialog = el('dialog');
  const select = el('select', { id: 'add-workout-exercise', 'aria-label': 'Exercise' });
  for (const def of available) {
    select.append(el('option', { value: def.id }, def.name));
  }
  dialog.append(el('div', { class: 'stack' },
    el('h2', {}, 'Add exercise to workout'),
    dialogForm(dialog, field('Exercise', select), 'Add exercise', async () => {
      const def = available.find((item) => item.id === select.value);
      if (!def) {
        snack('Select an exercise', 'WARNING');
        return;
      }
      plan.exercises.push({
        exerciseId: def.id,
        targetReps: def.targetRepMin,
        targetSets: def.targetSets,
        weight: def.startWeight,
        loggedSets: [],
        isComplete: false,
      });
      try {
        await savePlan(plan);
      } catch (e) {
        plan.exercises.pop();
        throw e;
      }
      closeDialog(dialog);
      renderAll();
    }),
  ));
  showDialog(dialog);
}

async function openGenerateDialog(): Promise<void> {
  const dialog = el('dialog');
  const boxes: Array<{ def: ExerciseDef; box: HTMLInputElement }> = [];
  const current = selectedPlan();
  const preselect = new Set(current?.exercises.map((pe) => pe.exerciseId) ?? []);
  const chooser = el('fieldset', { class: 'stack' });

  for (const def of [...store.exercises].sort((a, b) => a.name.localeCompare(b.name))) {
    const target = nextTarget(def, assessProgress(def.id, store.plans).sessions);
    const box = el('input', { type: 'checkbox', value: def.id });
    box.checked = preselect.has(def.id);
    boxes.push({ def, box });
    chooser.append(
      el(
        'label',
        {},
        box,
        ` ${def.name} `,
        el(
          'span',
          { class: 'text-muted text-sm' },
          `— next: ${def.targetSets}×${target.targetReps} @ ${target.weight} kg`,
        ),
      ),
    );
  }

  const generate = async (): Promise<void> => {
    const picked = boxes.filter((b) => b.box.checked).map((b) => b.def);
    if (picked.length === 0) {
      snack('Pick at least one exercise', 'WARNING');
      return;
    }
    let plan: WorkoutPlan;
    try {
      plan = generatePlan(picked, store.plans, await todayStr());
      await savePlan(plan);
    } catch (e) {
      snack(`Could not save the plan: ${String(e)}`, 'ERROR');
      return;
    }
    // Optimistic local update; the persistedDataChanged hook reconciles
    // external writes.
    store.plans = [plan, ...store.plans].sort((a, b) => dayKey(b).localeCompare(dayKey(a)));
    selectedPlanId = plan.id;
    closeDialog(dialog);
    showTab('workout');
    renderAll();
    snack('Workout generated from your completed sessions', 'SUCCESS');
  };

  dialog.append(el('div', { class: 'stack' },
    el('h2', {}, 'Generate next workout'),
    el('p', { class: 'text-muted' }, 'Targets come from your recent completed sessions: reps advance within each exercise range, and the next load follows your best set\u2019s estimated one-rep max (ORM) plus the exercise\u2019s overload percent.'),
    dialogForm(dialog, chooser, 'Generate', generate),
  ));
  showDialog(dialog);
}

function showDialog(dialog: HTMLDialogElement): void {
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

function closeDialog(dialog: HTMLDialogElement): void {
  dialog.close();
  dialog.remove();
}

// Shared form for <dialog> content: a submit action plus Cancel.
function dialogForm(
  dialog: HTMLDialogElement,
  body: HTMLElement,
  submitLabel: string,
  onSubmit: () => Promise<void>,
): HTMLFormElement {
  const form = el('form', { class: 'stack' }, body);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void perform(onSubmit);
  });
  form.append(
    el(
      'div',
      { class: 'actions' },
      el('button', { class: 'btn-text', type: 'button', onclick: () => closeDialog(dialog) }, 'Cancel'),
      el('button', { class: 'btn-primary', type: 'submit' }, submitLabel),
    ),
  );
  return form;
}

// --- exercises tab --------------------------------------------------------

function renderExercisesTab(section: HTMLElement): void {
  section.replaceChildren();
  section.append(
    el(
      'div',
      { class: 'row' },
      el('h2', { class: 'grow' }, 'Exercises'),
      el('button', { class: 'btn-primary', onclick: () => void openExerciseDialog(undefined) }, 'Add exercise'),
    ),
  );
  const list = el('ul', { class: 'list' });
  for (const def of [...store.exercises].sort((a, b) => a.name.localeCompare(b.name))) {
    list.append(
      el(
        'li',
        { class: 'list-item' },
        el(
          'div',
          { class: 'grow stack' },
          el('strong', {}, def.name),
          el(
            'span',
            { class: 'text-muted text-sm' },
            `${def.muscleGroup || 'No muscle group'} · +${def.overloadPct}% · ${def.targetRepMin}-${def.targetRepMax} reps × ${def.targetSets} sets · start ${def.startWeight} kg`,
          ),
          plateauChip(def.id),
        ),
        el('button', { class: 'btn-icon', 'aria-label': `Edit ${def.name}`, onclick: () => void openExerciseDialog(def) }, icon('edit')),
        el(
          'button',
          { class: 'btn-icon btn-danger', 'aria-label': `Delete ${def.name}`, onclick: () => void perform(() => confirmDeleteExercise(def)) },
          icon('delete'),
        ),
      ),
    );
  }
  section.append(list);
}

async function confirmDeleteExercise(def: ExerciseDef): Promise<void> {
  const result = await PluginAPI.openDialog({
    title: 'Delete exercise',
    content: `Delete "${def.name}"? Existing plans keep their logged sets; the exercise just loses its definition.`,
    buttons: [{ label: 'Cancel' }, { label: 'Delete', color: 'warn', raised: true }],
  });
  if (result !== 'Delete') return;
  try {
    await deleteExercise(def.id);
  } catch (e) {
    snack(`Could not delete ${def.name}: ${String(e)}`, 'ERROR');
    return;
  }
  store.exercises = store.exercises.filter((e) => e.id !== def.id);
  renderAll();
}

function field(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const f = el('div', { class: 'field' }, el('label', { for: control.id }, labelText), control);
  if (hint) f.append(el('p', { class: 'field-hint' }, hint));
  return f;
}

async function openExerciseDialog(existing: ExerciseDef | undefined): Promise<void> {
  const uid = existing?.id ?? 'new';
  const name = el('input', { id: `name-${uid}`, type: 'text', value: existing?.name ?? '' });
  const muscle = el('input', { id: `muscle-${uid}`, type: 'text', value: existing?.muscleGroup ?? '' });
  const overload = el('input', {
    id: `overload-${uid}`,
    type: 'number',
    min: '0.5',
    max: '100',
    step: '0.5',
    value: String(existing?.overloadPct ?? 2.5),
  });
  const targetRepMin = el('input', {
    id: `reps-min-${uid}`,
    type: 'number',
    min: '1',
    max: '100',
    step: '1',
    value: String(existing?.targetRepMin ?? 8),
  });
  const targetRepMax = el('input', {
    id: `reps-max-${uid}`,
    type: 'number',
    min: '1',
    max: '100',
    step: '1',
    value: String(existing?.targetRepMax ?? 15),
  });
  const targetSets = el('input', {
    id: `sets-${uid}`,
    type: 'number',
    min: '1',
    max: '100',
    step: '1',
    value: String(existing?.targetSets ?? 3),
  });
  const startWeight = el('input', {
    id: `weight-${uid}`,
    type: 'number',
    min: '0',
    step: '0.5',
    value: String(existing?.startWeight ?? 40),
  });

  const dialog = el('dialog');
  const formBody = el(
    'div',
    { class: 'stack' },
    field('Name', name),
    field('Muscle group', muscle),
    field('Overload % per workout', overload, 'Increase applied to the last completed workout\u2019s best-set ORM to set the next load target.'),
    field('Minimum target reps', targetRepMin, 'Reps per set at the start of a fresh load level.'),
    field('Maximum target reps', targetRepMax, 'Increase load after this rep target is reached and completed.'),
    field('Sets per session', targetSets),
    field('Starting weight (kg)', startWeight),
  );

  const submit = async (): Promise<void> => {
    const candidate: ExerciseDef = {
      id: existing?.id ?? newId(),
      name: name.value.trim(),
      muscleGroup: muscle.value.trim(),
      overloadPct: Number(overload.value),
      targetRepMin: Number(targetRepMin.value),
      targetRepMax: Number(targetRepMax.value),
      targetSets: Number(targetSets.value),
      startWeight: Number(startWeight.value),
    };
    try {
      parseExerciseDef(candidate);
    } catch (e) {
      const msg = e instanceof ParseError ? e.message : 'Check the entered values';
      snack(msg, 'WARNING');
      return;
    }
    try {
      await saveExercise(candidate);
    } catch (e) {
      snack(`Could not save ${candidate.name}: ${String(e)}`, 'ERROR');
      return;
    }
    const idx = store.exercises.findIndex((e) => e.id === candidate.id);
    if (idx >= 0) store.exercises[idx] = candidate;
    else store.exercises.push(candidate);
    closeDialog(dialog);
    renderAll();
    snack(`Saved ${candidate.name}`, 'SUCCESS');
  };

  dialog.append(el('div', { class: 'stack' },
    el('h2', {}, existing ? `Edit ${existing.name}` : 'Add exercise'),
    dialogForm(dialog, formBody, 'Save', submit),
  ));
  showDialog(dialog);
}

// --- progress tab -----------------------------------------------------------

function renderProgressTab(section: HTMLElement): void {
  section.replaceChildren();
  section.append(el('h2', {}, 'Progress'));
  section.append(
    callout(
      'Counts completed plan exercises and their logged sets only. Planned targets and incomplete work are never counted.',
      'info',
    ),
  );
  if (store.exercises.length === 0) {
    section.append(el('div', { class: 'empty-state' }, 'No exercises defined yet.'));
    return;
  }
  for (const def of [...store.exercises].sort((a, b) => a.name.localeCompare(b.name))) {
    const a = assessProgress(def.id, store.plans);
    const last = a.sessions[a.sessions.length - 1];
    const bestOrm = a.bestSet ? setOrm(a.bestSet) : 0;
    const lastOrm = last ? sessionOrm(last.sets) : 0;
    const chart = ormTrendChart(a.sessions);
    section.append(
      el(
        'div',
        { class: 'card stack' },
        el('div', { class: 'row' }, el('h3', { class: 'grow' }, def.name)),
        el('p', {}, `Completed sessions: ${a.sessions.length}`),
        chart ?? el(
          'p',
          { class: 'text-muted' },
          'No completed sessions yet. The ORM trend appears here once a workout with logged sets is marked complete.',
        ),
        el('p', {}, `Best estimated ORM: ${bestOrm > 0 ? `${fmtKg(bestOrm)} kg` : '—'}`),
        el('p', {}, `Last session ORM: ${last ? `${fmtKg(lastOrm)} kg` : '—'}`),
        el('p', {}, `Best set: ${a.bestSet ? `${a.bestSet.reps}×${a.bestSet.weight} kg @ RIR ${a.bestSet.rir}` : '—'}`),
        el('p', { class: 'text-muted' }, `Last completed: ${last ? last.day : '—'}`),
      ),
    );
  }
}

// --- shell: tabs, hook, boot ------------------------------------------------

const VIEWS = ['workout', 'history', 'exercises', 'progress'] as const;
type ViewName = (typeof VIEWS)[number];

let activeView: ViewName = 'workout';

function showTab(name: ViewName): void {
  activeView = name;
  for (const v of VIEWS) {
    const section = document.getElementById(`view-${v}`);
    const btn = document.getElementById(`tab-${v}`);
    if (!section || !btn) continue;
    section.hidden = v !== activeView;
    btn.setAttribute('aria-pressed', String(v === activeView));
  }
}

function renderAll(): void {
  renderProfiles();
  for (const v of VIEWS) {
    const section = document.getElementById(`view-${v}`);
    if (!section) continue;
    if (v === 'workout') renderWorkoutTab(section);
    else if (v === 'history') renderHistoryTab(section);
    else if (v === 'exercises') renderExercisesTab(section);
    else renderProgressTab(section);
  }
  showTab(activeView);
}

function renderProfiles(): void {
  const select = document.getElementById('profile-select') as HTMLSelectElement | null;
  if (!select) return;
  select.replaceChildren(...profiles.map((profile) =>
    el('option', { value: profile.id }, profile.name),
  ));
  select.value = activeProfile;
}

function openManageUsersDialog(): void {
  const dialog = el('dialog');
  const list = el('fieldset', { class: 'stack' });
  const choices = profiles.map((profile) => {
    const radio = el('input', { type: 'radio', name: 'manage-user', value: profile.id }) as HTMLInputElement;
    radio.checked = profile.id === activeProfile;
    list.append(el('label', {}, radio, ` ${profile.name}${profile.id === DEFAULT_PROFILE ? ' (default)' : ''}`));
    return radio;
  });
  const addName = el('input', { id: 'profile-name', type: 'text', value: '' });
  const renameName = el('input', {
    id: 'rename-profile-name',
    type: 'text',
    value: profiles.find((profile) => profile.id === activeProfile)?.name ?? '',
  });
  for (const radio of choices) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      renameName.value = profiles.find((profile) => profile.id === radio.value)?.name ?? '';
    });
  }

  const addAction = async (): Promise<void> => {
    const trimmed = addName.value.trim();
    if (!trimmed) {
      snack('Enter a user name', 'WARNING');
      return;
    }
    const profile: Profile = { id: newId(), name: trimmed };
    await PluginAPI.persistDataSynced(JSON.stringify(profile), PROFILE_PREFIX + profile.id);
    profiles = [...profiles, profile];
    activeProfile = profile.id;
    selectedPlanId = null;
    await loadStore(profile.id);
    closeDialog(dialog);
    renderAll();
  };

  const renameAction = async (): Promise<void> => {
    const selected = choices.find((radio) => radio.checked)?.value;
    const profile = profiles.find((item) => item.id === selected);
    const trimmed = renameName.value.trim();
    if (!profile || !trimmed) {
      snack(profile ? 'Enter a user name' : 'Select a user', 'WARNING');
      return;
    }
    await PluginAPI.persistDataSynced(JSON.stringify({ id: profile.id, name: trimmed }), PROFILE_PREFIX + profile.id);
    profile.name = trimmed;
    closeDialog(dialog);
    renderAll();
  };

  const deleteAction = async (): Promise<void> => {
    const selected = choices.find((radio) => radio.checked)?.value;
    if (!selected || selected === DEFAULT_PROFILE) {
      snack(selected === DEFAULT_PROFILE ? 'The default My workouts profile cannot be deleted' : 'Select a user', 'WARNING');
      return;
    }
    const profile = profiles.find((item) => item.id === selected);
    if (!profile) return;
    const result = await PluginAPI.openDialog({
      title: 'Delete user',
      content: `Permanently delete "${profile.name}" and that user's workouts and profile exercise overrides? Shared exercise definitions and other users remain.`,
      buttons: [{ label: 'Cancel' }, { label: 'Delete user', color: 'warn', raised: true }],
    });
    if (result !== 'Delete user') return;
    const keys = await PluginAPI.listSyncedDataKeys();
    for (const key of keys) {
      if (key === PROFILE_PREFIX + selected ||
          key.startsWith(`user:${selected}:plan:`) ||
          key.startsWith(`user:${selected}:ex:`)) {
        await PluginAPI.persistDataSynced('', key);
      }
    }
    profiles = profiles.filter((item) => item.id !== selected);
    if (activeProfile === selected) {
      activeProfile = DEFAULT_PROFILE;
      await loadStore(DEFAULT_PROFILE);
    }
    closeDialog(dialog);
    renderAll();
  };

  dialog.append(el('div', { class: 'stack' },
    el('h2', {}, 'Manage users'),
    el('h3', {}, 'Users'),
    list,
    el('h3', {}, 'Add user'),
    dialogForm(dialog, field('Name', addName), 'Add user', addAction),
  ));
  dialog.append(el('div', { class: 'stack' },
    el('h3', {}, 'Rename selected user'),
    field('Name', renameName),
    el('div', { class: 'actions' },
      el('button', { class: 'btn-primary', type: 'button', onclick: () => void perform(renameAction) }, 'Rename user'),
      el('button', { class: 'btn-danger', type: 'button', onclick: () => void perform(deleteAction) }, 'Delete user'),
      el('button', { class: 'btn-text', type: 'button', onclick: () => closeDialog(dialog) }, 'Close'),
    ),
  ));
  showDialog(dialog);
}

async function boot(): Promise<void> {
  const unreadable = await loadStore();
  if (storageSupported && unreadable === 0 && activeProfile === DEFAULT_PROFILE) {
    await seedDefaults();
  }
  const today = document.getElementById('today');
  if (today) today.textContent = await todayStr();
  renderAll();
}

for (const v of VIEWS) {
  document.getElementById(`tab-${v}`)?.addEventListener('click', () => showTab(v));
}

document.getElementById('profile-select')?.addEventListener('change', (event) => {
  const select = event.currentTarget as HTMLSelectElement;
  if (busy) {
    select.value = activeProfile;
    snack('Please wait for the current action to finish', 'INFO');
    return;
  }
  const id = select.value;
  void perform(async () => {
    try {
      await loadStore(id);
    } catch (e) {
      select.value = activeProfile;
      throw e;
    }
    activeProfile = id;
    selectedPlanId = null;
    renderAll();
    showTab('workout');
  });
});
document.getElementById('manage-users')?.addEventListener('click', () => openManageUsersDialog());

if (typeof PluginAPI.registerHook === 'function') {
  PluginAPI.registerHook(PluginAPI.Hooks.PERSISTED_DATA_CHANGED, () => {
    void refresh();
  });
}

if (typeof PluginAPI.onReady === 'function') {
  PluginAPI.onReady(() => void perform(boot));
} else {
  void perform(boot);
}
