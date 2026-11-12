// Before the study starts, in the sandbox (as electrotag/web/preregistration.py): the agreement settings saved as
// the study's (settings.preregistration.agreement), the measure of working time with the idle threshold, and the
// repeat ratings, each confirmed by an administrator with the values confirmed. Loaded by demo_admin.js when the
// admin area asks, so that the sign-in page never needs it.

import { ApiError } from './http.js';
import { nowLocalIso } from '../util.js';
import { defaultAnalysisConfig } from '../admin/model.js';
import { PREREGISTERED_AGREEMENT_KEYS } from '../admin/settings_checks.js';

export const ITEMS = { agreement: 'agreement settings', working_time: 'measure of working time', repeats: 'repeat ratings' };

/** JSON with its keys in order, so that two values compare whatever order their keys came in. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const same = (a, b) => canonical(a) === canonical(b);

/** The settings of each group as they are now. */
export function currentValues(settings) {
  const pr = settings.preregistration || {};
  const rp = settings.repeats || {};
  const d = defaultAnalysisConfig();
  const agreement = pr.agreement ? Object.fromEntries(PREREGISTERED_AGREEMENT_KEYS.map((k) => [k, k in pr.agreement ? pr.agreement[k] : d[k]])) : null;
  return {
    agreement,
    working_time: { measure: pr.working_time || 'active_s', idle_after_s: Number((settings.logging || {}).idle_after_s ?? 30) },
    repeats: { enabled: rp.enabled === true,
      rules: (rp.rules || []).map((r) => ({ id: r.id, name: String(r.name || '').trim(), recordings: r.recordings === 'some' ? 'some' : 'all',
        datasets: [...new Set(r.datasets || [])], recording_ids: [...new Set(r.recording_ids || [])],
        repeats: Number(r.repeats ?? 1), interval_days: Number(r.interval_days ?? 14) })) },
  };
}

/** When the first study recording was saved (research annotation only). */
export function studyStartedAt(submissions) {
  const times = (submissions || []).filter((s) => (s.mode || 'standard') === 'standard' && s.saved_at).map((s) => s.saved_at);
  return times.length ? times.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)) : null;
}

/** preregistration_get, from the admin state and the saved work. */
export function status(admin) {
  const values = currentValues(admin.s.settings);
  const records = admin.s.preregistration || {};
  const started = studyStartedAt(admin.b.state.submissions);
  const items = Object.keys(ITEMS).map((item) => {
    const rec = records[item] || null;
    const state = rec === null ? 'not_confirmed' : same(rec.values, values[item]) ? 'confirmed' : 'changed';
    return {
      item, state, values: values[item], ready: values[item] !== null,
      confirmed_values: rec ? rec.values : null, confirmed_at: rec ? rec.confirmed_at : null, confirmed_by: rec ? rec.confirmed_by : null,
      before_start: rec === null ? null : started === null || Date.parse(rec.confirmed_at) < Date.parse(started),
    };
  });
  return { items, study_started_at: started, done: items.every((i) => i.state === 'confirmed') };
}

/** preregistration_confirm {item}: keeps the values confirmed, by whom and when (audited when it changes anything). */
export function confirm(admin, body) {
  const item = body.item;
  if (!Object.hasOwn(ITEMS, item)) throw new ApiError(400, 'bad_request', `item must be one of ${Object.keys(ITEMS).join(', ')}`);
  const values = currentValues(admin.s.settings)[item];
  if (values === null) {
    throw new ApiError(409, 'not_saved', 'The study has no agreement settings of its own yet. Choose them on the Analyses page and save them as the study\'s, then confirm them.');
  }
  const records = admin.s.preregistration || (admin.s.preregistration = {});
  const old = records[item];
  if (!old || !same(old.values, values)) {
    records[item] = { item, values, confirmed_at: nowLocalIso(), confirmed_by: admin.b.annotatorId || 'unknown', times_confirmed: ((old || {}).times_confirmed || 0) + 1 };
    const started = studyStartedAt(admin.b.state.submissions);
    admin._audit('preregistration_confirm', `Confirmed the ${ITEMS[item]}${started ? ' after the study started' : ''}`, { item, values, study_started_at: started });
  }
  return status(admin);
}
