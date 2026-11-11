// Repeat ratings in the sandbox (settings.repeats, as electrotag/web/service.py _schedule_repeats): a study
// recording covered by a rule is offered again as a new recording, with no saved history shown, once the rule's
// days have passed since the previous rating was first saved, up to the rule's number of repeats. Loaded by
// demo.js only while repeats are switched on, so that the sign-in page never needs it.

const DAY_MS = 864e5;
const DEFAULT_DATASET = 'study-recordings';

/** The first rule that covers a recording (rules are applied in order), or undefined. */
export function ruleFor(rules, rid, datasetId) {
  return (rules || []).find((x) => x.recordings !== 'some' || (x.datasets || []).includes(datasetId) || (x.recording_ids || []).includes(rid));
}

/** Mark the items of `backend._workItems` whose next repeat is due: status todo (or in_progress with a draft), retest n. */
export function schedule(backend, items, now = Date.now()) {
  const rp = backend._admin.s.settings.repeats;
  if (!rp || !rp.enabled) return;
  for (const i of items) {
    if (i.status !== 'done' || i.mode !== 'standard' || i.source !== 'assignment' || i.revising) continue;
    const rule = ruleFor(rp.rules, i.rid, (i.info.record || {}).dataset_id || DEFAULT_DATASET);
    if (!rule) continue;
    const list = backend._attempts(i.key);
    const n = Math.max(0, ...list.map((x) => x.retest || 0));
    const first = list.find((x) => (x.retest || 0) === n);
    if (!first || n >= rule.repeats || now < Date.parse(first.saved_at) + rule.interval_days * DAY_MS) continue;
    Object.assign(i, { status: backend.state.drafts[i.key] ? 'in_progress' : 'todo', retest: n + 1, retest_rule: rule.id, saved: null });
  }
}
