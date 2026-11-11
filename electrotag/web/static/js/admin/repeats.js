// Repeat ratings: the study setting `repeats` (docs/admin_area.md, "Repeat ratings"). Switched on, it asks
// annotators to rate recordings they have saved again, for intra-rater (test-retest) reliability. Each rule
// says which recordings (all of them, chosen datasets, or recordings picked one by one), how many times they
// are rated again, and how many days pass between one rating and the next. The rules are applied in order:
// a recording takes the first rule that covers it, so rules for some recordings go above a rule for all.
// A repeat comes back to every annotator who saved the recording, as a new recording, with their earlier
// marks not shown. Saved with settings_update, so every change is in the audit log.

import { h, clear } from '../ui/dom.js';
import { icon } from '../views/common.js';
import { newId } from '../util.js';
import { plural } from './model.js';
import { actionButton, card, checkbox, checkList, field, messageArea, numberInput, put, radios, sectionHead, textInput } from './ui.js';
import { MAX_REPEAT_DAYS, MAX_REPEATS, repeatsProblems } from './settings_checks.js';

const DEFAULT_DATASET = 'study-recordings';

/** A rule in words: "The dataset Pilot (12 recordings now): rated 2 more times, 14 days apart." */
export function ruleText(rule, { datasets = {}, recordings = 0 } = {}) {
  const n = Number(rule.repeats) || 1;
  const days = Number(rule.interval_days) || 14;
  const which = rule.recordings !== 'some' ? 'Every recording not covered by a rule above'
    : [
      ...(rule.datasets || []).map((d) => `the dataset ${datasets[d] || d}`),
      ...((rule.recording_ids || []).length ? [plural((rule.recording_ids || []).length, 'recording')] : []),
    ].join(' and ').replace(/^./, (c) => c.toUpperCase());
  const times = n === 1 ? 'once more' : `${n} more times`;
  const gap = days === 1 ? '1 day' : `${days} days`;
  // with datasets, how many recordings that is now (datasets grow as recordings are added)
  const extra = recordings && (rule.datasets || []).length ? ` (${plural(recordings, 'recording')} now)` : '';
  return `${which}${extra}: rated ${times}, ${n === 1 ? `${gap} after the first rating` : `${gap} apart`}.`;
}

export class RepeatsSection {
  constructor(area) {
    this.area = area;
    this.msg = messageArea();
    this.host = h('div.admin-stack');
    this.el = h('section.admin-section', { 'data-section': 'repeats' },
      sectionHead('Repeat ratings', 'Ask annotators to rate recordings again after some days, to measure how consistent each '
        + 'person is with themselves (intra-rater, or test-retest, reliability).'),
      this.msg, this.host);
  }

  async show() {
    this.msg.clear();
    clear(this.host);
    this.host.append(h('p.caption.admin-loading', { role: 'status' }, 'Loading…'));
    try {
      const [s, d, r] = await Promise.all([this.area.read('settings_get'), this.area.read('datasets_list').catch(() => ({ datasets: [] })),
        this.area.read('recordings_list', { scope: 'study' }).catch(() => ({ recordings: [] }))]);
      this.data = s;
      this.datasets = (d.datasets || []).filter((x) => x.state !== 'removed');
      this.recordings = (r.recordings || []).filter((x) => !x.retired);
    } catch (exc) {
      clear(this.host);
      this.msg.problem(exc);
      return;
    }
    this._build();
  }

  _datasetNames() {
    return Object.fromEntries(this.datasets.map((x) => [x.dataset_id, x.name || x.dataset_id]));
  }

  /** How many study recordings a rule covers now (before the rules above it take theirs). */
  _covered(rule) {
    if (rule.recordings !== 'some') return 0;
    const ds = new Set(rule.datasets || []);
    const ids = new Set(rule.recording_ids || []);
    return this.recordings.filter((x) => ids.has(x.recording_id) || ds.has(x.dataset_id || DEFAULT_DATASET)).length;
  }

  _build() {
    const st = (this.data.settings || {}).repeats || {};
    this.rules = (st.rules || []).map((r) => ({ ...r }));
    this.enabled = checkbox('Ask annotators to rate recordings again', st.enabled === true,
      { hint: 'Switched off, no repeat comes due; the rules are kept for when it is switched on again.' });
    this.enabled.input.setAttribute('data-log', 'repeats-enabled');
    this.rulesHost = h('div.admin-stack.repeat-rules');
    const add = h('button.btn', { type: 'button', 'data-log': 'repeat-rule-add', onclick: () => { this._readRules(); this.rules.push({ id: newId().slice(0, 12), name: '', recordings: this.rules.length ? 'some' : 'all', datasets: [], recording_ids: [], repeats: 1, interval_days: 14 }); this._drawRules(); } }, icon('plus'), 'Add a rule');
    const msg = messageArea();
    const save = actionButton('Save the repeat ratings', { kind: 'primary', working: 'Saving…', msg, log: 'repeats-save', onClick: async () => {
      msg.clear();
      this._readRules();
      const repeats = { enabled: this.enabled.input.checked, rules: this.rules.map((r) => this._clean(r)) };
      const problems = repeatsProblems(repeats);
      if (problems.length) throw new Error(problems[0]);
      if (repeats.enabled && !repeats.rules.length) throw new Error('Add a rule, so that repeat ratings know which recordings to ask for again.');
      this.data = await this.area.write('settings_update', { settings: { repeats } });
      this._build();
      this.saveMsg.show('success', repeats.enabled
        ? 'Saved. A recording comes back to each annotator who saved it once its days have passed, as a new recording.'
        : 'Saved. Repeat ratings are switched off: no repeat comes due until they are switched on again.');
    } });
    this.saveMsg = msg;
    clear(this.host);
    put(this.host,
      card('How repeat ratings work',
        h('p', {}, 'When a rule covers a recording, everyone who saved it is asked to rate it again once the days chosen have passed '
          + 'since they saved it, up to the number of repeats. The recording comes back in their list as a new recording: their earlier '
          + 'marks are not shown, and nothing says it is a repeat, so that they rate what they see rather than what they remember.'),
        h('p', {}, 'The rules are applied in order, and a recording takes the first rule that covers it: put rules for some recordings '
          + 'above a rule for all of them. Repeats are kept apart from the comparisons between annotators; Analyses compares each '
          + 'annotator with their own repeats (Who is compared: Each annotator with their own repeat ratings).'),
        this.enabled),
      card('Rules', this.rulesHost, h('div.btn-row', {}, add)),
      h('div.sticky-save', {}, h('div.btn-row', {}, save), msg));
    this._drawRules();
  }

  /** A rule as the study keeps it: only the lists its choice of recordings uses. */
  _clean(r) {
    const some = r.recordings === 'some';
    return { id: r.id, name: String(r.name || '').trim(), recordings: some ? 'some' : 'all',
      datasets: some ? [...(r.datasets || [])] : [], recording_ids: some ? [...(r.recording_ids || [])] : [],
      repeats: Number(r.repeats), interval_days: Number(r.interval_days) };
  }

  /** Read every rule's fields back from the form (before the list is redrawn or saved). */
  _readRules() {
    for (const r of this.rules) if (r._read) Object.assign(r, r._read());
  }

  _drawRules() {
    clear(this.rulesHost);
    if (!this.rules.length) {
      this.rulesHost.append(h('p.caption', {}, 'No rules yet. Add one: for example every recording, rated once more 14 days later.'));
      return;
    }
    this.rules.forEach((rule, i) => this.rulesHost.append(this._ruleForm(rule, i)));
  }

  _ruleForm(rule, i) {
    const name = textInput({ value: rule.name || '', placeholder: 'for example Pilot recordings', maxlength: 100 });
    const scope = radios(`repeat-scope-${rule.id}`, [['all', 'All recordings', 'Every study recording not covered by a rule above'],
      ['some', 'Some recordings', 'The datasets and recordings chosen below']], rule.recordings === 'some' ? 'some' : 'all');
    const datasets = checkList(this.datasets.map((d) => ({ value: d.dataset_id, text: d.name || d.dataset_id })),
      { selected: rule.datasets || [], legend: 'Datasets (all their recordings, including those added later)', name: `repeat-datasets-${rule.id}`, empty: 'No datasets yet.' });
    const recordings = checkList(this.recordings.map((x) => ({ value: x.recording_id, text: x.file_name || x.recording_id, extra: x.recording_id !== x.file_name ? x.recording_id : '' })),
      { selected: rule.recording_ids || [], legend: 'Recordings, picked one by one', name: `repeat-recordings-${rule.id}`, empty: 'No study recordings yet.' });
    const some = h('div.admin-grid.repeat-some', {}, datasets, recordings);
    const repeats = numberInput({ value: rule.repeats ?? 1, min: 1, max: MAX_REPEATS, step: 1 });
    const days = numberInput({ value: rule.interval_days ?? 14, min: 1, max: MAX_REPEAT_DAYS, step: 1 });
    const words = h('p.caption.repeat-words', { 'aria-live': 'polite' });
    const read = () => ({ name: name.value, recordings: scope.value() || 'all', datasets: datasets.values(), recording_ids: recordings.values(),
      repeats: Number(repeats.value), interval_days: Number(days.value) });
    rule._read = read;
    const update = () => {
      const r = { ...rule, ...read() };
      some.hidden = r.recordings !== 'some';
      words.textContent = ruleText(r, { datasets: this._datasetNames(), recordings: this._covered(r) });
    };
    for (const el of [name, scope, datasets, recordings, repeats, days]) { el.addEventListener('input', update); el.addEventListener('change', update); }
    const move = (dir) => { this._readRules(); const j = i + dir; [this.rules[i], this.rules[j]] = [this.rules[j], this.rules[i]]; this._drawRules(); };
    const tools = h('div.btn-row', {},
      h('button.btn.small', { type: 'button', 'data-log': 'repeat-rule-up', disabled: i === 0, onclick: () => move(-1) }, 'Move up'),
      h('button.btn.small', { type: 'button', 'data-log': 'repeat-rule-down', disabled: i === this.rules.length - 1, onclick: () => move(1) }, 'Move down'),
      h('button.btn.small', { type: 'button', 'data-log': 'repeat-rule-remove', onclick: () => { this._readRules(); this.rules.splice(i, 1); this._drawRules(); } }, 'Remove'));
    const el = h('fieldset.admin-fieldset.repeat-rule', { 'data-rule': rule.id },
      h('legend', {}, `Rule ${i + 1}`),
      h('div.form-grid', {},
        field('Name (for the study team)', name),
        field('Rated again', repeats, { hint: `How many times each recording is rated again after the first rating (1 to ${MAX_REPEATS}).` }),
        field('Days between ratings', days, { hint: `From saving one rating until the recording comes back for the next (1 to ${MAX_REPEAT_DAYS}).` })),
      h('fieldset.admin-fieldset', {}, h('legend', {}, 'Applies to'), scope),
      some, words, tools);
    update();
    return el;
  }
}
