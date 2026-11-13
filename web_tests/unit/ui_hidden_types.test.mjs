// The artifact types a study hides from annotators (annotation.hidden_labels): left out of the lists a type is
// chosen from in the annotation view (js/annotate/hidden_types.js, used by the session), while every type stays
// known, so that a mark that already has one keeps it; the checks of the setting (js/admin/settings_checks.js)
// and the sandbox's answers (tests/test_web_hidden_types.py has the study server's).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Catalogue, UNCERTAIN_LABEL } from '../../electrotag/web/static/js/catalogue.js';
import { CATALOGUE, DEFAULT_SETTINGS } from '../../electrotag/web/static/js/api/demo_catalogue.js';
import { DemoBackend } from '../../electrotag/web/static/js/api/demo.js';
import { withHiddenTypes } from '../../electrotag/web/static/js/annotate/hidden_types.js';
import { expertSettingsProblems, hiddenTypeProblems } from '../../electrotag/web/static/js/admin/settings_checks.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
globalThis.localStorage ??= memoryStorage();
globalThis.sessionStorage ??= memoryStorage();
const { AnnotationSession } = await import('../../electrotag/web/static/js/annotate/session.js');

const cat = new Catalogue(CATALOGUE);
const names = (sections) => sections.flatMap((s) => s.labels.map((l) => l.label));
const memory = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), remove: (k) => m.delete(k) };
};

test('hidden types leave every list, and every type stays known', () => {
  const c = withHiddenTypes(cat, ['Eye-blink-artifact', 'Chewing-artifact', 'Not-a-type', UNCERTAIN_LABEL]);
  assert.deepEqual([...c.hidden].sort(), ['Chewing-artifact', 'Eye-blink-artifact'], 'unknown names and the uncertain type are never hidden');
  assert.deepEqual(names(c.sections()), names(cat.sections()).filter((n) => !['Eye-blink-artifact', 'Chewing-artifact'].includes(n)));
  assert.ok(names(c.sections()).includes(UNCERTAIN_LABEL));
  assert.ok(!c.specificLabels().includes('Eye-blink-artifact'));
  assert.deepEqual(c.quickLabels(['Eye-blink-artifact', 'EMG-artifact']), ['EMG-artifact']);
  assert.deepEqual(c.quickLabels([]), cat.specificLabels().filter((n) => !c.hidden.has(n)).slice(0, 9), 'the fallback keys leave them out too');
  // known for the marks that have them
  assert.equal(c.has('Eye-blink-artifact'), true);
  assert.equal(c.get('Eye-blink-artifact').label, 'Eye-blink-artifact');
  assert.equal(c.colourFor('Eye-blink-artifact'), cat.colourFor('Eye-blink-artifact'));
  assert.deepEqual(c.labelNames, cat.labelNames);
  assert.equal(withHiddenTypes(cat, []), cat, 'nothing hidden: the catalogue itself');
  // a family whose types are all hidden leaves no empty heading
  const eye = cat.sections().find((s) => s.section === 'Eye').labels.map((l) => l.label);
  assert.ok(!withHiddenTypes(cat, eye).sections().some((s) => s.section === 'Eye'));
});

function session(hidden, quick) {
  const recording = { fileName: 'x.edf', sfreq: 250, nSamples: 250 * 60, durationS: 60, format: 'edf', markers: [], warnings: [], gaps: [],
    channels: ['Fp1', 'Fp2', 'C3', 'C4'].map((n) => ({ name: n, type: 'eeg' })) };
  return new AnnotationSession({ backend: { kind: 'server', server: 'http://study' }, recording, manifest: null, recordingId: 'x.edf', mode: 'standard', contextId: '',
    sha256: 'a'.repeat(64), me: { annotator_id: 'A01', study: { annotation: { hidden_labels: hidden, quick_labels: quick } } }, catalogue: cat });
}

test('an annotation session uses the study\'s hidden types, and keeps marks that have one', () => {
  const s = session(['Eye-blink-artifact'], ['Eye-blink-artifact', 'EMG-artifact']);
  assert.deepEqual(s.quickLabels, ['EMG-artifact']);
  assert.ok(!names(s.catalogue.sections()).includes('Eye-blink-artifact'));
  assert.equal(s.catalogue.has('Eye-blink-artifact'), true, 'an earlier mark of the type is still read');
  // a mark that has the type (one made before it was hidden) is kept and can be saved
  s.store.reset([{ annotation_id: '1'.padStart(32, '0'), label: 'Eye-blink-artifact', onset_sample: 100, duration_samples: 50, channels: [], created_at: '', modified_at: '' }]);
  assert.equal(s.store.toJSON().length, 1);
  assert.equal(s.store.toJSON()[0].label, 'Eye-blink-artifact');
  assert.equal(session(undefined, []).catalogue, cat, 'a study without the setting: the catalogue as it is');
});

test('the checks of the setting, in the admin area and the sandbox', () => {
  const labels = CATALOGUE.labels;
  const w = (annotation) => ({ ...DEFAULT_SETTINGS, annotation: { ...DEFAULT_SETTINGS.annotation, quick_labels: ['EMG-artifact'], ...annotation } });
  assert.deepEqual(hiddenTypeProblems(w({ hidden_labels: ['Chewing-artifact'] }), labels), []);
  assert.deepEqual(expertSettingsProblems(DEFAULT_SETTINGS, labels), []);
  assert.match(hiddenTypeProblems(w({ hidden_labels: ['Nothing'] }), labels)[0], /Nothing is not an artifact type/);
  assert.match(hiddenTypeProblems(w({ hidden_labels: [UNCERTAIN_LABEL] }), labels)[0], /always available/);
  assert.match(hiddenTypeProblems(w({ hidden_labels: ['EMG-artifact'] }), labels)[0], /EMG-artifact is on a number key/);
  const every = labels.filter((l) => !l.is_group && l.label !== UNCERTAIN_LABEL).map((l) => l.label);
  assert.match(hiddenTypeProblems(w({ quick_labels: [], hidden_labels: every }), labels)[0], /at least one specific artifact type/);
  assert.deepEqual(hiddenTypeProblems(w({ quick_labels: [], hidden_labels: every.slice(1) }), labels), []);
});

test('the sandbox saves the hidden types and gives them to annotators', async () => {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login('ADMIN', 'demo');
  assert.deepEqual((await b.me()).study.annotation.hidden_labels, []);
  await assert.rejects(() => b.admin('settings_update', { settings: { annotation: { hidden_labels: ['Eye-blink-artifact'] } } }),
    (e) => e.status === 400 && /on a number key/.test(e.message), 'Eye-blink-artifact is on key 1 by default');
  await b.admin('settings_update', { settings: { annotation: { quick_labels: ['EMG-artifact'], hidden_labels: ['Eye-blink-artifact'] } } });
  assert.deepEqual((await b.me()).study.annotation.hidden_labels, ['Eye-blink-artifact']);
});

test('the warning names the training sets that use a hidden type', async () => {
  const { hiddenTypesInTraining } = await import('../../electrotag/web/static/js/admin/settings.js');
  const sets = [{ set_id: 'pilot', name: 'Pilot set', marks: { 'Eye-blink-artifact': 6, 'EMG-artifact': 2 }, quiz: { 'Eye-blink-artifact': 1 } },
    { set_id: 'q', name: 'Second set', marks: { 'Chewing-artifact': 1 }, quiz: {} }, { set_id: 'r', name: 'Unaffected', marks: { 'EMG-artifact': 1 }, quiz: {} }];
  assert.equal(hiddenTypesInTraining(sets, new Set()), '');
  assert.equal(hiddenTypesInTraining(sets, new Set(['Slow-eye-movement-artifact'])), '');
  assert.equal(hiddenTypesInTraining(sets, new Set(['Eye-blink-artifact'])), 'A training set uses a type you are hiding, so trainees would be asked for a type '
    + 'they can no longer choose. Pilot set: Eye-blink-artifact (6 reference marks and 1 quiz answer). Change those marks and answers in Training, or keep the type available.');
  assert.match(hiddenTypesInTraining(sets, new Set(['Eye-blink-artifact', 'Chewing-artifact'])), /^Training sets use .* Pilot set: Eye-blink-artifact \(6 reference marks and 1 quiz answer\); Second set: Chewing-artifact \(1 reference mark\)\./);
  assert.equal(hiddenTypesInTraining(undefined, new Set(['x'])), '');
});

test('the sandbox lists the types its training set asks for', async () => {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login('ADMIN', 'demo');
  const { sets } = await b.admin('training_types_get');
  assert.deepEqual(sets.map((s) => s.set_id), (await b.admin('sets_list')).sets.map((s) => s.set_id).sort());
  const total = (o) => Object.values(o).reduce((a, n) => a + n, 0);
  const listed = (await b.admin('sets_list')).sets.find((s) => s.set_id === sets[0].set_id);
  assert.equal(total(sets[0].marks), listed.recordings.reduce((a, r) => a + r.n_reference_events, 0), 'every reference mark, by type');
  const { items } = await b.admin('quiz_items', { set_id: sets[0].set_id });
  assert.equal(total(sets[0].quiz), items.filter((it) => it.correct_label !== 'No artifact / none of these').length, 'every quiz answer naming a type, by type');
  assert.ok(sets[0].marks['Eye-blink-artifact'] > 0);
});
