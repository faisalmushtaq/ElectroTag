// Choosing a segment from the artifacts the experts marked, for a quiz item or a snippet (Training, the Quiz and
// Snippets tabs; docs/admin_area.md, "Quiz" and "Snippets"): the recording's reference in the set is listed, one
// artifact a row with its type, times and channels, which a filter by type narrows; choosing one fills in the
// form's times (and type, and channels) and shows it on the EEG when the recording is open there. The times can
// still be changed by hand, or given for a recording the set holds no reference for.

import { h, clear } from '../ui/dom.js';

/** How many artifacts are listed at once; Show more lists the next ones. */
export const PAGE = 40;

/** One artifact in words: "Eye-blink-artifact · 3.10 to 3.52 s · Fp1, Fp2". */
export function artifactText(a) {
  const ch = (a.channels || []).length ? a.channels.join(', ') : 'whole montage';
  return `${a.label} · ${Number(a.onset_s).toFixed(2)} to ${Number(a.offset_s).toFixed(2)} s · ${ch}`;
}

/** The artifacts of a type ('' for every type), in time order. */
export function artifactsOf(notes, label = '') {
  return [...(notes || [])].filter((a) => !label || a.label === label).sort((x, y) => x.onset_s - y.onset_s || (x.label < y.label ? -1 : 1));
}

/**
 * The list of a recording's marked artifacts in the set `setId`. `onPick(artifact)` runs when one is chosen.
 * Returns {el, show(recordingId)}: show lists the artifacts of that recording (again when it changes).
 */
export function artifactPicker(area, setId, { onPick, what = 'segment' }) {
  const status = h('p.caption', { role: 'status' });
  const filter = h('select.field.artifact-filter', { 'aria-label': 'Which type of artifact to list', 'data-log': 'artifact-filter' });
  const list = h('ul.artifact-list', { 'data-log': 'artifact-list' });
  const more = h('button.btn.small.quiet', { type: 'button', hidden: true, 'data-log': 'artifact-more' }, 'Show more');
  let notes = [];
  let shown = PAGE;
  let chosen = null;
  let token = 0;
  const render = () => {
    clear(list);
    const rows = artifactsOf(notes, filter.value);
    for (const a of rows.slice(0, shown)) {
      const b = h('button.artifact-pick', { type: 'button', 'aria-pressed': String(chosen === a.annotation_id), 'data-log': 'artifact-pick',
        onclick: () => { chosen = a.annotation_id; render(); onPick(a); } }, artifactText(a));
      list.append(h('li', {}, b));
    }
    more.hidden = rows.length <= shown;
    more.textContent = `Show more (${rows.length - shown} more)`;
  };
  more.addEventListener('click', () => { shown += PAGE; render(); });
  filter.addEventListener('change', () => { shown = PAGE; render(); });
  const show = async (recordingId) => {
    const mine = ++token;
    notes = [];
    chosen = null;
    clear(list);
    filter.hidden = true;
    more.hidden = true;
    if (!recordingId) { status.textContent = ''; return; }
    status.textContent = 'Reading the experts\' marks of this recording…';
    let got;
    try {
      got = await area.read('set_guided_notes', { set_id: setId, recording_id: recordingId });
    } catch (exc) {
      if (mine !== token) return;
      status.textContent = exc && exc.code === 'not_in_set'
        ? `The set holds no reference for this recording, so there are no marked artifacts to choose from: give the ${what}'s times below.`
        : `The experts' marks could not be read: ${exc.message}. Give the ${what}'s times below.`;
      return;
    }
    if (mine !== token) return;
    notes = got.notes || [];
    if (!notes.length) { status.textContent = `The reference of this recording marks no artifacts: give the ${what}'s times below.`; return; }
    const types = [...new Set(notes.map((a) => a.label))].sort();
    filter.replaceChildren(h('option', { value: '' }, `Every type (${notes.length})`),
      ...types.map((t) => h('option', { value: t }, `${t} (${notes.filter((a) => a.label === t).length})`)));
    filter.hidden = types.length < 2;
    status.textContent = `Choose one of the ${notes.length} artifacts the experts marked: its times fill in below, and it is shown on the EEG once the recording is open there.`;
    render();
  };
  const el = h('div.artifact-picker', { 'data-part': 'artifact-picker' }, status, filter, list, more);
  return { el, show };
}
