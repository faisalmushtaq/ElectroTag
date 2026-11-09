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

/** Whether a marked artifact is already in the list `existing` (quiz items or snippets: recording, start, end, type). */
export function alreadyAdded(a, recordingId, existing) {
  return (existing || []).some((x) => x.recording_id === recordingId && Math.abs(Number(x.start_s) - a.onset_s) < 0.0015
    && Math.abs(Number(x.end_s) - a.offset_s) < 0.0015 && (x.label || x.correct_label) === a.label);
}

/**
 * The list of a recording's marked artifacts in the set `setId`. `onPick(artifact)` runs when one is chosen.
 * With `onAddMany(artifacts)`, each row also has a box to tick, with Select all and Add the chosen, to add several
 * at once; `existing()` gives what the set already has (an artifact already added is marked Added and cannot be
 * chosen again). Returns {el, show(recordingId)}: show lists the artifacts of that recording (again when it changes).
 */
export function artifactPicker(area, setId, { onPick, what = 'segment', existing = () => [], onAddMany = null, many = 'items' }) {
  const status = h('p.caption', { role: 'status' });
  const filter = h('select.field.artifact-filter', { 'aria-label': 'Which type of artifact to list', 'data-log': 'artifact-filter' });
  const list = h('ul.artifact-list', { 'data-log': 'artifact-list' });
  const more = h('button.btn.small.quiet', { type: 'button', hidden: true, 'data-log': 'artifact-more' }, 'Show more');
  const all = h('button.btn.small', { type: 'button', hidden: true, 'data-log': 'artifact-select-all' }, 'Select all');
  const addMany = h('button.btn.small.primary', { type: 'button', hidden: true, disabled: true, 'data-log': 'artifact-add-chosen' }, `Add the chosen ${many}`);
  const manyMsg = h('p.caption', { role: 'status' });
  let notes = [];
  let shown = PAGE;
  let chosen = null;
  let ticked = new Set();
  let rid = '';
  let token = 0;
  const free = () => artifactsOf(notes, filter.value).filter((a) => !alreadyAdded(a, rid, existing()));
  const sync = () => {
    const n = ticked.size;
    addMany.disabled = !n;
    addMany.textContent = n ? `Add the ${n} chosen ${n === 1 ? many.replace(/s$/, '') : many}` : `Add the chosen ${many}`;
    const f = free();
    all.textContent = f.length && f.every((a) => ticked.has(a.annotation_id)) ? 'Select none' : 'Select all';
    all.disabled = !f.length;
  };
  const render = () => {
    clear(list);
    const rows = artifactsOf(notes, filter.value);
    for (const a of rows.slice(0, shown)) {
      const added = alreadyAdded(a, rid, existing());
      const b = h('button.artifact-pick', { type: 'button', 'aria-pressed': String(chosen === a.annotation_id), 'data-log': 'artifact-pick', disabled: added,
        title: added ? `Already added: the set has this ${what}` : null,
        onclick: () => { chosen = a.annotation_id; render(); onPick(a); } }, artifactText(a));
      const box = onAddMany ? h('input.artifact-tick', { type: 'checkbox', 'aria-label': `Choose ${artifactText(a)}`, disabled: added, checked: ticked.has(a.annotation_id),
        onchange: (e) => { if (e.target.checked) ticked.add(a.annotation_id); else ticked.delete(a.annotation_id); sync(); } }) : null;
      list.append(h(`li${added ? '.added' : ''}`, {}, box, b, added ? h('span.caption.artifact-added', {}, 'Added') : null));
    }
    more.hidden = rows.length <= shown;
    more.textContent = `Show more (${rows.length - shown} more)`;
    sync();
  };
  more.addEventListener('click', () => { shown += PAGE; render(); });
  filter.addEventListener('change', () => { shown = PAGE; render(); });
  all.addEventListener('click', () => {
    const f = free();
    if (f.length && f.every((a) => ticked.has(a.annotation_id))) f.forEach((a) => ticked.delete(a.annotation_id));
    else f.forEach((a) => ticked.add(a.annotation_id));
    render();
  });
  addMany.addEventListener('click', async () => {
    const picked = notes.filter((a) => ticked.has(a.annotation_id) && !alreadyAdded(a, rid, existing()));
    if (!picked.length || addMany.dataset.busy === '1') return;
    addMany.dataset.busy = '1';
    addMany.disabled = true;
    manyMsg.textContent = `Adding ${picked.length}…`;
    try {
      await onAddMany(picked, rid);
      ticked = new Set();
    } catch (exc) {
      manyMsg.textContent = exc && exc.message ? exc.message : String(exc);
    } finally {
      delete addMany.dataset.busy;
      if (manyMsg.textContent.startsWith('Adding')) manyMsg.textContent = '';
      render();
    }
  });
  const show = async (recordingId) => {
    const mine = ++token;
    notes = [];
    chosen = null;
    ticked = new Set();
    rid = recordingId || '';
    clear(list);
    filter.hidden = true;
    more.hidden = true;
    all.hidden = true;
    addMany.hidden = true;
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
    all.hidden = !onAddMany;
    addMany.hidden = !onAddMany;
    status.textContent = `Choose one of the ${notes.length} artifacts the experts marked: its times fill in below, and it is shown on the EEG once the recording is open there.`
      + (onAddMany ? ` Or tick several, or Select all, and add them at once with Add the chosen ${many}.` : '');
    render();
  };
  const el = h('div.artifact-picker', { 'data-part': 'artifact-picker' }, status, h('div.row.wrap', {}, filter, all), list, more,
    onAddMany ? h('div.btn-row', {}, addMany) : null, manyMsg);
  return { el, show, refresh: render };
}
