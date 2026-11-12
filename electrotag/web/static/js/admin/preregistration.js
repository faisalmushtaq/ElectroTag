// Before the study starts (docs/admin_area.md, "Before the study starts"): the settings that decide what the
// study's results mean, which the study team chooses and confirms before the first study recording is saved.
// The agreement analysis's settings are saved as the study's own on the Analyses page, the measure of working
// time in Study settings, and the repeat ratings in Repeat ratings. Every one has a default, so each is confirmed
// on its own (preregistration_confirm), and the confirmation keeps who confirmed it, when and the values; a
// group changed since is shown as changed until it is confirmed again. The Overview shows the list until every
// group is confirmed, and folds it into one line afterwards.

import { h, clear } from '../ui/dom.js';
import { METRICS, plural, whenText } from './model.js';
import { actionButton, card, chip, messageArea } from './ui.js';
import { ruleText } from './repeats.js';

/** The groups of settings in the order the study lists them, with where each is chosen. */
export const PREREG_ITEMS = Object.freeze({
  agreement: { title: 'Agreement settings', section: 'analyses', where: 'Choose on the Analyses page' },
  working_time: { title: 'Working time', section: 'settings', where: 'Choose in Study settings' },
  repeats: { title: 'Repeat ratings', section: 'repeats', where: 'Choose in Repeat ratings' },
  training: { title: 'Training standards', section: 'training', where: 'Choose in Training' },
});

const percent = (x) => `${Math.round(Number(x) * 100)}%`;
/** Short names of the competency measures (model.js METRICS has their full labels). */
const MEASURE_WORDS = { event_f1: 'event F1', event_recall: 'sensitivity', event_precision: 'precision', time_kappa: 'Cohen\'s kappa',
  time_positive_agreement: 'positive agreement', channel_positive_agreement: 'positive agreement by channel', mean_iou: 'mean overlap (IoU)',
  mean_channel_jaccard: 'mean channel overlap', label_accuracy: 'same label', false_positives_per_min: 'extra events per minute' };
const SKIP_WORDS = { tour: 'the tour', snippets: 'the snippets', guided: 'learning with the experts', practice: 'practice' };
const GATE_WORDS = { met: 'Study work waits until the competency assessment is passed.', completed: 'Study work waits until the competency assessment is finished.',
  off: 'Study work is open at once.' };

/** A set's competency criteria in words, or what an assessment does without them. */
function criteriaText(c) {
  const list = (c && c.criteria) || [];
  if (!list.length) return 'no competency criteria ticked, so its assessment reports results without a pass or fail';
  const one = (x) => `${MEASURE_WORDS[x.metric] || x.metric} ${(METRICS[x.metric] || {}).better === 'lower' ? 'at most' : 'at least'} ${x.threshold}`
    + `${x.scope === 'each_category' ? ' in each category' : ''}`;
  return `passing needs ${list.map(one).join(', ')} (categories with at least ${c.min_reference_events} reference events)`;
}

/** The training standards in words: each set's pass marks and criteria, then the study's training policy. */
function trainingText(v) {
  const sets = v.sets || [];
  if (!sets.length) return 'No training sets. Confirm this if the study uses no training; otherwise create a set in Training first.';
  const p = v.policy || {};
  const skip = (p.skippable || []).map((x) => SKIP_WORDS[x] || x);
  const each = sets.map((x) => {
    const pass = x.practice_pass || {};
    const n = x.assessment_recordings ? plural(x.assessment_recordings, 'assessment recording') : 'no assessment recordings yet';
    return `${x.name || x.set_id}: practice passes at ${percent(pass.event_f1)} score and ${percent(pass.label_accuracy)} right type; ${n}; ${criteriaText(x.criteria)}.`;
  });
  return `${each.join(' ')} ${GATE_WORDS[p.gate] || ''} Trainees may skip ${skip.length ? skip.join(', ') : 'no stage'}.`;
}

const numbers = (xs) => (xs || []).map((x) => String(x)).join(', ');

/** When a time bin counts as marked (min_bin_coverage, a share of the bin from 0 to 1), in words. */
export function coverageText(share) {
  const x = Number(share);
  return x > 0 ? `a bin counting when at least ${Math.round(x * 1000) / 10}% of it is marked` : 'a bin counting when any part of it is marked';
}

/** How events are matched, in words. */
function matchingText(a) {
  const overlap = `by overlap (IoU ${numbers(a.iou_thresholds)}, main ${a.primary_iou_threshold})`;
  const close = `by start and end within ${a.onset_tolerance_s} s and ${a.offset_tolerance_s} s`;
  return a.match_criterion === 'tolerance' ? close : a.match_criterion === 'iou_and_tolerance' ? `${overlap} and ${close}` : overlap;
}

/** A group's settings now, in a sentence. */
export function preregText(item, values) {
  if (item === 'agreement') {
    if (!values) return 'Not saved yet. Choose the settings on the Analyses page and save them as the study\'s.';
    const channels = (values.channel_modes || []).includes('time_and_channel') ? 'time, and time and channel' : 'time only';
    const cats = values.categories ? plural(values.categories.length, 'artifact category', 'artifact categories') : 'every artifact category';
    return `Time bins of ${numbers(values.resolutions_s)} s, ${coverageText(values.min_bin_coverage)}; events matched ${matchingText(values)}, `
      + `${values.allow_many_to_one ? 'many-to-one' : 'one-to-one'}; compared by ${channels}; ${cats}.`;
  }
  if (item === 'working_time') {
    const v = values || {};
    const idle = `${v.idle_after_s} s`;
    return v.measure === 'wall_s'
      ? `Wall-clock time (wall_s): all the time from opening a recording to closing it. Idle periods, beyond ${idle} without input, are still labelled in the logs.`
      : `Active time (active_s): idle time beyond ${idle} without input, and time in other programs, left out.`;
  }
  if (item === 'training') return trainingText(values || {});
  const r = values || {};
  if (!r.enabled) return 'Off: no recording is rated again.';
  return `On. ${(r.rules || []).map((x) => ruleText(x)).join(' ')}`;
}

/** The chip of a group's state: its words and kind. */
export function stateChip(entry) {
  if (entry.state === 'confirmed') return ['Confirmed', 'done'];
  if (entry.state === 'changed') return ['Changed since confirmed', 'warning'];
  return ['Not confirmed', 'warning'];
}

/** Who confirmed a group and when, and whether that was before the study started. */
export function confirmedText(entry) {
  if (!entry.confirmed_at) return '';
  const when = whenText(entry.confirmed_at);
  const start = entry.before_start === false ? ', after the study started' : entry.before_start ? ', before the study started' : '';
  return `${entry.state === 'changed' ? 'Last confirmed' : 'Confirmed'} by ${entry.confirmed_by} (${when})${start}.`;
}

/**
 * The list of groups with their state and a Confirm button each, for the Overview. `status` is the answer of
 * preregistration_get; `onChange(status)` is called with the answer of each confirmation.
 */
export function preregistrationList(area, status, onChange) {
  const msg = messageArea();
  const rows = (status.items || []).map((entry) => {
    const info = PREREG_ITEMS[entry.item] || { title: entry.item, section: 'overview', where: '' };
    const [words, kind] = stateChip(entry);
    const noTraining = entry.item === 'training' && !((entry.values || {}).sets || []).length;
    const confirm = entry.state === 'confirmed' ? null : actionButton(entry.state === 'changed' ? 'Confirm again' : noTraining ? 'Confirm: no training' : 'Confirm', {
      kind: 'small', working: 'Confirming…', msg, log: `prereg-confirm-${entry.item}`,
      onClick: async () => onChange(await area.write('preregistration_confirm', { item: entry.item })),
    });
    if (confirm && !entry.ready) {
      confirm.disabled = true;
      confirm.title = 'Save the agreement settings on the Analyses page first.';
    }
    const go = h('button.btn.small.quiet', { type: 'button', 'data-to': info.section, onclick: () => area.go(info.section) }, info.where);
    const said = confirmedText(entry);
    return h('li.prereg-item', { 'data-item': entry.item, 'data-state': entry.state },
      h('div.prereg-head', {}, h('b', {}, info.title), chip(words, kind)),
      h('p.prereg-values', {}, preregText(entry.item, entry.values)),
      said ? h('p.caption', {}, said) : null,
      h('div.btn-row', {}, confirm, go));
  });
  return h('div.prereg', {}, h('ul.prereg-list', {}, rows), msg);
}

/** The Overview's card: the whole list while anything is to confirm, one folded line once all are confirmed. */
export function preregistrationCard(area, status, host) {
  const draw = (st) => {
    clear(host);
    const list = preregistrationList(area, st, draw);
    if (st.done) {
      host.append(h('details.admin-details.prereg-done', {}, h('summary', {}, 'Settings chosen before the study started: all confirmed'), list));
      return;
    }
    const left = (st.items || []).filter((i) => i.state !== 'confirmed').length;
    const started = st.study_started_at
      ? h('div.banner.prereg-started', { role: 'status' }, `The study started when its first study recording was saved (${whenText(st.study_started_at)}). `
        + 'Confirm the settings now: the record will show that they were confirmed after the study started.')
      : null;
    const c = card('Before the study starts',
      h('p.caption', {}, `These settings decide what the study's results mean, so choose each one and confirm it before the first `
        + `annotator saves a recording. ${plural(left, 'group is', 'groups are')} still to confirm. The confirmations, with who made them `
        + 'and when, go into the results download (study/preregistration.json).'),
      started, list);
    c.classList.add('prereg-card');
    host.append(c);
  };
  draw(status);
}
