// Looking for training recordings, as the study team sees it (docs/admin_area.md, "Looking for training recordings";
// the operations in docs/api.md, "Looking for training recordings"):
//
// * accessCard, on a dataset's page: which experts may look through the whole dataset, ticked one by one;
// * requestsCard, in Training: the experts' requests for recordings to be added to the training material, ticked and
//   approved into a training set chosen from a list that ends with A new training set…, or declined;
// * waitingCard, on a training set's page: the recordings approved into it that await annotation;
// * coverageCard, in Training: how far the training sets cover the artifact types that need training material.
//
// The sandbox has no stand-in for these operations (they are kept with the study's records), so there each card says
// that it needs a study server or Firebase without asking (DEMO_NOTE); the coverage card works there too.

import { h, clear } from '../ui/dom.js';
import { whenText, checkSetId, plural } from './model.js';
import { actionButton, card, chip, dataTable, field, loading, messageArea, recordingName, select, textInput } from './ui.js';
import { RATING_WORDS, STATUS_WORDS, coverageRows, coverageSummary, marksText, requiredTypes } from '../expert/browse_model.js';

/** The value of the list's last choice, which opens the form for a new training set. */
export const NEW_SET = '__new__';
const REQUEST_FILTERS = [['pending', 'Waiting for a decision'], ['approved', 'Approved'], ['declined', 'Declined'], ['', 'Every request']];

/** What the sandbox says in place of these cards. */
export const DEMO_NOTE = 'The demonstration cannot keep experts\' requests for training recordings or who may look through a dataset: that needs a study server or Firebase.';

/** A card whose contents come from the study, with the card's own message when they cannot be read. */
function loadingCard(title, ...intro) {
  const body = h('div.admin-stack', {}, loading());
  const msg = messageArea();
  return { el: card(title, ...intro, msg, body), body, msg };
}

/** In the sandbox: the card says what it needs instead of asking (true when it did). */
function demoOnly(area, c) {
  if (!area.isDemo && !(area.backend && area.backend.isDemo)) return false;
  clear(c.body);
  c.body.append(h('p.note', {}, DEMO_NOTE));
  return true;
}

// ------------------------------------------------------------------ a dataset's experts
/** On a dataset's page: the experts who may look through all of it for training recordings. */
export function accessCard(area, dataset) {
  const did = dataset.dataset_id;
  const c = loadingCard('Experts looking for training recordings',
    h('p.caption', {}, 'Tick an expert to let them look through every recording of this dataset, from their own copy of the files, and ask for the ones that suit training. '
      + 'What they mark and write while looking is theirs alone: it is never saved as study work, exported or analysed. Administrators may look through every dataset.'));
  const draw = (got) => {
    clear(c.body);
    const experts = got.experts || [];
    const given = new Map((got.grants || []).filter((g) => g.dataset_id === did).map((g) => [g.annotator_id, g]));
    if (!experts.length) { c.body.append(h('p.caption', {}, 'The study has no experts yet. Give someone the expert role in People first.')); return; }
    for (const e of experts) {
      const g = given.get(e.annotator_id);
      const box = h('input', { type: 'checkbox', 'data-expert': e.annotator_id, 'data-log': 'dataset-browse-access' });
      box.checked = Boolean(g);
      box.addEventListener('change', async () => {
        box.disabled = true;
        c.msg.clear();
        try {
          const out = await area.write('browse_access_set', { dataset_id: did, annotator_id: e.annotator_id, access: box.checked });
          c.msg.show('success', box.checked ? `${e.annotator_id} may look through this dataset now.` : `${e.annotator_id} can no longer look through this dataset.`);
          draw(out);
        } catch (exc) {
          box.checked = !box.checked;
          box.disabled = false;
          c.msg.problem(exc);
        }
      });
      c.body.append(h('label.check-item', {}, box, h('span.check-text', {}, h('span', {}, e.annotator_id, e.display_name ? ` (${e.display_name})` : ''),
        g ? h('span.caption.block', {}, `Since ${whenText(g.granted_at)}${g.granted_by ? `, given by ${g.granted_by}` : ''}`) : null)));
    }
  };
  if (!demoOnly(area, c)) area.read('browse_access_list', { dataset_id: did }).then(draw, (exc) => { clear(c.body); c.msg.problem(exc); });
  return c.el;
}

// ------------------------------------------------------------------ the experts' requests
/** The list of training sets to approve requests into, ending with A new training set…. */
export function setChoices(sets) {
  return [['', 'Choose a training set'], ...(sets || []).map((s) => [s.set_id, s.name && s.name !== s.set_id ? `${s.name} (${s.set_id})` : s.set_id]), [NEW_SET, 'A new training set…']];
}

/**
 * In Training: the experts' requests. `section` is the Training section (its area, and reload() once a new set is
 * made); the card reads training_requests_list itself.
 */
export function requestsCard(section) {
  const area = section.area;
  let status = 'pending';
  let data = null;
  const c = loadingCard('Recordings the experts asked for',
    h('p.caption', {}, 'Experts given a dataset to look through ask for the recordings that suit training. Tick requests and approve them into a training set: '
      + 'each recording then waits in the set, Awaiting annotation, until the experts annotate it properly and you add its reference under Recordings and references.'));
  const filter = select(REQUEST_FILTERS, status);
  filter.setAttribute('aria-label', 'Show');
  filter.dataset.log = 'requests-filter';
  const target = select(setChoices([]), '');
  target.setAttribute('aria-label', 'Training set');
  target.dataset.log = 'requests-set';
  const newId = textInput({ placeholder: 'for example blinks-2026' });
  const newName = textInput({ placeholder: 'for example Blinks and eye movements' });
  const newForm = h('div.form-grid.requests-new-set', { hidden: true },
    field('Identifier of the new set', newId, { hint: 'Letters, digits, dots, hyphens or underscores; it cannot be changed.' }), field('Its name', newName));
  target.addEventListener('change', () => { newForm.hidden = target.value !== NEW_SET; });
  const reason = textInput({ placeholder: 'optional, shown to the expert' });
  reason.setAttribute('aria-label', 'Why they are declined');
  let table = null;
  const chosen = () => (table ? table.selectedRows() : []);
  const approve = actionButton('Approve into the set', { kind: 'primary', working: 'Approving…', msg: c.msg, log: 'requests-approve', onClick: async () => {
    const rows = chosen();
    if (!rows.length) throw new Error('Tick the requests to approve first.');
    let setId = target.value;
    if (!setId) throw new Error('Choose the training set the recordings go into.');
    if (setId === NEW_SET) {
      const id = checkSetId(newId.value);
      const made = await area.write('set_create', { set_id: id, name: newName.value.trim() });
      setId = (made.set && made.set.set_id) || id;
    }
    const out = await area.write('training_requests_decide', { request_ids: rows.map((r) => r.request_id), decision: 'approve', set_id: setId });
    newId.value = '';
    newName.value = '';
    newForm.hidden = true;
    draw(out);
    target.value = setId;
    c.msg.show('success', `${plural(out.decided, 'request')} approved: the recordings await annotation in ${setId}.`);
    if (section.afterApproval) await section.afterApproval(setId);
  } });
  const decline = actionButton('Decline', { working: 'Declining…', msg: c.msg, log: 'requests-decline', onClick: async () => {
    const rows = chosen();
    if (!rows.length) throw new Error('Tick the requests to decline first.');
    const out = await area.write('training_requests_decide', { request_ids: rows.map((r) => r.request_id), decision: 'decline', reason: reason.value.trim() });
    reason.value = '';
    draw(out);
    c.msg.show('success', `${plural(out.decided, 'request')} declined.`);
  } });
  const columns = [
    { title: 'Recording', sort: (r) => r.file_name, render: (r) => h('span', {}, recordingName(r.recording_id, r.file_name), h('span.caption.block', {}, r.dataset_name || r.dataset_id)) },
    { title: 'Asked for by', sort: (r) => r.annotator_id, render: (r) => h('b', {}, r.annotator_id) },
    { title: 'Rating', sort: (r) => r.rating_now || r.rating || '', render: (r) => RATING_WORDS[r.rating_now || r.rating] || '–' },
    { title: 'Their marks', render: (r) => h('span.caption', {}, marksText(r.n_annotations, r.labels)) },
    { title: 'Asked', sort: (r) => r.requested_at || '', render: (r) => whenText(r.requested_at) },
    { title: 'Status', sort: (r) => r.status, render: (r) => h('span', {}, chip(...(STATUS_WORDS[r.status] || [r.status, ''])),
      r.set_id ? h('span.caption.block', {}, r.set_name || r.set_id) : null, r.reason ? h('span.caption.block', {}, r.reason) : null) },
  ];
  const draw = (got) => {
    data = got;
    clear(c.body);
    const keep = target.value;
    const fresh = select(setChoices(got.sets), keep);
    target.replaceChildren(...fresh.childNodes);
    target.value = [...target.options].some((o) => o.value === keep) ? keep : '';
    newForm.hidden = target.value !== NEW_SET;
    const rows = (got.requests || []).filter((r) => !status || r.status === status);
    const counts = got.counts || {};
    table = dataTable(columns, rows, { empty: status === 'pending' ? 'No requests are waiting for a decision.' : 'No requests here.', pageSize: 25, sortable: true,
      selectable: true, rowKey: (r) => r.request_id, caption: 'Requests for training recordings' });
    c.body.append(h('div.row.filters', {}, filter, h('span.caption', {}, `${counts.pending || 0} waiting, ${counts.approved || 0} approved, ${counts.declined || 0} declined`)),
      table,
      h('div.row.controls.requests-actions', {}, target, approve), newForm,
      h('div.row.controls.requests-actions', {}, reason, decline));
  };
  filter.addEventListener('change', () => { status = filter.value; if (data) draw(data); });
  c.reload = () => area.read('training_requests_list').then(draw, (exc) => { clear(c.body); c.msg.problem(exc); });
  if (!demoOnly(area, c)) c.reload();
  c.el.reload = c.reload;
  return c.el;
}

// ------------------------------------------------------------------ a set's recordings awaiting annotation
/** On a training set's page: the recordings approved into it whose reference is not in the set yet. */
export function waitingCard(area, set) {
  const c = loadingCard('Awaiting annotation',
    h('p.caption', {}, 'Recordings approved into this set from the experts\' requests. Give them to the experts to annotate properly (Giving out work), '
      + 'then add each one\'s reference above, from their saved annotations: it then leaves this list by itself.'));
  const draw = (got) => {
    clear(c.body);
    const rows = got.waiting || [];
    if (!rows.length) { c.body.append(h('p.caption', {}, 'No recordings await annotation in this set.')); return; }
    c.body.append(dataTable([
      { title: 'Recording', sort: (r) => r.file_name, render: (r) => recordingName(r.recording_id, r.file_name) },
      { title: 'Asked for by', render: (r) => r.requested_by.map((a) => `${a}${r.ratings[a] ? ` (${RATING_WORDS[r.ratings[a]]})` : ''}`).join(', ') },
      { title: 'Approved', sort: (r) => r.approved_at || '', render: (r) => `${whenText(r.approved_at)}${r.approved_by ? ` by ${r.approved_by}` : ''}` },
      { title: '', render: (r) => h('button.btn.small.quiet.destructive-text', { type: 'button', 'data-log': 'waiting-remove', 'data-recording': r.recording_id,
        onclick: async () => {
          try { draw(await area.write('training_waiting_remove', { set_id: set.set_id, recording_id: r.recording_id })); } catch (exc) { c.msg.problem(exc); }
        } }, 'Take off the list') },
    ], rows, { pageSize: 25, sortable: true, rowKey: (r) => r.recording_id, caption: 'Recordings awaiting annotation' }));
  };
  if (!demoOnly(area, c)) area.read('training_waiting_list', { set_id: set.set_id }).then(draw, (exc) => { clear(c.body); c.msg.problem(exc); });
  return c.el;
}

// ------------------------------------------------------------------ coverage of the artifact types
/** In Training: for each artifact type that needs training material, the examples the training sets hold. */
export function coverageCard(area) {
  const c = loadingCard('Artifact types that need training material',
    h('p.caption', {}, 'The types chosen in Study settings, under Training policy (the types on the number keys 1 to 9 until you choose), '
      + 'with the experts\' reference marks of each in the training sets and the quiz answers of it.'));
  Promise.all([area.read('settings_get'), area.read('training_types_get')]).then(([s, t]) => {
    clear(c.body);
    const rows = coverageRows(requiredTypes(s.settings), t.sets);
    c.body.append(h('p', { class: rows.some((r) => r.missing) ? 'note' : null }, coverageSummary(rows)));
    if (!rows.length) return;
    c.body.append(dataTable([
      { title: 'Artifact type', sort: (r) => r.label, render: (r) => r.label },
      { title: 'Reference marks', num: true, sort: (r) => r.marks, render: (r) => (r.missing ? chip('None yet', 'warning') : String(r.marks)) },
      { title: 'Quiz answers', num: true, sort: (r) => r.quiz, render: (r) => String(r.quiz) },
      { title: 'In the sets', render: (r) => h('span.caption', {}, r.sets.join(', ') || '–') },
    ], rows, { pageSize: 50, sortable: true, rowKey: (r) => r.label, caption: 'Coverage of the artifact types that need training material' }));
  }, (exc) => { clear(c.body); c.msg.problem(exc); });
  return c.el;
}
