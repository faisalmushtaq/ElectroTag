// Repeat ratings in the browser: the rules' checks (as electrotag/config/settings.py RepeatSettings), the
// sentence each rule shows in the admin area, and the sandbox's scheduling (demo_repeats.js, as
// electrotag/web/service.py _schedule_repeats).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
globalThis.localStorage = globalThis.localStorage || store();
globalThis.sessionStorage = globalThis.sessionStorage || store();

const { repeatsProblems, expertSettingsProblems } = await import('../../electrotag/web/static/js/admin/settings_checks.js');
const { DEFAULT_SETTINGS } = await import('../../electrotag/web/static/js/api/demo_catalogue.js');
const { schedule, ruleFor } = await import('../../electrotag/web/static/js/api/demo_repeats.js');

const rule = (extra = {}) => ({ id: 'r1', name: '', recordings: 'all', datasets: [], recording_ids: [], repeats: 1, interval_days: 14, ...extra });

test('the rules are checked in plain words, as the study checks them', () => {
  assert.deepEqual(DEFAULT_SETTINGS.repeats, { enabled: false, rules: [] }, 'off by default');
  assert.deepEqual(repeatsProblems(DEFAULT_SETTINGS.repeats), []);
  assert.deepEqual(repeatsProblems({ enabled: true, rules: [rule(), rule({ id: 'r2', recordings: 'some', datasets: ['pilot'] })] }), []);
  const one = (extra) => repeatsProblems({ enabled: true, rules: [rule(extra)] })[0];
  assert.match(repeatsProblems({ enabled: 'yes' })[0], /on or off/);
  assert.match(one({ recordings: 'some' }), /Rule 1 applies to some recordings: choose at least one dataset or recording/);
  assert.match(one({ repeats: 0 }), /whole number from 1 to 10/);
  assert.match(one({ repeats: 1.5 }), /whole number from 1 to 10/);
  assert.match(one({ interval_days: 400 }), /whole number from 1 to 365/);
  assert.match(one({ id: 'with space' }), /needs an ID of its own/);
  assert.match(one({ name: 'x'.repeat(101), id: 'r9' }), /at most 100 characters/);
  assert.match(repeatsProblems({ rules: [rule(), rule()] })[0], /Rule 2 needs an ID of its own/);
  assert.match(expertSettingsProblems({ ...DEFAULT_SETTINGS, repeats: { enabled: true, rules: [rule({ repeats: 99 })] } }).join(' '), /1 to 10/);
});

test('a rule in words', async () => {
  const { ruleText } = await import('../../electrotag/web/static/js/admin/repeats.js');
  assert.equal(ruleText(rule()), 'Every recording not covered by a rule above: rated once more, 14 days after the first rating.');
  assert.equal(ruleText(rule({ recordings: 'some', recording_ids: ['a', 'b'], repeats: 3, interval_days: 1 })), '2 recordings: rated 3 more times, 1 day apart.');
  assert.equal(ruleText(rule({ recordings: 'some', datasets: ['p'] }), { datasets: { p: 'Pilot' }, recordings: 12 }),
    'The dataset Pilot (12 recordings now): rated once more, 14 days after the first rating.');
  assert.equal(ruleText(rule({ recordings: 'some', datasets: ['p'], recording_ids: ['a'] }), { datasets: { p: 'Pilot' } }),
    'The dataset Pilot and 1 recording: rated once more, 14 days after the first rating.');
});

test('the sandbox offers a repeat once its days have passed, up to the number of repeats', () => {
  const DAY = 864e5;
  const now = Date.parse('2026-11-20T12:00:00+00:00');
  const at = (days) => new Date(now - days * DAY).toISOString();
  const subs = [];
  const backend = {
    _admin: { s: { settings: { repeats: { enabled: true, rules: [rule({ id: 'pilot', recordings: 'some', recording_ids: ['x'], repeats: 2, interval_days: 7 }), rule({ id: 'rest', interval_days: 30 })] } } } },
    state: { drafts: {} },
    _attempts: (key) => subs.filter((s) => s.key === key),
  };
  const item = (rid, extra = {}) => ({ rid, key: `k-${rid}`, mode: 'standard', source: 'assignment', status: 'done', info: {}, revising: false, ...extra });
  assert.equal(ruleFor(backend._admin.s.settings.repeats.rules, 'x', 'study-recordings').id, 'pilot');
  assert.equal(ruleFor(backend._admin.s.settings.repeats.rules, 'y', 'study-recordings').id, 'rest');

  subs.push({ key: 'k-x', saved_at: at(6), attempt: 1 }, { key: 'k-y', saved_at: at(31), attempt: 1 });
  let items = [item('x'), item('y'), item('z', { status: 'todo' }), item('p', { mode: 'practice' })];
  schedule(backend, items, now);
  assert.deepEqual(items.map((i) => [i.rid, i.status, i.retest || 0]), [['x', 'done', 0], ['y', 'todo', 1], ['z', 'todo', 0], ['p', 'done', 0]]);
  assert.equal(items[1].saved, null, 'nothing of the earlier rating');

  subs[0].saved_at = at(8);
  backend.state.drafts['k-x'] = {};
  items = [item('x')];
  schedule(backend, items, now);
  assert.deepEqual([items[0].status, items[0].retest, items[0].retest_rule], ['in_progress', 1, 'pilot'], 'with its draft, work in progress');

  subs.push({ key: 'k-x', saved_at: at(2), attempt: 2, retest: 1 });
  items = [item('x')];
  schedule(backend, items, now);
  assert.equal(items[0].status, 'done', 'the days count from the repeat');
  subs[2].saved_at = at(10);
  items = [item('x')];
  schedule(backend, items, now);
  assert.equal(items[0].retest, 2);
  subs.push({ key: 'k-x', saved_at: at(100), attempt: 3, retest: 2 });
  items = [item('x')];
  schedule(backend, items, now);
  assert.equal(items[0].status, 'done', 'two repeats: no more');

  backend._admin.s.settings.repeats.enabled = false;
  items = [item('y')];
  schedule(backend, items, now);
  assert.equal(items[0].status, 'done', 'switched off');
});
