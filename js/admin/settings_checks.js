// The checks of the study settings that the expert work brought (the review, training and replay blocks
// of electrotag.config.settings), with the words for their choices. Loaded with the Study settings
// section, and by the sandbox when its settings are changed, so the sign-in page never needs them.

import { MATCH_CRITERIA } from './model.js';
import { K_MAX, K_MIN } from './tasks_model.js';
import { questionnaireProblems } from '../views/questionnaire_model.js';

/** When an adjudicator gives a reason (review.reason_required). */
export const REASON_RULES = Object.freeze({
  always: 'For every decision', edited_or_none: 'Only when they keep neither version or edit a mark', never: 'Never',
});
/** The stages of the training path a trainee may be allowed to skip (training.skippable), and the gate. */
export const SKIPPABLE_STAGES = Object.freeze({
  tour: 'Find your way around (the platform tour)', snippets: 'Meet the artifacts (snippets)',
  guided: 'Learn with the experts', practice: 'On your own (practice)',
});
export const TRAINING_GATES = Object.freeze({
  met: 'Until the competency assessment is passed', completed: 'Until the competency assessment is finished', off: 'Never: study work is open at once',
});

function isNumber(v, lo, hi) { return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi; }

/** Problems with the review block (electrotag.config.settings ReviewSettings), in plain words. */
export function reviewProblems(r) {
  const out = [];
  for (const k of ['corrections', 'show_corrections_to_annotators', 'show_outcomes_to_annotators']) {
    if (k in r && typeof r[k] !== 'boolean') out.push(`review.${k} is on or off (true or false).`);
  }
  if ('k_default' in r && !(Number.isInteger(r.k_default) && r.k_default >= K_MIN && r.k_default <= K_MAX)) out.push(`Each task goes to between ${K_MIN} and ${K_MAX} annotators.`);
  if ('gold_min_items' in r && !(Number.isInteger(r.gold_min_items) && r.gold_min_items >= 1 && r.gold_min_items <= 100)) {
    out.push('A person\'s accuracy counts after between 1 and 100 known-answer items.');
  }
  if ('reason_required' in r && !(r.reason_required in REASON_RULES)) out.push('Choose when an adjudicator gives a reason.');
  const m = r.matching || {};
  if ('match_criterion' in m && !(m.match_criterion in MATCH_CRITERIA)) out.push('Choose how two marks are matched.');
  if ('iou_threshold' in m && !(isNumber(m.iou_threshold, 0, 1) && m.iou_threshold < 1)) out.push('The overlap two marks need is from 0 (any overlap) to just below 1.');
  for (const k of ['onset_tolerance_s', 'offset_tolerance_s']) {
    if (k in m && !isNumber(m[k], 0, 60)) out.push('The start and end tolerances are between 0 and 60 seconds.');
  }
  if ('channel_jaccard' in m && !isNumber(m.channel_jaccard, 0, 1)) out.push('The share of channels in common is between 0 and 1.');
  return [...new Set(out)];
}

/** Problems with the training block (electrotag.config.settings TrainingPolicy), in plain words. */
export function trainingProblems(t) {
  const out = [];
  if ('skippable' in t) {
    if (!Array.isArray(t.skippable)) out.push('The stages that may be skipped are a list.');
    else if (t.skippable.includes('assessment')) out.push('The competency assessment cannot be skipped: trainees pass it before real study work.');
    else if (t.skippable.some((x) => !(x in SKIPPABLE_STAGES))) out.push('Only the tour, the snippets, learning with the experts and practice can be skipped.');
  }
  if ('gate' in t && !(t.gate in TRAINING_GATES)) out.push('Choose what real study work waits for.');
  for (const k of ['tour', 'snippets_quiz_required']) {
    if (k in t && typeof t[k] !== 'boolean') out.push(`training.${k} is on or off (true or false).`);
  }
  return out;
}

/** Problems with the replay block, in plain words. */
export function replayProblems(rp) {
  const out = [];
  for (const k of ['enabled', 'trainees_watch_experts', 'trainees_see_crowd']) {
    if (k in rp && typeof rp[k] !== 'boolean') out.push(`replay.${k} is on or off (true or false).`);
  }
  return out;
}

/** The topographic map's signal for the study (display.topomap_filters and topomap_reference; js/annotate/topomap.js). */
export const TOPOMAP_FILTER_CHOICES = Object.freeze([['as_shown', 'As in the viewer'], ['none', 'None']]);
export const TOPOMAP_REFERENCE_CHOICES = Object.freeze([['as_recorded', 'As recorded'], ['average', 'Average of the good channels']]);

/** Problems with the topographic map's settings in the display block, in plain words. */
export function topomapProblems(d) {
  const out = [];
  if ('topomap' in d && typeof d.topomap !== 'boolean') out.push('display.topomap is on or off (true or false).');
  if ('topomap_filters' in d && !TOPOMAP_FILTER_CHOICES.some(([v]) => v === d.topomap_filters)) out.push('The topographic map\'s filters are as in the viewer or none.');
  if ('topomap_reference' in d && !TOPOMAP_REFERENCE_CHOICES.some(([v]) => v === d.topomap_reference)) out.push('The topographic map\'s reference is as recorded or the average of the good channels.');
  return out;
}

/** The most repeats a rule may ask for, and the longest wait in days (electrotag/config/settings.py). */
export const MAX_REPEATS = 10;
export const MAX_REPEAT_DAYS = 365;
const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Problems with the repeats block (repeat ratings for test-retest reliability), in plain words. */
export function repeatsProblems(rp) {
  const out = [];
  if ('enabled' in rp && typeof rp.enabled !== 'boolean') out.push('Repeat ratings are on or off (true or false).');
  const rules = rp.rules === undefined ? [] : rp.rules;
  if (!Array.isArray(rules) || rules.length > 50) return [...out, 'The repeat rules are a list of at most 50 rules.'];
  const ids = new Set();
  rules.forEach((r, i) => {
    const which = `Rule ${i + 1}${r && r.name ? ` (${r.name})` : ''}`;
    if (!r || typeof r !== 'object') { out.push(`${which} is not a rule.`); return; }
    if (typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(r.id) || ids.has(r.id)) out.push(`${which} needs an ID of its own.`);
    ids.add(r.id);
    if (r.name !== undefined && (typeof r.name !== 'string' || r.name.length > 100)) out.push(`${which}: the name is at most 100 characters.`);
    if (!['all', 'some', undefined].includes(r.recordings)) out.push(`${which} applies to all recordings or to some.`);
    if (r.recordings === 'some' && !((r.datasets || []).length || (r.recording_ids || []).length)) out.push(`${which} applies to some recordings: choose at least one dataset or recording.`);
    if (!whole(r.repeats ?? 1, 1, MAX_REPEATS)) out.push(`${which}: the number of repeats is a whole number from 1 to ${MAX_REPEATS}.`);
    if (!whole(r.interval_days ?? 14, 1, MAX_REPEAT_DAYS)) out.push(`${which}: the days between ratings are a whole number from 1 to ${MAX_REPEAT_DAYS}.`);
  });
  return out;
}

/** Problems with the review, training and replay blocks of a study's settings, and the topographic map's (settingsProblems has the others). */
export function expertSettingsProblems(s) {
  return [...reviewProblems(s.review || {}), ...trainingProblems(s.training || {}), ...replayProblems(s.replay || {}), ...topomapProblems(s.display || {}), ...repeatsProblems(s.repeats || {}),
    ...questionnaireProblems(s.questionnaire)]; // the sign-up questionnaire (questionnaire_model.js)
}

// ------------------------------------------------------------- the audit log's words for a change
// As electrotag/web/admin.py setting_changes: one entry for each value that changed, a group of settings
// gone through value by value, the questionnaire's questions by their IDs, a long list by what came and went.
const MAX_LISTED_VALUES = 10;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const withIds = (v) => Array.isArray(v) && v.every((x) => plainObject(x) && typeof x.id === 'string');

function valueText(v, unit = '') {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (plainObject(v) && !Object.keys(v).length)) return 'nothing';
  if (unit === 'uV' && typeof v === 'number') return `${Math.round(v * 1e12) / 1e6} µV`;
  return Array.isArray(v) ? (v.some(plainObject) ? `${v.length} items` : v.map((x) => valueText(x)).join(', '))
    : plainObject(v) ? Object.entries(v).map(([k, x]) => `${k} ${valueText(x)}`).join(', ') : String(v);
}

function changesOf(path, block, old, value) {
  if (same(old, value)) return [];
  const name = path[path.length - 1].replace(/_/g, ' ');
  const where = [block, ...path.slice(0, -1).map((p) => p.replace(/_/g, ' '))].join(' ');
  if (plainObject(old) && plainObject(value)) {
    return [...Object.keys(old), ...Object.keys(value).filter((k) => !(k in old))]
      .flatMap((k) => changesOf([...path, k], block, old[k], value[k]));
  }
  if (withIds(old) && withIds(value) && (old.length || value.length)) {
    const before = new Map(old.map((x) => [x.id, x]));
    const after = new Map(value.map((x) => [x.id, x]));
    const out = [...before.keys(), ...[...after.keys()].filter((i) => !before.has(i))].flatMap((i) => (!after.has(i) ? [`${name} ${i} (${where}) taken out`]
      : !before.has(i) ? [`${name} ${i} (${where}) added`] : changesOf([...path, i], block, before.get(i), after.get(i))));
    return out.length ? out : [`${name} (${where}) put in a new order`];
  }
  if (Array.isArray(old) && Array.isArray(value) && Math.max(old.length, value.length) > MAX_LISTED_VALUES) {
    const added = value.filter((x) => !old.some((y) => same(x, y)));
    const removed = old.filter((x) => !value.some((y) => same(x, y)));
    const said = [...(added.length ? [`added ${valueText(added)}`] : []), ...(removed.length ? [`took out ${valueText(removed)}`] : [])];
    return [said.length ? `${name} (${where}): ${said.join(' and ')}` : `${name} (${where}) put in a new order`];
  }
  const unit = block === 'display' && path[0] === 'scalings' ? 'uV' : '';
  return [`${name} (${where}) from ${valueText(old, unit)} to ${valueText(value, unit)}`];
}

/** What changed in one setting ('block.key'), in words for the audit log: nothing when the value is the same. */
export function settingChanges(key, old, value) {
  const [block, ...rest] = String(key).split('.');
  return changesOf(rest.join('.').split('.'), block, old, value);
}
