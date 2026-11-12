// Before the study starts (docs/admin_area.md, "Before the study starts"): the settings that decide what the
// study's results mean, which the study team chooses and confirms before the first study recording is saved.
// The agreement analysis's settings are saved as the study's own on the Analyses page, the measure of working
// time in Study settings, and the repeat ratings in Repeat ratings. Every one has a default, so each is confirmed
// on its own (preregistration_confirm), and the confirmation keeps who confirmed it, when and the values; a
// group changed since is shown as changed until it is confirmed again. The Overview shows the list until every
// group is confirmed, and folds it into one line afterwards.

import { h, clear } from '../ui/dom.js';
import { plural, whenText } from './model.js';
import { actionButton, card, chip, messageArea } from './ui.js';
import { ruleText } from './repeats.js';

/** The groups of settings in the order the study lists them, with where each is chosen. */
export const PREREG_ITEMS = Object.freeze({
  agreement: { title: 'Agreement settings', section: 'analyses', where: 'Choose on the Analyses page' },
  working_time: { title: 'Working time', section: 'settings', where: 'Choose in Study settings' },
  repeats: { title: 'Repeat ratings', section: 'repeats', where: 'Choose in Repeat ratings' },
});

const numbers = (xs) => (xs || []).map((x) => String(x)).join(', ');

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
    return `Time bins of ${numbers(values.resolutions_s)} s with bin coverage ${values.min_bin_coverage}; events matched ${matchingText(values)}, `
      + `${values.allow_many_to_one ? 'many-to-one' : 'one-to-one'}; compared by ${channels}; ${cats}.`;
  }
  if (item === 'working_time') {
    const v = values || {};
    const idle = `${v.idle_after_s} s`;
    return v.measure === 'wall_s'
      ? `Wall-clock time (wall_s): all the time from opening a recording to closing it. Idle periods, beyond ${idle} without input, are still labelled in the logs.`
      : `Active time (active_s): idle time beyond ${idle} without input, and time in other programs, left out.`;
  }
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
    const confirm = entry.state === 'confirmed' ? null : actionButton(entry.state === 'changed' ? 'Confirm again' : 'Confirm', {
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
