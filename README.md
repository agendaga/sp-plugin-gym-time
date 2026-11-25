# Gym Time — Super Productivity plugin

An [iframe plugin](https://github.com/super-productivity/super-productivity/blob/master/docs/plugin-development.md)
for Super Productivity that tracks hypertrophy workouts inside the app: pick
exercises, log sets fast at the gym with reps, weight and RIR, mark planned
exercises complete, and generate the next workout from your estimated
one-rep max (ORM).

## What it does

- **Quick gym logging** — each planned exercise has reps, weight and RIR
  (reps in reserve) inputs, prefilled with the target weight and RIR 1, and a
  one-tap "Log set" button. The planned line shows the ORM the prescription
  implies at RIR 1 (`3 × 8 @ 60 kg · ORM 78 kg`). Sets appear as chips with
  their estimated ORM
  (`8×50 kg @ RIR 1 · 65 kg ORM`); click a chip to remove that set.
- **Estimated ORM per set** — every logged set gets a one-rep-max estimate
  from its reps, weight and RIR. Sets with 10 or fewer performed reps use
  **Epley**: `weight × (1 + (reps + rir) / 30)`. Sets above 10 performed reps
  use **Lombardi**: `weight × (reps + rir)^0.10` (the
  [Lombardi formula](https://www.vcalc.com/wiki/lombardi-one-1-rep-maximum),
  extended with RIR). The formula is chosen by performed reps, never by
  `reps + rir`. ORM is always derived from the logged sets; it is never
  stored as a separate field.
- **Rep-range progression** — each completed session that hits its target
  adds one rep toward that exercise's configured maximum. After the maximum
  is reached and completed again, reps reset to the configured minimum.
- **ORM-based load targets** — after every completed workout the next load
  target is that workout's best set's ORM multiplied by the exercise's
  overload percent, inverted for the next target reps (assuming RIR 1) and
  rounded to the nearest 0.5 kg. While reps are advancing, the inversion
  cancels the bump and the load holds steady; at the rep reset it produces
  the explicit load increase. The overload percent applies even when a failed
  workout keeps the same reps, because the overload target is per completed
  workout. The first workout uses the exercise's start weight.
- **Per-exercise overload and rep ranges** — every exercise definition carries
  its own overload percent, minimum and maximum target reps, set count and
  starting weight, editable any time. Custom exercises can be added and deleted.
- **ORM trend graph** — the Progress tab plots each exercise's estimated
  session ORM (its highest-ORM set per completed session) over time in a
  dependency-free SVG line chart, oldest to newest, with readable dates and
  ORM labels. It scales from zero or one completed session without a broken
  axis, and its points come only from completed plan exercises and their
  logged sets.
- **Plateau awareness** — the Workout and Exercises tabs label an exercise
  *Plateau* when its last two completed sessions both failed to beat the
  best-set ORM of the session before them. Fewer than 3 completed sessions
  shows *Not enough data* instead.
  Zero-load sessions fall back to their best `reps + rir` so bodyweight
  progress stays visible. The Progress tab shows the ORM trend graph instead
  of a plateau label.
- **Completed-only accounting** — progress views and next-workout generation
  use only planned exercises marked complete and their explicitly logged sets.
  Planned targets and incomplete work are never counted as performance.
- **Mark complete / reopen** — completing is an explicit user action per
  planned exercise; it can be undone.
- **Workout history** — open a previous workout to change its date, add or
  remove exercises, log sets, or change completion. Click a set chip to remove
  that set; to correct it, remove it and log the corrected values. Delete a
  whole workout from History after confirming the deletion.
- **Sticky header with menu and user switcher** — a sticky top header holds a
  hamburger menu (Workout, History, Exercises, Progress, Settings; selecting a
  page closes the menu) and a user selector that shows a person icon and the
  current profile's name and switches profiles.
- **Settings view** — user management (**Manage users** for add, rename and
  confirmed delete actions), the per-user kg/lb unit selector, and the workout
  split manager. **Manage users** is available only in Settings.
- **Workout splits** — per user, named groups of shared exercises. Create,
  edit and delete them in Settings. Generating a workout offers the user's
  splits plus an **All exercises** option (the default) and creates the plan
  with exactly the selected exercise set. A split whose exercises were all
  deleted shows a clear warning and generates no plan.
- **kg/lb units per user** — weights are always stored and progressed in
  canonical kilograms. The per-user unit setting converts every displayed
  weight: set inputs, prescription lines, logged set chips, ORM estimates,
  best-set labels, the progress chart axes and points, exercise start weights
  and the generation preview. Pound input converts back to kilograms (rounded
  to the nearest 0.5 kg) at each input boundary; kilogram storage and
  progression are unchanged. Switching units never rewrites workouts,
  exercises or history.
- **Users** — switch profiles with the header selector and manage them from
  **Settings → Manage users**. Workouts, splits, unit settings and progress
  stay profile-specific. Exercise definitions are shared across all profiles.

## Install

Requirements: Node.js 20.15+ (only to build and pack).

```bash
npm install
npm run pack        # builds index.html and writes plugin.zip + SHA-256
```

In Super Productivity: **Settings → Plugins → Choose Plugin File** →
`plugin.zip`. Test on a test instance first, e.g.
[test-app.super-productivity.com](https://test-app.super-productivity.com).
Reinstalling the same plugin `id` (`hypertrophy-tracker`) replaces an older
version.

## Development

```
npm run typecheck   # tsc --noEmit
npm test            # tsc + node:test: domain behavior tests + jsdom UI smoke tests
npm run build       # bundles src/ui.ts and inlines it into the shipped index.html
npm run pack        # build + zip (manifest.json, index.html, icon.svg)
```

Layout:

- `src/domain.ts` — pure domain model: types, parse/validate, ORM estimators,
  progression, plateau, completed-only assessment. No DOM, no PluginAPI.
- `src/ui.ts` — iframe UI. The only file that talks to the host bridge.
- `src/index.template.html` — HTML shell and the little custom CSS; all CSS
  and JS is inlined into the shipped `index.html` by the build.
- `src/domain.test.ts` — behavioral tests: RIR parsing and boundaries, ORM
  formulas, ORM-based load targets, rep-range progression, plateau
  classification, completed-only assessment, and parse validation.
- `src/ui.smoke.test.ts` — runs the compiled UI in jsdom against a stub
  PluginAPI and drives boot → add exercise → generate → log (with RIR) →
  complete → progress end to end.
- `scripts/pack.mjs` — dependency-free ZIP writer (Node zlib), prints SHA-256.
- `scripts/preview-harness.mjs` — writes a standalone harness page to
  `/tmp/opencode/fitness-preview.html` with an in-memory PluginAPI stub, for
  eyeballing the UI outside the host.

## Storage model

Exercise definitions are shared across every profile under `ex:<id>`. The
original **My workouts** user retains legacy `plan:<id>` workout records.
Additional users have independent `profile:<id>` metadata and
`user:<id>:plan:<id>` workout records. Legacy `user:<id>:ex:<id>` records are
promoted to `ex:<id>` shared exercise records the first time the plugin loads
them, so deleting their former profile will not remove the shared exercise.
Conflicting legacy exercise IDs use the first record encountered unless a
shared record already exists. Deleting an exercise writes an empty value for
its shared key. Synced JSON is validated at the boundary: target ranges must
be integers from 1 to 100, with `targetRepMax >= targetRepMin`. Legacy
`repTarget` records migrate to `targetRepMin=repTarget` and
`targetRepMax=15`. Logged sets store `reps`, `weight` and `rir`; sets
recorded before RIR tracking (no `rir` field) parse with RIR 1, and a present
`rir` must be an integer from 0 to 10.

Each profile's workout splits are independent records under
`split:<profileId>:<splitId>` with `{ id, name, exerciseIds }`; the split id
must match its key, the name must be non-empty, and `exerciseIds` is a list
of non-empty strings (duplicates collapse, order is kept). Each profile's
unit setting is a separate record under `settings:<profileId>` with
`{ unit: 'kg' | 'lb' }`; any other value is skipped and the profile falls
back to kg. Deleting a profile clears its `profile:`, `user:<id>:plan:`,
`user:<id>:ex:`, `settings:<id>` and `split:<id>:` records only — never
shared `ex:` records or other users' data.

The UI refreshes on the `persistedDataChanged` hook and also updates its local
state optimistically after each of its own writes, so the view is correct even
before the hook fires.

Users are organizational profiles, not separate logins or access controls.
All profiles are available to anyone with access to the same Super Productivity
data, and sync with it. Concurrent edits to the same exercise or workout on
different devices may overwrite each other. Switch users with the header
selector; the original user is selected when the plugin is reopened. Weight
units are per profile: the display converts with `1 kg = 2.2046226218 lb`,
pound values round to one decimal for display and to the nearest 0.5 kg when
entered, and canonical storage, load targets and progression stay in
kilograms regardless of the setting.

## Behavior details and tradeoffs

- **Rep-range behavior.** Recalculate from no sessions as `targetRepMin` and
  `startWeight`. Replaying completed sessions oldest to newest, success means
  at least `targetSets` sets and the lowest set reps is at least the current
  target. Success below `targetRepMax` adds one rep. Success at
  `targetRepMax` resets reps to `targetRepMin`. Failure holds the reps.
- **Load targets.** After every completed workout, the next planned weight is
  computed from that workout's best set: `targetOrm = setOrm(bestSet) ×
  (1 + overloadPct / 100)`, then the estimator matching the next target reps
  is inverted at RIR 1 and the result is rounded to the nearest 0.5 kg.
  - Within the same formula range, increasing the rep target usually offsets
    the overload bump. The change from 10 to 11 reps switches formulas, so the
    prescribed load can jump at that boundary.
  - The explicit percentage increase is kept even when a failed workout
    leaves the next target reps unchanged: the overload target is per
    completed workout.
  - The next target follows the latest completed workout's ORM directly.
    If estimated ORM falls, the prescribed weight can drop while still
    targeting the configured percentage increase. A first workout uses
    `startWeight`.
  - The prescribed load is a rounded estimate; the ORM actually achieved at
    it can differ because the RIR performed on the day is not known in
    advance.
- **Rep ranges and set safety.** Target reps must stay from 1 through 100.
  Target reps may come from `targetRepMin` through `targetRepMax`; set input
  has an independent safety maximum of 1000 reps, and RIR is bounded at
  0–10.
- **Success rule.** A session advances the exercise when it has at least
  `targetSets` logged sets whose minimum reps reach the current target.
- **ORM formulas.** Epley `weight × (1 + (reps + rir) / 30)` at 10 or fewer
  performed reps; Lombardi `weight × (reps + rir)^0.10` above that
  ([source](https://www.vcalc.com/wiki/lombardi-one-1-rep-maximum)). The
  dispatch is by performed reps, not `reps + rir`. A session's ORM is its
  highest-ORM set. Derived only from completed logged sets; never persisted.
- **Plateau.** ORM-based, comparing completed sessions only. Two consecutive
  non-improvements of the best-set ORM over the previous session = plateau.
  Zero-load exercises use the best `reps + rir` per session so bodyweight
  progress is visible. Equal scores count as non-improvement. Deliberately
  simple: it flags "nothing is going up" rather than diagnosing why. The
  label appears on the Workout and Exercises tabs; the Progress tab shows the
  per-exercise ORM trend graph instead.
- **ORM trend graph.** One point per completed session at its session ORM
  (the highest-ORM set), plotted oldest to newest in a dependency-free SVG
  line chart with per-point date and ORM labels (a `<title>` tooltip per
  point, date labels under the first and last points and, with six or fewer
  sessions, under every point). A single completed session renders as one
  centered point on a padded scale; an exercise with none shows a prompt
  instead of a chart. Points derive only from completed plan exercises and
  their logged sets; nothing about the chart is persisted.
- **Seeding.** Six default exercises are written to shared exercise storage on
  first open. Deleting every shared exercise re-seeds it on the next open.
- **Units.** Kilograms are canonical everywhere: stored sets, plan targets,
  progression and ORM math. The unit setting is a display layer. Pound
  displays round to one decimal and trim a trailing `.0`; pound inputs
  (set weight, exercise start weight) convert back and snap to the nearest
  0.5 kg so internal increments, load targets and chart data never drift.
  Kilogram input passes through unrounded. The number input step is 0.5 kg
  or a practical 0.1 lb.
- **Splits.** A split only references shared exercise ids; it never copies
  exercise definitions. Renaming or deleting a split never touches plans
  already generated from it. Generation with a split selected includes
  exactly its available exercises; split ids pointing at deleted exercises
  are skipped and, when nothing valid remains, the plugin warns and refuses
  to create an empty plan. Splits and unit settings load with the profile,
  so switching users swaps them atomically with workouts.
- **Sticky header.** The header is a card using an opaque version of the host's
  card color, so scrolling content stays hidden even with translucent themes.
  The hamburger menu stays in normal flow inside the card below its controls.
- **minSupVersion 20.1.0.** Keyed `loadSyncedData(key)` and
  `listSyncedDataKeys()` are recent additions; the plugin declares the oldest
  host that provably has them and shows a clear error if the API is missing.
  Lowering it would need a fallback to a single shared blob, which this plugin
  intentionally avoids.
- **No plugin.js.** The plugin is iframe-only (`iFrame: true`): no host-side
  code, no shortcuts, no header button. The manifest adds the menu entry.
- **No network.** `permissions` and `dataSharing` declare no hosts and no data
  leaving the device; nothing here calls out.
