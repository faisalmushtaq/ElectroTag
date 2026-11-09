// Giving out work (js/admin/work.js): how each recording in the list of everything given out reached its
// annotator, from the fields of assignments_list (docs/api.md), and the line that sums the list up.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { THROUGH, givenThrough, workSummary } from '../../electrotag/web/static/js/admin/work.js';

const handouts = new Map([
  ['h-1', { handout_id: 'h-1', name: 'Pilot round', title: 'Recordings due 20 November', target: { kind: 'collection' } }],
  ['h-2', { handout_id: 'h-2', name: '', title: 'Recordings due 1 December', target: { kind: 'recordings' } }],
]);
const tasks = new Map([['t-1', { task_id: 't-1', batch: 'Second round' }], ['t-2', { task_id: 't-2', batch: '' }]]);
const item = (fields) => ({ annotator_id: 'A01', recording_id: 'r.edf', mode: 'standard', status: 'todo', source: 'assignment', task_id: null, handout_id: null, ...fields });

test('each recording says how it was given', () => {
  const g = (fields) => givenThrough(item(fields), { handouts, tasks });
  assert.deepEqual([g({}).kind, g({}).text], ['assignment', 'Assigned by itself']);
  assert.deepEqual(g({ source: 'programme', mode: 'practice' }), { kind: 'programme', text: 'Training programme', detail: '', handoutId: null, taskId: null });
  assert.deepEqual(g({ handout_id: 'h-1' }), { kind: 'handout', text: 'Hand-out', detail: 'Pilot round', handoutId: 'h-1', taskId: null });
  assert.equal(g({ handout_id: 'h-2' }).detail, 'Recordings due 1 December (given in Assignments)', 'a due date given in Assignments');
  assert.equal(g({ task_id: 't-1' }).detail, 'Share-out: Second round');
  assert.equal(g({ task_id: 't-2' }).detail, '');
  // a hand-out that shared its recordings out as tasks counts as the hand-out it is
  const fromHandout = g({ task_id: 't-1', handout_id: 'h-1' });
  assert.deepEqual([fromHandout.kind, fromHandout.detail, fromHandout.handoutId], ['handout', 'Pilot round (shared out as tasks)', 'h-1']);
  // names not known (tasks need a study server or Firebase): the way is still said
  assert.deepEqual([givenThrough(item({ task_id: 't-9' })).kind, givenThrough(item({ handout_id: 'h-9' })).detail], ['task', '']);
  assert.deepEqual(Object.keys(THROUGH).sort(), ['assignment', 'handout', 'programme', 'task']);
});

test('the list is summed up by how its recordings were given', () => {
  const rows = [item({ status: 'done' }), item({ annotator_id: 'A02', handout_id: 'h-1' }), item({ annotator_id: 'A02', task_id: 't-1' }),
    item({ annotator_id: 'A03', task_id: 't-2', status: 'done' })].map((i) => ({ ...i, through: givenThrough(i, { handouts, tasks }) }));
  assert.equal(workSummary(rows), '4 given to 3 people, 2 done: 2 by tasks, 1 by a hand-out, 1 assigned by itself.');
  assert.equal(workSummary([]), '');
});
