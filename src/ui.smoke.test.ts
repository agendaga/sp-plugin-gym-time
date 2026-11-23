/**
 * UI smoke test: runs the real compiled UI (dist-test/ui.js) inside jsdom
 * against a stub in-memory PluginAPI, and drives the main flows end to end.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test, before } from 'node:test';
import { JSDOM } from 'jsdom';

const mem: Record<string, string> = {};
const registeredHooks: Array<{ hook: string; fn: () => void }> = [];
const snacks: Array<{ msg: string; type?: string }> = [];
let failNextPersist = false;
let blockNextPersist = false;
let releasePersist: (() => void) | undefined;
let confirmDialog = true;
let JSEvent: typeof Event;
let displayOf: (element: Element) => string;

const stubAPI = {
  Hooks: { PERSISTED_DATA_CHANGED: 'persistedDataChanged' },
  async listSyncedDataKeys(): Promise<string[]> {
    return Object.keys(mem).filter((k) => mem[k] !== '');
  },
  async loadSyncedData(key: string): Promise<string | null> {
    return mem[key] ?? null;
  },
  async persistDataSynced(data: string, key?: string): Promise<void> {
    if (failNextPersist) {
      failNextPersist = false;
      throw new Error('simulated storage failure');
    }
    if (blockNextPersist) {
      blockNextPersist = false;
      await new Promise<void>((resolve) => { releasePersist = resolve; });
    }
    mem[key ?? 'legacy'] = data;
  },
  async getDayContext(): Promise<{ todayStr: string; startOfNextDayDiffMs: number }> {
    return { todayStr: '2026-11-22', startOfNextDayDiffMs: 0 };
  },
  showSnack(cfg: { msg: string; type?: string }): void {
    snacks.push(cfg);
  },
  async openDialog(cfg: { buttons: Array<{ label: string }> }): Promise<string | undefined> {
    return confirmDialog ? cfg.buttons[cfg.buttons.length - 1]?.label : cfg.buttons[0]?.label;
  },
  registerHook(hook: string, fn: () => void): void {
    registeredHooks.push({ hook, fn });
  },
  onReady(fn: () => void): void {
    queueMicrotask(fn);
  },
};

before(async () => {
  const shell = readFileSync(new URL('../src/index.template.html', import.meta.url), 'utf8').replace(
    '<!--APP_SCRIPT-->',
    '',
  );
  const dom = new JSDOM(shell, { url: 'https://localhost/' });
  const hostStyles = dom.window.document.createElement('style');
  hostStyles.textContent = '.stack { display: flex; }';
  dom.window.document.head.append(hostStyles);
  displayOf = (element) => dom.window.getComputedStyle(element).display;
  const dialogProto = dom.window.HTMLDialogElement.prototype as unknown as Record<string, (() => void) | undefined>;
  dialogProto['showModal'] ??= function (this: HTMLElement) {
    this.setAttribute('open', '');
  };
  dialogProto['close'] ??= function (this: HTMLElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new dom.window.Event('close'));
  };
  (globalThis as Record<string, unknown>)['document'] = dom.window.document;
  (globalThis as Record<string, unknown>)['PluginAPI'] = stubAPI;
  JSEvent = dom.window.Event;

  await import('./ui.js');
  // Flush onReady -> boot -> renderAll.
  await new Promise((resolve) => setImmediate(resolve));
});

function view(name: string): HTMLElement {
  const el = document.getElementById(`view-${name}`);
  assert.ok(el, `missing #view-${name}`);
  return el;
}

function buttonsIn(root: HTMLElement | HTMLDialogElement, label: string): HTMLButtonElement[] {
  return [...root.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
}

function lastDialog(): HTMLDialogElement {
  const dialogs = document.querySelectorAll('dialog');
  const last = dialogs[dialogs.length - 1];
  assert.ok(last, 'expected an open dialog');
  return last;
}

function submitDialog(dialog: HTMLDialogElement): Promise<void> {
  const form = dialog.querySelector('form');
  assert.ok(form, 'dialog has a form');
  form.dispatchEvent(new JSEvent('submit'));
  return flush();
}

// UI handlers are async; let their awaits and re-render settle.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function planRecords(): Array<{ id: string; day: string; exercises: Array<{ exerciseId: string; targetReps: number; weight: number; loggedSets: Array<{ reps: number; weight: number; rir: number }>; isComplete: boolean }> }> {
  return Object.keys(mem)
    .filter((k) => k.startsWith('plan:') && mem[k] !== '')
    .map((k) => JSON.parse(mem[k]!));
}

test('boots, seeds the six default exercises and renders an empty workout', () => {
  const exKeys = Object.keys(mem).filter((k) => k.startsWith('ex:'));
  assert.equal(exKeys.length, 6);
  assert.ok(view('workout').textContent?.includes('No plan yet'));
  assert.equal(document.getElementById('today')?.textContent, '2026-11-22');
  assert.equal(registeredHooks[0]?.hook, 'persistedDataChanged');
});

test('navigation hides inactive views even when the host styles stack as flex', () => {
  assert.notEqual(displayOf(view('workout')), 'none');
  assert.equal(displayOf(view('history')), 'none');
  assert.equal(displayOf(view('exercises')), 'none');
  document.getElementById('tab-exercises')!.click();
  assert.equal(displayOf(view('workout')), 'none');
  assert.notEqual(displayOf(view('exercises')), 'none');
  assert.equal(document.getElementById('tab-exercises')!.getAttribute('aria-pressed'), 'true');
  document.getElementById('tab-workout')!.click();
});

test('closing a dialog removes it instead of leaving it below the page', () => {
  document.getElementById('manage-users')!.click();
  const dialog = lastDialog();
  assert.ok(dialog.hasAttribute('open'));
  buttonsIn(dialog, 'Close')[0]!.click();
  assert.equal(document.contains(dialog), false);
});

test('user switcher is clearly labelled', () => {
  const label = document.querySelector('label[for="profile-select"]');
  assert.equal(label?.textContent, 'Switch user');
});

test('exercises tab lists the defaults with overload and plateau state', () => {
  const items = view('exercises').querySelectorAll('.list-item');
  assert.equal(items.length, 6);
  assert.ok(view('exercises').textContent?.includes('Back Squat'));
  assert.ok(view('exercises').textContent?.includes('+2.5%'));
  assert.ok(view('exercises').textContent?.includes('Not enough data'));
});

test('adding a custom exercise persists under the shared exercise key', async () => {
  buttonsIn(view('exercises'), 'Add exercise')[0]!.click();
  const dialog = lastDialog();
  const name = dialog.querySelector('input[id^=name-]') as HTMLInputElement;
  const muscle = dialog.querySelector('input[id^=muscle-]') as HTMLInputElement;
  const overload = dialog.querySelector('input[id^=overload-]') as HTMLInputElement;
  name.value = 'Cable Fly';
  muscle.value = 'Chest';
  overload.value = '3';
  await submitDialog(dialog);
  const exKeys = Object.keys(mem).filter((k) => k.startsWith('ex:'));
  assert.equal(exKeys.length, 7);
  assert.ok(Object.keys(mem).some((key) => key.startsWith('ex:') && key !== 'ex:Cable Fly'));
  assert.ok(view('exercises').textContent?.includes('Cable Fly'));
});

test('generating a plan creates a plan record and workout cards', async () => {
  buttonsIn(view('workout'), 'Generate next workout')[0]!.click();
  const dialog = lastDialog();
  const boxes = [...dialog.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[];
  assert.equal(boxes.length, 7);
  for (const b of boxes) b.checked = true;
  await submitDialog(dialog);
  const plans = planRecords();
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.day, '2026-11-22');
  assert.equal(view('workout').querySelectorAll('.card').length, 7);
  // The planned line shows the ORM the prescription implies at the default RIR 1:
  // Back Squat 3×8 @ 60 kg (Epley) = 60·(1+9/30) = 78 kg.
  assert.ok(view('workout').textContent?.includes('3 × 8 @ 60 kg · ORM 78 kg'));
  const row = plans[0]!.exercises.find((e) => e.exerciseId === 'barbell-row');
  assert.deepEqual(
    { targetReps: row!.targetReps, weight: row!.weight, loggedSets: row!.loggedSets, isComplete: row!.isComplete },
    { targetReps: 10, weight: 45, loggedSets: [], isComplete: false },
  );
});

test('empty inputs are rejected instead of silently recorded', async () => {
  const card = view('workout').querySelector('.card') as HTMLElement;
  const reps = card.querySelector('input[aria-label=Reps]') as HTMLInputElement;
  reps.value = '';
  buttonsIn(card, 'Log set')[0]!.click();
  await flush();
  const sets = planRecords().flatMap((p) => p.exercises.flatMap((e) => e.loggedSets));
  assert.equal(sets.length, 0);
  assert.ok(snacks[snacks.length - 1]?.msg.includes('Enter reps, weight and RIR'));
  // A cleared RIR input is rejected the same way.
  reps.value = '8';
  const rir = card.querySelector('input[aria-label^="RIR"]') as HTMLInputElement;
  rir.value = '';
  buttonsIn(card, 'Log set')[0]!.click();
  await flush();
  assert.equal(planRecords().flatMap((p) => p.exercises.flatMap((e) => e.loggedSets)).length, 0);
});

test('a failed set save rolls back before retrying', async () => {
  const card = view('workout').querySelectorAll('.card')[1] as HTMLElement;
  failNextPersist = true;
  buttonsIn(card, 'Log set')[0]!.click();
  await flush();
  assert.equal(planRecords().flatMap((p) => p.exercises.flatMap((e) => e.loggedSets)).length, 0);
  assert.ok(snacks[snacks.length - 1]?.msg.includes('Could not save the set'));

  buttonsIn(card, 'Log set')[0]!.click();
  await flush();
  const secondExerciseSets = planRecords()[0]!.exercises[1]!.loggedSets;
  assert.equal(secondExerciseSets.length, 1);
});

test('logging a set records the RIR input, defaulting to 1', async () => {
  const card = view('workout').querySelector('.card') as HTMLElement;
  const reps = card.querySelector('input[aria-label=Reps]') as HTMLInputElement;
  const rir = card.querySelector('input[aria-label^="RIR"]') as HTMLInputElement;
  assert.equal(rir.value, '1'); // The input defaults to RIR 1 for every set.
  reps.value = '99';
  rir.value = '2';
  buttonsIn(card, 'Log set')[0]!.click();
  await flush();
  const squat = planRecords()[0]!.exercises.find((e) => e.exerciseId === 'squat')!;
  assert.equal(squat.loggedSets.length, 1);
  const [set] = squat.loggedSets;
  assert.equal(set!.reps, 99);
  assert.equal(set!.rir, 2);
  // First card is Back Squat (alphabetical), prescribed at 60 kg.
  assert.ok(view('workout').textContent?.includes('99×60 kg @ RIR 2'));
  // After the re-render the next set starts from the default again.
  const freshRir = view('workout').querySelector('.card')
    ?.querySelector('input[aria-label^="RIR"]') as HTMLInputElement;
  assert.equal(freshRir.value, '1');
});

test('a logged set chip shows its calculated ORM with a kg label', () => {
  const card = view('workout').querySelector('.card') as HTMLElement;
  const chip = card.querySelector('button[aria-label^="Remove set"]') as HTMLButtonElement;
  // 99 reps at 60 kg with RIR 2 (Lombardi): 60·(99+2)^0.10 ≈ 95.2 kg.
  assert.ok(chip.textContent?.includes('99×60 kg @ RIR 2'));
  assert.ok(chip.textContent?.includes('95.2 kg ORM'));
  assert.match(chip.getAttribute('aria-label')!, /estimated ORM 95\.2 kg$/);
  assert.ok(chip.textContent?.trim().endsWith('×')); // still removable
});

test('marking an exercise complete puts it in the progress view', async () => {
  const before = JSON.stringify(planRecords());
  buttonsIn(view('workout').querySelector('.card') as HTMLElement, 'Mark complete')[0]!.click();
  await flush();
  assert.notEqual(JSON.stringify(planRecords()), before);
  const firstCard = view('workout').querySelector('.card') as HTMLElement;
  assert.ok(firstCard.textContent?.includes('Complete'));

  const progress = view('progress');
  // Only the completed back-squat session counts: one logged set, 99 reps at
  // 60 kg with RIR 2. Lombardi (reps > 10): 60·(99+2)^0.10 ≈ 95.2 kg.
  assert.ok(progress.textContent?.includes('Completed sessions: 1'));
  assert.ok(progress.textContent?.includes('Best estimated ORM: 95.2 kg'));
  assert.ok(progress.textContent?.includes('Last session ORM: 95.2 kg'));
  assert.ok(progress.textContent?.includes('Best set: 99×60 kg @ RIR 2'));
  assert.ok(!progress.textContent?.includes('Total volume'));
  // Every other exercise still shows zero completed sessions.
  assert.equal(progress.textContent?.split('Completed sessions: 0').length, 7); // 6 remaining exercises
});

test('incomplete planned work stays out of the progress view', async () => {
  // A second card is logged but never completed.
  const cards = view('workout').querySelectorAll('.card');
  const second = cards[1] as HTMLElement;
  buttonsIn(second, 'Log set')[0]!.click();
  await flush();
  const progress = view('progress');
  assert.ok(progress.textContent?.includes('Completed sessions: 1'));
  assert.ok(!progress.textContent?.includes('Completed sessions: 2'));
});

test('the progress graph shows session ORM and skips incomplete work', () => {
  document.getElementById('tab-progress')!.click();
  const cards = [...view('progress').querySelectorAll('.card')] as HTMLElement[];
  const squat = cards.find((c) => c.querySelector('h3')?.textContent === 'Back Squat')!;
  // One completed session so far: a single centered point, no broken scale.
  const dots = squat.querySelectorAll('circle[data-orm]');
  assert.equal(dots.length, 1);
  assert.equal(dots[0]!.getAttribute('data-orm'), '95.2');
  assert.equal(dots[0]!.getAttribute('data-day'), '2026-11-22');
  assert.match(squat.querySelector('svg')!.getAttribute('aria-label')!, /1 completed session/);

  // The logged-but-incomplete bench session contributes no graph point.
  const bench = cards.find((c) => c.querySelector('h3')?.textContent === 'Bench Press')!;
  assert.equal(bench.querySelectorAll('svg').length, 0);
  assert.ok(bench.textContent?.includes('No completed sessions yet'));
  // Plateau wording is gone from this tab.
  assert.ok(!view('progress').textContent?.includes('plateau'));
  document.getElementById('tab-workout')!.click();
});

test('history opens older workouts for date and set edits', async () => {
  const date = view('workout').querySelector('input[aria-label="Workout date"]') as HTMLInputElement;
  date.value = '2026-11-18';
  buttonsIn(view('workout'), 'Save date')[0]!.click();
  await flush();
  assert.equal(planRecords()[0]!.day, '2026-11-18');

  buttonsIn(view('workout'), 'Generate next workout')[0]!.click();
  const dialog = lastDialog();
  await submitDialog(dialog);
  assert.equal(planRecords().length, 2);

  document.getElementById('tab-history')!.click();
  const rows = view('history').querySelectorAll('li');
  assert.equal(rows.length, 2);
  assert.ok(rows[1]!.textContent?.includes('2026-11-18'));
  buttonsIn(rows[1] as HTMLElement, 'View / edit')[0]!.click();
  assert.equal(displayOf(view('history')), 'none');
  const historicalDate = view('workout').querySelector('input[aria-label="Workout date"]') as HTMLInputElement;
  assert.equal(historicalDate.value, '2026-11-18');
  const card = view('workout').querySelector('.card') as HTMLElement;
  const chip = card.querySelector('button[aria-label^="Remove set"]') as HTMLButtonElement;
  failNextPersist = true;
  chip.click();
  await flush();
  assert.equal(planRecords()[0]!.exercises[0]!.loggedSets.length, 1);
  assert.ok(snacks[snacks.length - 1]?.msg.includes('Could not complete the action'));
  chip.click();
  await flush();
  assert.equal(planRecords()[0]!.exercises[0]!.loggedSets.length, 0);
  assert.ok(!view('progress').textContent?.includes('Best set: 99×60 kg @ RIR 2'));
  const updatedCard = view('workout').querySelector('.card') as HTMLElement;
  buttonsIn(updatedCard, 'Log set')[0]!.click();
  await flush();
  assert.equal(planRecords()[0]!.exercises[0]!.loggedSets.length, 1);
  const secondCard = view('workout').querySelectorAll('.card')[1] as HTMLElement;
  const exerciseCount = planRecords()[0]!.exercises.length;
  (secondCard.querySelector('button[aria-label="Remove from plan"]') as HTMLButtonElement).click();
  await flush();
  assert.equal(planRecords()[0]!.exercises.length, exerciseCount - 1);
  buttonsIn(view('workout'), 'Add exercise')[0]!.click();
  await submitDialog(lastDialog());
  assert.equal(planRecords()[0]!.exercises.length, exerciseCount);
});

test('users have separate exercises, history, and progress while legacy data remains accessible', async () => {
  const originalPlans = JSON.stringify(planRecords());
  document.getElementById('manage-users')!.click();
  const dialog = lastDialog();
  (dialog.querySelector('#profile-name') as HTMLInputElement).value = 'Coached lifter';
  await submitDialog(dialog);
  const select = document.getElementById('profile-select') as HTMLSelectElement;
  const otherId = select.value;
  assert.notEqual(otherId, 'default');
  assert.ok(view('workout').textContent?.includes('No plan yet'));
  assert.equal(view('history').querySelectorAll('li').length, 0);
  assert.equal(view('exercises').querySelectorAll('.list-item').length, 7);

  buttonsIn(view('exercises'), 'Add exercise')[0]!.click();
  const exerciseDialog = lastDialog();
  (exerciseDialog.querySelector('input[id^=name-]') as HTMLInputElement).value = 'Client squat';
  await submitDialog(exerciseDialog);
  buttonsIn(view('workout'), 'Generate next workout')[0]!.click();
  const generateDialog = lastDialog();
  (generateDialog.querySelector('input[type=checkbox]') as HTMLInputElement).checked = true;
  await submitDialog(generateDialog);
  const clientCard = view('workout').querySelector('.card') as HTMLElement;
  buttonsIn(clientCard, 'Log set')[0]!.click();
  await flush();
  buttonsIn(view('workout').querySelector('.card') as HTMLElement, 'Mark complete')[0]!.click();
  await flush();
  assert.ok(view('progress').textContent?.includes('Completed sessions: 1'));
  assert.equal(JSON.stringify(planRecords()), originalPlans);
  assert.ok(Object.keys(mem).some((key) => key.startsWith(`user:${otherId}:plan:`)));

  select.value = 'default';
  select.dispatchEvent(new JSEvent('change'));
  await flush();
  assert.equal(view('history').querySelectorAll('li').length, 2);
  assert.ok(view('exercises').textContent?.includes('Cable Fly'));
  assert.ok(view('exercises').textContent?.includes('Client squat'));
  select.value = otherId;
  select.dispatchEvent(new JSEvent('change'));
  await flush();
  assert.equal(view('history').querySelectorAll('li').length, 1);
  assert.ok(view('exercises').textContent?.includes('Client squat'));
  assert.ok(view('progress').textContent?.includes('Completed sessions: 1'));
  document.getElementById('manage-users')!.click();
  const renameDialog = lastDialog();
  (renameDialog.querySelector('#rename-profile-name') as HTMLInputElement).value = 'Client';
  buttonsIn(renameDialog, 'Rename user')[0]!.click();
  await flush();
  assert.equal(select.selectedOptions[0]!.textContent, 'Client');
  registeredHooks[0]!.fn();
  await flush();
  assert.equal((document.getElementById('profile-select') as HTMLSelectElement).value, otherId);
  assert.equal(select.selectedOptions[0]!.textContent, 'Client');
  assert.equal(view('history').querySelectorAll('li').length, 1);
});

test('switching users during a pending save cannot write into another profile', async () => {
  const select = document.getElementById('profile-select') as HTMLSelectElement;
  const otherId = select.value;
  const originalPlans = JSON.stringify(planRecords());
  blockNextPersist = true;
  buttonsIn(view('workout').querySelector('.card') as HTMLElement, 'Log set')[0]!.click();
  await flush();
  select.value = 'default';
  select.dispatchEvent(new JSEvent('change'));
  assert.equal(select.value, otherId);
  assert.ok(snacks[snacks.length - 1]?.msg.includes('Please wait'));
  assert.ok(releasePersist);
  releasePersist();
  await flush();
  assert.equal(JSON.stringify(planRecords()), originalPlans);
  const clientPlanKey = Object.keys(mem).find((key) => key.startsWith(`user:${otherId}:plan:`))!;
  const clientPlan = JSON.parse(mem[clientPlanKey]!) as { exercises: Array<{ loggedSets: unknown[] }> };
  assert.equal(clientPlan.exercises[0]!.loggedSets.length, 2);
});

test('deleting a workout requires confirmation and leaves other users untouched', async () => {
  const select = document.getElementById('profile-select') as HTMLSelectElement;
  const otherId = select.value;
  const originalPlans = JSON.stringify(planRecords());
  document.getElementById('tab-history')!.click();
  const history = view('history');

  confirmDialog = false;
  buttonsIn(history, 'Delete')[0]!.click();
  await flush();
  assert.equal(history.querySelectorAll('li').length, 1);
  confirmDialog = true;

  failNextPersist = true;
  buttonsIn(history, 'Delete')[0]!.click();
  await flush();
  assert.equal(history.querySelectorAll('li').length, 1);
  assert.ok(snacks[snacks.length - 1]?.msg.includes('Could not complete the action'));

  buttonsIn(history, 'Delete')[0]!.click();
  await flush();
  assert.equal(history.querySelectorAll('li').length, 0);
  assert.ok(view('workout').textContent?.includes('No plan yet'));
  assert.ok(view('progress').textContent?.includes('Completed sessions: 0'));
  assert.equal(JSON.stringify(planRecords()), originalPlans);
  const key = Object.keys(mem).find((item) => item.startsWith(`user:${otherId}:plan:`))!;
  assert.equal(mem[key], '');

  registeredHooks[0]!.fn();
  await flush();
  assert.equal(history.querySelectorAll('li').length, 0);
  select.value = 'default';
  select.dispatchEvent(new JSEvent('change'));
  await flush();
  assert.equal(view('history').querySelectorAll('li').length, 2);
});

test('deleting the selected workout opens a remaining workout instead', async () => {
  document.getElementById('tab-history')!.click();
  const history = view('history');
  const row = history.querySelectorAll('li')[1] as HTMLElement;
  buttonsIn(row, 'View / edit')[0]!.click();
  assert.equal(
    (view('workout').querySelector('input[aria-label="Workout date"]') as HTMLInputElement).value,
    '2026-11-18',
  );
  document.getElementById('tab-history')!.click();
  buttonsIn(history.querySelectorAll('li')[1] as HTMLElement, 'Delete')[0]!.click();
  await flush();
  assert.equal(planRecords().length, 1);
  assert.equal(history.querySelectorAll('li').length, 1);
  assert.equal(
    (view('workout').querySelector('input[aria-label="Workout date"]') as HTMLInputElement).value,
    '2026-11-22',
  );
});

test('user deletion removes only the selected profile and preserves shared exercises', async () => {
  document.getElementById('manage-users')!.click();
  const addDialog = lastDialog();
  (addDialog.querySelector('#profile-name') as HTMLInputElement).value = 'Disposable';
  await submitDialog(addDialog);

  const select = document.getElementById('profile-select') as HTMLSelectElement;
  const userId = select.value;
  mem[`user:${userId}:plan:p-disposable`] = JSON.stringify({
    id: 'p-disposable',
    day: '2026-11-22',
    exercises: [],
  });
  mem[`user:${userId}:ex:legacy`] = JSON.stringify({
    id: 'legacy',
    name: 'Legacy',
    muscleGroup: '',
    overloadPct: 2.5,
    repTarget: 8,
    targetSets: 3,
    startWeight: 40,
  });
  registeredHooks[0]!.fn();
  await flush();
  assert.ok(mem['ex:legacy']);
  assert.deepEqual(
    { targetRepMin: JSON.parse(mem['ex:legacy']!).targetRepMin, targetRepMax: JSON.parse(mem['ex:legacy']!).targetRepMax },
    { targetRepMin: 8, targetRepMax: 15 },
  );
  const sharedKeysBefore = Object.keys(mem).filter((key) => key.startsWith('ex:')).sort();

  document.getElementById('manage-users')!.click();
  const manage = lastDialog();
  confirmDialog = false;
  buttonsIn(manage, 'Delete user')[0]!.click();
  await flush();
  assert.ok(mem[`profile:${userId}`]);

  confirmDialog = true;
  buttonsIn(manage, 'Delete user')[0]!.click();
  await flush();
  assert.equal(mem[`profile:${userId}`], '');
  assert.equal(mem[`user:${userId}:plan:p-disposable`], '');
  assert.equal(mem[`user:${userId}:ex:legacy`], '');
  assert.ok(mem['ex:legacy']);
  assert.deepEqual(
    Object.keys(mem).filter((key) => key.startsWith('ex:') && mem[key] !== '').sort(),
    sharedKeysBefore,
  );
  assert.equal(select.value, 'default');
  assert.equal(document.contains(manage), false);

  document.getElementById('manage-users')!.click();
  const defaultDialog = lastDialog();
  const defaultRadio = [...defaultDialog.querySelectorAll('input[type=radio]')]
    .find((radio) => (radio as HTMLInputElement).value === 'default') as HTMLInputElement;
  defaultRadio.checked = true;
  buttonsIn(defaultDialog, 'Delete user')[0]!.click();
  await flush();
  assert.ok(snacks[snacks.length - 1]?.msg.includes('cannot be deleted'));
  buttonsIn(defaultDialog, 'Close')[0]!.click();
  assert.equal(document.contains(defaultDialog), false);
});

test('the ORM trend chart plots completed sessions chronologically', async () => {
  mem['plan:graph-1'] = JSON.stringify({
    id: 'graph-1',
    day: '2026-11-01',
    exercises: [
      {
        exerciseId: 'deadlift',
        targetReps: 5,
        targetSets: 3,
        weight: 80,
        loggedSets: [{ reps: 5, weight: 100, rir: 0 }],
        isComplete: true,
      },
      // Incomplete planned exercise with logged sets: never a graph point.
      {
        exerciseId: 'squat',
        targetReps: 8,
        targetSets: 3,
        weight: 60,
        loggedSets: [{ reps: 8, weight: 150, rir: 0 }],
        isComplete: false,
      },
    ],
  });
  mem['plan:graph-2'] = JSON.stringify({
    id: 'graph-2',
    day: '2026-11-10',
    exercises: [
      {
        exerciseId: 'deadlift',
        targetReps: 5,
        targetSets: 3,
        weight: 80,
        loggedSets: [{ reps: 3, weight: 120, rir: 0 }],
        isComplete: true,
      },
    ],
  });
  registeredHooks[0]!.fn();
  await flush();
  document.getElementById('tab-progress')!.click();
  const cards = [...view('progress').querySelectorAll('.card')] as HTMLElement[];
  const deadlift = cards.find((c) => c.querySelector('h3')?.textContent === 'Deadlift')!;
  const dots = [...deadlift.querySelectorAll('circle[data-day]')];
  // Epley with RIR 0: 100·(1+5/30) ≈ 116.7, then 120·(1+3/30) = 132, oldest first.
  assert.deepEqual(
    dots.map((d) => `${d.getAttribute('data-day')}: ${d.getAttribute('data-orm')} kg`),
    ['2026-11-01: 116.7 kg', '2026-11-10: 132 kg'],
  );
  // The incomplete squat session's 150 kg set stays out of every chart.
  const squat = cards.find((c) => c.querySelector('h3')?.textContent === 'Back Squat')!;
  assert.ok(
    ![...squat.querySelectorAll('circle[data-day]')]
      .some((d) => d.getAttribute('data-day') === '2026-11-01'),
  );

  delete mem['plan:graph-1'];
  delete mem['plan:graph-2'];
  registeredHooks[0]!.fn();
  await flush();
});
