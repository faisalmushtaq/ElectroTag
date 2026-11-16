// Looking for training recordings in the browser (docs/admin_area.md, "Looking for training recordings"): the words and
// filters the expert's list and view share (js/expert/browse_model.js), the coverage of the artifact types that need
// training material, the list of training sets to approve into, the section, the purpose and the route that pauses the
// interaction log, and the sandbox, which has no stand-in for the operations of electrotag/web/candidates.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BROWSE_FILTERS, RATINGS, askable, canAsk, coverageRows, coverageSummary, filterRows, marksText, requestText, requiredTypes,
} from '../../electrotag/web/static/js/expert/browse_model.js';
import { DEMO_NOTE, NEW_SET, setChoices } from '../../electrotag/web/static/js/admin/candidates.js';
import { BROWSING_ROUTE, browseKey } from '../../electrotag/web/static/js/expert/browse_pass.js';
import { EXPERT_ROUTE, EXPERT_SECTIONS } from '../../electrotag/web/static/js/expert/sections.js';
import { PURPOSES } from '../../electrotag/web/static/js/views/purposes.js';
import { DemoBackend } from '../../electrotag/web/static/js/api/demo.js';
import { DEFAULT_SETTINGS } from '../../electrotag/web/static/js/api/demo_catalogue.js';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

function memory() {
  const m = new Map();
  return { get: (k, d = null) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) };
}

/** The operations electrotag/web/candidates.py declares: the admin area's READS and WRITES, and the expert area's. */
function candidateOps() {
  const py = read('electrotag/web/candidates.py');
  const tuple = (name) => [...py.match(new RegExp(`^${name} = \\(([^)]*)\\)`, 'm'))[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  return { admin: [...tuple('READS'), ...tuple('WRITES')], expert: [...py.matchAll(/@expert_op\("([a-z_]+)"\)/g)].map((x) => x[1]) };
}

const rows = [
  { recording_id: 'a', rating: 'yes', has_note: true, request: { status: 'pending' } },
  { recording_id: 'b', rating: null, has_note: false, request: null },
  { recording_id: 'c', rating: 'no', has_note: false, request: { status: 'declined' } },
  { recording_id: 'd', rating: 'maybe', has_note: true, request: { status: 'approved', set_id: 'pilot', set_name: 'Pilot set' } },
];

test('the expert rates, filters and asks for recordings in plain words', () => {
  assert.deepEqual(RATINGS.map(([v]) => v), ['yes', 'maybe', 'no']);
  assert.deepEqual(BROWSE_FILTERS.map(([v]) => v).filter(Boolean).map((f) => filterRows(rows, f).map((r) => r.recording_id)),
    [['b'], ['a'], ['d'], ['c'], ['a', 'd'], ['a', 'd']]);
  assert.equal(filterRows(rows, '').length, 4);
  assert.deepEqual(rows.map(canAsk), [false, true, true, false], 'a request waiting or approved is not made again');
  assert.deepEqual(askable(rows).rows.map((r) => r.recording_id), ['b', 'c']);
  assert.equal(askable(rows).label, 'Ask for 2 recordings to be added to training');
  assert.equal(askable([rows[0]]).label, 'Ask for the chosen recordings');
  assert.equal(requestText(rows[3].request), 'Approved into Pilot set, awaiting annotation');
  assert.equal(requestText({ status: 'declined', reason: 'Too short' }), 'Declined: Too short. You can ask again.');
  assert.equal(requestText(null), '');
  assert.equal(marksText(0, {}), 'No marks');
  assert.equal(marksText(3, { 'EMG-artifact': 1, 'Eye-blink-artifact': 2 }), '3 marks: 2 Eye-blink-artifact, 1 EMG-artifact');
  assert.equal(marksText(1, {}), '1 mark');
});

test('the types that need training material default to the number keys, and their coverage is counted', () => {
  assert.deepEqual(requiredTypes(DEFAULT_SETTINGS), DEFAULT_SETTINGS.annotation.quick_labels);
  assert.equal(DEFAULT_SETTINGS.training.required_types, null, 'the sandbox has the study\'s default');
  assert.equal(requiredTypes({ ...DEFAULT_SETTINGS, annotation: { quick_labels: ['EMG-artifact'] } }).length, 1, 'unchosen, they follow the keys');
  assert.deepEqual(requiredTypes({ training: { required_types: ['Sweat-artifact'] }, annotation: { quick_labels: ['EMG-artifact'] } }), ['Sweat-artifact']);
  assert.deepEqual(requiredTypes({ training: { required_types: [] } }), []);
  const sets = [{ set_id: 'a', name: 'Set A', marks: { 'EMG-artifact': 3 }, quiz: { 'EMG-artifact': 1, 'ECG-artifact': 2 } },
    { set_id: 'b', name: '', marks: { 'EMG-artifact': 1, 'Chewing-artifact': 2 }, quiz: {} }];
  const cov = coverageRows(['EMG-artifact', 'ECG-artifact', 'Chewing-artifact'], sets);
  assert.deepEqual(cov, [
    { label: 'EMG-artifact', marks: 4, quiz: 1, sets: ['Set A', 'b'], missing: false },
    { label: 'ECG-artifact', marks: 0, quiz: 2, sets: [], missing: true },
    { label: 'Chewing-artifact', marks: 2, quiz: 0, sets: ['b'], missing: false },
  ]);
  assert.equal(coverageSummary(cov), '1 of the 3 artifact types that need training material has no examples in any training set yet: ECG-artifact.');
  assert.match(coverageSummary(cov.filter((r) => !r.missing)), /^Every one of the 2 artifact types/);
  assert.match(coverageSummary([]), /^No artifact types are chosen/);
});

test('requests are approved into a training set from a list that ends with a new one', () => {
  const c = setChoices([{ set_id: 'pilot', name: 'Pilot set' }, { set_id: 'blinks', name: 'blinks' }]);
  assert.deepEqual(c, [['', 'Choose a training set'], ['pilot', 'Pilot set (pilot)'], ['blinks', 'blinks'], [NEW_SET, 'A new training set…']]);
  assert.deepEqual(setChoices([]).map(([v]) => v), ['', NEW_SET]);
});

test('the section, the purpose and the route that keeps the view out of the interaction log', () => {
  const s = EXPERT_SECTIONS.find((x) => x.key === 'browse');
  assert.ok(s && s.route === 'expert-browse' && EXPERT_ROUTE.test(s.route));
  assert.equal(typeof PURPOSES.browse, 'function');
  assert.ok(EXPERT_ROUTE.test(BROWSING_ROUTE) && !EXPERT_SECTIONS.some((x) => x.route === BROWSING_ROUTE), 'the view is no section of its own');
  assert.match(read('electrotag/web/static/js/app.js'), new RegExp(`route === '${BROWSING_ROUTE}'\\) this\\._pauseLog\\(null\\)`));
  assert.match(read('electrotag/web/static/js/annotate/workspace.js'), /const PART_KINDS = \[[^\]]*'browsing'\]/);
  assert.notEqual(browseKey({ kind: 'demo' }, 'E01', 'r1'), browseKey({ kind: 'demo' }, 'E02', 'r1'), 'each expert\'s marks are kept apart');
});

test('the sandbox has no stand-in for looking for training recordings', async () => {
  const ops = candidateOps();
  assert.ok(ops.admin.length >= 6 && ops.expert.length >= 6, JSON.stringify(ops));
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login('ADMIN', 'demo');
  // the admin area's cards say so without asking (admin/candidates.js DEMO_NOTE), so demo_admin.js, which the sign-in
  // page loads, stays as it was; the expert area's operations answer needs_server (demo_expert.js, loaded when used)
  for (const op of ops.admin) {
    await assert.rejects(b.admin(op, {}), (e) => e.code === 'not_found', op);
  }
  assert.match(DEMO_NOTE, /needs a study server or Firebase/);
  for (const op of ops.expert) {
    await assert.rejects(b.expert(op, {}), (e) => e.code === 'needs_server', op);
  }
  await b.login('A01', 'demo');
  await assert.rejects(b.expert('browse_datasets_list', {}), (e) => e.code === 'forbidden', 'only experts and administrators');
});

test('study settings keep the types that need training material, and the sandbox takes the setting', async () => {
  const b = new DemoBackend({ storage: memory(), tokens: memory() });
  await b.login('ADMIN', 'demo');
  const out = await b.admin('settings_update', { settings: { training: { required_types: ['EMG-artifact', 'Chewing-artifact'] } } });
  assert.deepEqual(out.settings.training.required_types, ['EMG-artifact', 'Chewing-artifact']);
  assert.deepEqual(requiredTypes(out.settings), ['EMG-artifact', 'Chewing-artifact']);
});
