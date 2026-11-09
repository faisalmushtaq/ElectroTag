// Artifact type descriptions (docs/admin_area.md, "Artifact type descriptions"): under Training, for administrators
// and, in the expert area, for experts. For each type of the catalogue, its description (shown on the type
// buttons, in the type picker, in training and in the artifact reference guide) and every written part of its
// guide entry (where, frequency, shape, duration and how to tell it from its look-alikes) can be put in the study's
// own words, or set back to the original. Each change is sent once and kept in the audit log (artifact_text_set).
//
// fieldChanges is pure and tested in Node (web_tests/unit/ui_admin_artifact_texts.test.mjs).

import { h, clear } from '../ui/dom.js';
import { Catalogue } from '../catalogue.js';
import { GUIDE } from '../guide/artifacts.js';
import { actionButton, card, chip, field, loading, messageArea, select, textArea } from './ui.js';
import { whenText } from './model.js';

export const TEXT_FIELDS = Object.freeze([
  ['description', 'Description', 'The definition: on the type buttons, in the type picker, in training and at the top of the guide\'s entry.'],
  ['where', 'Where', 'Where on the scalp it shows.'],
  ['frequency', 'Frequency', ''],
  ['shape', 'Shape', ''],
  ['duration', 'Duration', ''],
]);

/** The original words of a type: the catalogue's description and the guide's entry. */
export function originalOf(label, originals) {
  const g = GUIDE[label] || {};
  return { description: (originals && originals[label]) || '', where: g.where || '', frequency: g.frequency || '', shape: g.shape || '',
    duration: g.duration || '', apart: (g.apart || []).map(([l, t]) => [l, t]) };
}

/**
 * What to send for a type's form: each field whose words differ from those shown before (the study's own, or the
 * original), as text, or null to go back to the original when the words typed are the original's again.
 */
export function fieldChanges(typed, shown, original) {
  const out = {};
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [k] of TEXT_FIELDS) {
    const t = String(typed[k] ?? '').trim();
    if (t === String(shown[k] ?? '').trim()) continue;
    out[k] = t === String(original[k] ?? '').trim() ? null : t;
  }
  const rows = (typed.apart || []).map(([l, t]) => [l, String(t || '').trim()]).filter(([l, t]) => l && t);
  if (!same(rows, shown.apart || [])) out.apart = same(rows, original.apart || []) ? null : rows;
  return out;
}

/** The card, drawn once it is opened. */
export function artifactTextsCard(area) {
  const body = h('div.admin-stack');
  const box = h('details.admin-details.artifact-texts', { 'data-part': 'artifact-texts' },
    h('summary', {}, 'Artifact type descriptions'),
    h('p.caption', {}, 'Put any artifact type\'s description, and the words of its entry in the artifact reference guide, in the study\'s own words. '
      + 'Annotators and trainees see them at once; the example pictures stay as they are. Each change is kept in the audit log, and Use the original takes it back.'),
    body);
  let drawn = false;
  box.addEventListener('toggle', () => {
    if (!box.open || drawn) return;
    drawn = true;
    void draw(area, body);
  });
  return card(null, box);
}

async function draw(area, body, keep = null) {
  clear(body);
  body.append(loading());
  let data;
  try {
    data = await area.read('artifact_texts_list');
  } catch (exc) {
    clear(body);
    const msg = messageArea();
    body.append(msg);
    msg.problem(exc);
    return;
  }
  clear(body);
  const labels = (area.catalogue && area.catalogue.labels) || [];
  const which = select(labels.map((l) => [l.label, `${l.label}${data.texts[l.label] ? ' (the study\'s own words)' : ''}`]), keep || (labels[0] && labels[0].label));
  const formHost = h('div.admin-stack');
  body.append(field('Artifact type', which), formHost);
  const show = () => form(area, formHost, which.value, data, () => draw(area, body, which.value));
  which.addEventListener('change', show);
  show();
}

function form(area, host, label, data, redraw) {
  clear(host);
  const original = originalOf(label, data.original);
  const own = (data.texts[label] && data.texts[label].fields) || {};
  const shown = { ...original, ...own };
  const msg = messageArea();
  const inputs = {};
  const send = async (fields) => {
    await area.write('artifact_text_set', { label, fields });
    await refreshCatalogue(area);
    await redraw();
  };
  for (const [k, name, hint] of TEXT_FIELDS) {
    inputs[k] = textArea({ value: shown[k] || '', rows: k === 'description' ? 3 : 2 });
    inputs[k].dataset.field = k;
    const changed = k in own;
    const back = changed ? actionButton('Use the original', { kind: 'small quiet', working: 'Saving…', msg, log: 'artifact-text-original',
      onClick: () => send({ [k]: null }) }) : null;
    host.append(h('div.artifact-text-field', {}, field(name, inputs[k], { hint, wide: true }),
      h('div.btn-row', {}, changed ? chip('The study\'s own words', 'active') : h('span.caption', {}, 'The original'), back)));
  }
  // the look-alikes: a type and how to tell them apart, each
  const rows = h('div.artifact-apart');
  const types = (area.catalogue && area.catalogue.labels) || [];
  const addRow = (l = '', t = '') => {
    const s = select(types.filter((x) => x.label !== label).map((x) => [x.label, x.label]), l);
    const how = textArea({ value: t, rows: 2 });
    const row = h('div.artifact-apart-row', {}, s, how,
      h('button.btn.small.quiet', { type: 'button', 'data-log': 'artifact-apart-remove', onclick: () => row.remove() }, 'Remove'));
    row.read = () => [s.value, how.value];
    rows.append(row);
  };
  for (const [l, t] of shown.apart || []) addRow(l, t);
  const changedApart = 'apart' in own;
  host.append(h('div.artifact-text-field', {}, h('p.form-label', {}, 'Telling it apart'), rows,
    h('div.btn-row', {}, h('button.btn.small', { type: 'button', 'data-log': 'artifact-apart-add', onclick: () => addRow() }, 'Add a look-alike'),
      changedApart ? chip('The study\'s own words', 'active') : h('span.caption', {}, 'The original'),
      changedApart ? actionButton('Use the original', { kind: 'small quiet', working: 'Saving…', msg, log: 'artifact-text-original', onClick: () => send({ apart: null }) }) : null)));
  const save = actionButton('Save', { kind: 'primary', working: 'Saving…', msg, log: 'artifact-text-save', onClick: async () => {
    const typed = Object.fromEntries(TEXT_FIELDS.map(([k]) => [k, inputs[k].value]));
    typed.apart = [...rows.children].map((r) => r.read());
    if (!typed.description.trim()) throw new Error('The description cannot be empty: write the study\'s own words, or use the original.');
    const changes = fieldChanges(typed, shown, original);
    if (!Object.keys(changes).length) { msg.show('note', 'Nothing has changed.'); return; }
    await send(changes);
  } });
  const t = data.texts[label];
  host.append(h('div.btn-row', {}, save), t ? h('p.caption', {}, `Last changed by ${t.changed_by || 'the study team'}, ${whenText(t.changed_at)}.`) : null, msg);
}

/** The person's own catalogue again (GET /me), so that the words they changed show at once. */
async function refreshCatalogue(area) {
  const app = area.app;
  if (!app || !app.backend || !app.me) return;
  try {
    const me = await app.backend.me();
    if (me && me.catalogue) {
      app.me.catalogue = me.catalogue;
      app.catalogue = new Catalogue(me.catalogue);
    }
  } catch { /* the next page load brings them */ }
}
