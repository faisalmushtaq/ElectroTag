// Before the study starts: the settings a study confirms before its first study recording is saved, in words
// (js/admin/preregistration.js), the agreement form's note and the summary of an analysis (js/admin/analyses.js,
// model.js), the checks of the settings block, and the sandbox's answers (demo_preregistration.js, as
// electrotag/web/preregistration.py; api_contract_parity.test.mjs compares them with the study server's).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DemoBackend } from '../../electrotag/web/static/js/api/demo.js';
import { DEFAULT_SETTINGS } from '../../electrotag/web/static/js/api/demo_catalogue.js';
import { currentValues, studyStartedAt } from '../../electrotag/web/static/js/api/demo_preregistration.js';
import { defaultAnalysisConfig, settingsProblems } from '../../electrotag/web/static/js/admin/model.js';
import { PREREGISTERED_AGREEMENT_KEYS, expertSettingsProblems } from '../../electrotag/web/static/js/admin/settings_checks.js';
import { confirmedText, preregText, stateChip } from '../../electrotag/web/static/js/admin/preregistration.js';
import { preregNoteText, preregSummaryRow } from '../../electrotag/web/static/js/admin/analyses.js';

const memory = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), remove: (k) => m.delete(k) };
};

async function demo() {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login('ADMIN', 'demo');
  return b;
}

const agreement = () => Object.fromEntries(PREREGISTERED_AGREEMENT_KEYS.map((k) => [k, defaultAnalysisConfig()[k]]));

test('the settings block: working time active_s by default, and agreement settings checked as the analysis checks them', () => {
  assert.deepEqual(DEFAULT_SETTINGS.preregistration, { agreement: null, working_time: 'active_s' });
  assert.deepEqual(settingsProblems(DEFAULT_SETTINGS), []);
  assert.deepEqual(expertSettingsProblems(DEFAULT_SETTINGS), []);
  const with_ = (pr) => expertSettingsProblems({ ...DEFAULT_SETTINGS, preregistration: { ...DEFAULT_SETTINGS.preregistration, ...pr } });
  assert.deepEqual(with_({ working_time: 'wall_s', agreement: agreement() }), []);
  assert.match(with_({ working_time: 'hours' })[0], /active_s .* or wall_s/);
  assert.match(with_({ agreement: { modes: ['standard'] } })[0], /no setting modes/);
  assert.match(with_({ agreement: { min_bin_coverage: 2 } })[0], /Bin coverage needed is between 0 and 1/);
  assert.match(with_({ agreement: [] })[0], /a block of settings/);
});

test('each group in words, with its state and who confirmed it', () => {
  assert.match(preregText('agreement', null), /Not saved yet/);
  assert.equal(preregText('agreement', agreement()),
    'Time bins of 0.01, 0.05, 0.1 s with bin coverage 0.5; events matched by overlap (IoU 0, 0.2, 0.5, main 0.2), one-to-one; compared by time only; every artifact category.');
  assert.match(preregText('agreement', { ...agreement(), match_criterion: 'tolerance', allow_many_to_one: true, categories: ['EMG-artifact'] }),
    /by start and end within 0.5 s and 0.5 s, many-to-one; compared by time only; 1 artifact category\.$/);
  assert.match(preregText('working_time', { measure: 'active_s', idle_after_s: 30 }), /^Active time \(active_s\): idle time beyond 30 s/);
  assert.match(preregText('working_time', { measure: 'wall_s', idle_after_s: 60 }), /^Wall-clock time \(wall_s\).*beyond 60 s/);
  assert.equal(preregText('repeats', { enabled: false, rules: [] }), 'Off: no recording is rated again.');
  assert.equal(preregText('repeats', { enabled: true, rules: [{ id: 'a', recordings: 'all', repeats: 1, interval_days: 14 }] }),
    'On. Every recording not covered by a rule above: rated once more, 14 days after the first rating.');
  assert.deepEqual(stateChip({ state: 'confirmed' }), ['Confirmed', 'done']);
  assert.deepEqual(stateChip({ state: 'changed' }), ['Changed since confirmed', 'warning']);
  assert.deepEqual(stateChip({ state: 'not_confirmed' }), ['Not confirmed', 'warning']);
  assert.equal(confirmedText({ state: 'not_confirmed' }), '');
  const at = '2026-11-01T10:00:00.000+00:00';
  assert.match(confirmedText({ state: 'confirmed', confirmed_by: 'ADMIN', confirmed_at: at, before_start: true }), /^Confirmed by ADMIN \(1 Nov 2026, \d\d:\d\d\), before the study started\.$/);
  assert.match(confirmedText({ state: 'changed', confirmed_by: 'ADMIN', confirmed_at: at, before_start: false }), /^Last confirmed by ADMIN \(.*\), after the study started\.$/);
});

test('the agreement form says what it starts from, and a report says whether it used the pre-registered settings', () => {
  assert.match(preregNoteText(null), /analysis's defaults/);
  assert.match(preregNoteText({ values: agreement(), state: 'not_confirmed' }), /saved settings, not confirmed yet/);
  assert.match(preregNoteText({ values: agreement(), state: 'changed' }), /changed since they were confirmed/);
  assert.match(preregNoteText({ values: agreement(), state: 'confirmed', confirmed_by: 'ADMIN', confirmed_at: '2026-11-12T10:00:00+00:00' }),
    /pre-registered settings, confirmed by ADMIN.*marked as exploratory/);
  const row = (p) => preregSummaryRow({ preregistration: p }) || undefined;
  assert.match(row({ state: 'matches', differs: [] })[1], /^Used/);
  assert.equal(row({ state: 'differs', differs: ['resolutions_s', 'match_criterion'] })[1], 'Not used: resolutions_s, match_criterion differ, so this analysis is exploratory');
  assert.match(row({ state: 'not_saved', differs: [] })[1], /None saved yet/);
  assert.equal(row(undefined), undefined, 'an older study says nothing');
});

test('the sandbox: each group confirmed with its values, shown as changed when they change, and audited', async () => {
  const b = await demo();
  let st = await b.admin('preregistration_get');
  assert.deepEqual(st.items.map((i) => [i.item, i.state, i.ready]), [['agreement', 'not_confirmed', false], ['working_time', 'not_confirmed', true],
    ['repeats', 'not_confirmed', true], ['training', 'not_confirmed', true]]);
  assert.equal(st.done, false);
  assert.equal(st.study_started_at, null);
  await assert.rejects(() => b.admin('preregistration_confirm', { item: 'agreement' }), (e) => e.status === 409 && e.code === 'not_saved');
  await assert.rejects(() => b.admin('preregistration_confirm', { item: 'everything' }), (e) => e.status === 400 && e.code === 'bad_request');

  await b.admin('settings_update', { settings: { preregistration: { agreement: { resolutions_s: [0.5, 1] } } } });
  st = await b.admin('preregistration_get');
  assert.deepEqual(st.items[0].values, { ...agreement(), resolutions_s: [0.5, 1] }, 'the rest as the analysis\'s defaults');
  for (const item of ['agreement', 'working_time', 'repeats', 'training']) st = await b.admin('preregistration_confirm', { item });
  assert.equal(st.done, true);
  assert.deepEqual(st.items.map((i) => [i.confirmed_by, i.before_start]), [['ADMIN', true], ['ADMIN', true], ['ADMIN', true], ['ADMIN', true]]);
  assert.deepEqual(st.items[1].confirmed_values, { measure: 'active_s', idle_after_s: 30 });
  const log = (await b.admin('audit', { limit: 4 })).entries.map((e) => [e.op, e.summary]);
  assert.deepEqual(log, [['preregistration_confirm', 'Confirmed the training standards'], ['preregistration_confirm', 'Confirmed the repeat ratings'], ['preregistration_confirm', 'Confirmed the measure of working time'],
    ['preregistration_confirm', 'Confirmed the agreement settings']]);
  const n = (await b.admin('audit', { limit: 50 })).entries.length;
  await b.admin('preregistration_confirm', { item: 'repeats' });
  assert.equal((await b.admin('audit', { limit: 50 })).entries.length, n, 'confirmed again with the same values: nothing new');

  // the idle threshold is part of working time: changed, it asks to be confirmed again
  await b.admin('settings_update', { settings: { logging: { idle_after_s: 60 } } });
  st = await b.admin('preregistration_get');
  assert.deepEqual(st.items.map((i) => i.state), ['confirmed', 'changed', 'confirmed', 'confirmed']);
  assert.equal(st.done, false);
  st = await b.admin('preregistration_confirm', { item: 'working_time' });
  assert.equal(st.items[1].state, 'confirmed');

  // the training standards: the sandbox's own set with its pass mark and criteria, as Training shows them
  const training = st.items[3];
  const { sets } = await b.admin('sets_list');
  assert.deepEqual(training.values.sets.map((x) => [x.set_id, x.criteria]), sets.map((x) => [x.set_id, x.criteria]));
  await b.admin('set_update', { set_id: sets[0].set_id, practice_pass: { event_f1: 0.9, label_accuracy: 0.8 } });
  st = await b.admin('preregistration_get');
  assert.equal(st.items[3].state, 'changed');
  assert.equal(st.items[3].values.sets[0].practice_pass.event_f1, 0.9);
});

test('the training standards in words, and the study without training', () => {
  const policy = { skippable: ['tour', 'snippets', 'guided', 'practice'], gate: 'met', tour: true, snippets_quiz_required: false };
  assert.match(preregText('training', { policy, sets: [] }), /^No training sets\. Confirm this if the study uses no training/);
  const set = (criteria, n = 2) => ({ set_id: 'pilot', name: 'Pilot set', assessment_recordings: n, practice_pass: { event_f1: 0.8, label_accuracy: 0.75 }, criteria });
  assert.equal(preregText('training', { policy, sets: [set({ criteria: [{ metric: 'event_f1', threshold: 0.7, scope: 'overall' },
    { metric: 'false_positives_per_min', threshold: 2, scope: 'overall' }, { metric: 'time_kappa', threshold: 0.6, scope: 'each_category' }], min_reference_events: 3 })] }),
  'Pilot set: practice passes at 80% score and 75% right type; 2 assessment recordings; passing needs event F1 at least 0.7, extra events per minute at most 2, '
    + 'Cohen\'s kappa at least 0.6 in each category (categories with at least 3 reference events). Study work waits until the competency assessment is passed. '
    + 'Trainees may skip the tour, the snippets, learning with the experts, practice.');
  assert.match(preregText('training', { policy: { ...policy, skippable: [], gate: 'off' }, sets: [set({ criteria: [] }, 0)] }),
    /no assessment recordings yet; no competency criteria ticked, so its assessment reports results without a pass or fail\. Study work is open at once\. Trainees may skip no stage\.$/);
});

test('the study starts with its first research annotation, and confirmations after it say so', () => {
  assert.equal(studyStartedAt([]), null);
  assert.equal(studyStartedAt([{ mode: 'practice', saved_at: '2026-11-01T09:00:00+00:00' }, { mode: 'standard', saved_at: '2026-11-03T09:00:00+00:00' },
    { saved_at: '2026-11-02T09:00:00+01:00' }]), '2026-11-02T09:00:00+01:00');
  const v = currentValues({ ...DEFAULT_SETTINGS, repeats: { enabled: true, rules: [{ id: 'a', name: ' Pilot ', recordings: 'some', datasets: ['p', 'p'], repeats: 2, interval_days: 7 }] } });
  assert.deepEqual(v.repeats.rules[0], { id: 'a', name: 'Pilot', recordings: 'some', datasets: ['p'], recording_ids: [], repeats: 2, interval_days: 7 });
  assert.equal(v.agreement, null);
});
