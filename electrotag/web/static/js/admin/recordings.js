// Recordings: the study's register. A list to filter by scope and status, a page per recording
// (notes, retire, remove), and adding recordings from this computer: the browser reads the files
// chosen (js/eeg/register.js builds each recording's manifest, as electrotag-web register does
// with MNE-Python), shows what it found and what failed, and sends only the manifests. The EEG
// never leaves this computer. Several recordings chosen in the list are assigned, retired, brought
// back into use or removed together; removing deletes only a registration, and a recording with
// saved results is always kept. Study recordings are added into a dataset (Datasets), chosen in the
// adding card; an ID that belongs to a recording of another dataset is pointed out before anything is sent.

import { h, clear } from '../ui/dom.js';
import { CAN_CHOOSE_FOLDER, acceptFiles, newId } from '../util.js';
import {
  bytesText, chunkManifests, durationText, duplicatesOf, failureText, formatName, manifestSummary, mergeRegisterResults, plural, progressText, scopeText,
  whenText,
} from './model.js';
import {
  STILL_RUNNING, actionButton, put, card, checkbox, chip, confirmInline, dataTable, eachInTurn, oneAtATime, field, infoTable, messageArea, progressLine, recordingName, resultsTable,
  sectionHead, select, textArea, textInput,
} from './ui.js';
import { DEFAULT_DATASET_ID, collisionsOf, datasetBody, prefixed } from './datasets_model.js';
import { findPositions, positionsText, withElectrodePositions } from './positions.js';
import { folderLine, recordingsFolder } from '../views/folder.js';

/** The module that reads recordings for the register (js/eeg/register.js); tests may replace it. */
export async function loadRegisterModule() {
  return import('../eeg/register.js');
}

/** What removing a recording takes with it, asked before it is removed. */
export function removeQuestion(r, where) {
  const given = r.assigned || 0;
  return `Remove the registration of ${r.recording_id} from ${where}? Its description is deleted${given ? `, and it is taken away from the ${plural(given, 'person', 'people')} it is assigned to; work in progress is kept by the study and comes back if the recording is added and assigned again. To keep the assignments, retire it instead` : ''}. The EEG file never reached the study and is not touched.`;
}

export class RecordingsSection {
  constructor(area) {
    this.area = area;
    this.recordings = [];
    this.sets = [];
    this.datasets = [];
    this.job = null; // 'reading' | 'registering' while one runs: they cannot be started twice
    this.found = null; // {manifests, failures} from the builder, waiting to be registered
    this.msg = messageArea();
    this.detail = h('div.admin-detail', { hidden: true });
    this._buildList();
    this._buildAdd();
    this.el = h('section.admin-section', { 'data-section': 'recordings' },
      sectionHead('Recordings', 'The recordings of the study and of its reference sets. Each is known by its description (its manifest): the EEG stays on the computers where the files are.'),
      this.msg,
      this.addCard, this.listCard, this.detail);
  }

  async show(params) {
    this.msg.clear();
    if (params.scope) this.filters.scope.value = params.scope;
    if (params.dataset) { this._wantDataset = params.dataset; this.addScope.value = 'study'; }
    await this.reload();
    if (params.dataset) setTimeout(() => this.addCard.scrollIntoView({ block: 'start' }), 0);
    if (params.recording) {
      const r = this.recordings.find((x) => x.recording_id === params.recording && (!params.scope || x.scope === params.scope));
      if (r) this.openDetail(r);
    }
  }

  async reload() {
    // An earlier, slower answer must not replace a newer one (a list read before a change).
    const turn = (this._turn = (this._turn || 0) + 1);
    this.listNote.textContent = 'Loading…';
    try {
      const [r, s, d] = await Promise.all([this.area.read('recordings_list'), this.area.read('sets_list').catch(() => ({ sets: [] })),
        this.area.read('datasets_list').catch(() => ({ datasets: [] }))]);
      if (turn !== this._turn) return;
      this.recordings = r.recordings || [];
      this.sets = s.sets || [];
      this.datasets = d.datasets || [];
      this.listNote.textContent = '';
    } catch (exc) {
      this.listNote.textContent = '';
      this.msg.problem(exc);
      return;
    }
    this._fillScopes();
    this._fillDatasets();
    this._filter();
    if (this.detailKey) this._renderDetail();
  }

  _scopes() {
    return [['study', 'The study'], ...this.sets.map((s) => [`set:${s.set_id}`, `Reference set: ${s.name || s.set_id}`])];
  }

  _fillScopes() {
    for (const [sel, first] of [[this.filters.scope, [['', 'Everywhere']]], [this.addScope, []]]) {
      const keep = sel.value;
      clear(sel);
      for (const [v, t] of [...first, ...this._scopes()]) sel.append(h('option', { value: v }, t));
      if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    }
  }

  /** The name of a dataset by its ID ('' and null are the built-in one). */
  _datasetName(id) {
    const d = this.datasets.find((x) => x.dataset_id === (id || DEFAULT_DATASET_ID));
    return d ? d.name || d.dataset_id : id || 'Study recordings';
  }

  _fillDatasets() {
    const f = this.filters.dataset;
    const keep = f.value;
    clear(f);
    f.append(h('option', { value: '' }, 'Every dataset'), ...this.datasets.map((d) => h('option', { value: d.dataset_id }, d.name || d.dataset_id)));
    f.value = this.datasets.some((d) => d.dataset_id === keep) ? keep : '';
    f.hidden = !this.datasets.length || this.filters.scope.value.startsWith('set:');
    const a = this.addDataset;
    const want = this._wantDataset || a.value || '';
    this._wantDataset = null;
    clear(a);
    const active = this.datasets.filter((d) => d.state !== 'archived');
    a.append(...active.map((d) => h('option', { value: d.dataset_id }, d.name || d.dataset_id)),
      h('option', { value: '__new' }, 'New dataset…'));
    a.value = active.some((d) => d.dataset_id === want) ? want : (active[0] ? active[0].dataset_id : '__new');
    this._datasetChanged();
  }

  /** The dataset chosen for adding, with its prefix ({id, prefix}), or null outside the study. */
  _target() {
    if ((this.addScope.value || 'study') !== 'study') return null;
    const d = this.datasets.find((x) => x.dataset_id === this.addDataset.value);
    return { id: d ? d.dataset_id : DEFAULT_DATASET_ID, prefix: d ? d.path_prefix || '' : '' };
  }

  _datasetChanged() {
    const study = (this.addScope.value || 'study') === 'study';
    this.datasetField.hidden = !study || !this.datasets.length;
    this.newDatasetHost.hidden = !study || !this.datasets.length || this.addDataset.value !== '__new';
    if (!this.newDatasetHost.hidden && !this.newDatasetHost.childNodes.length) this._newDatasetForm();
    if (this.found) this._showReview();
  }

  /** Make a dataset without leaving the page, then choose it for the recordings being added. */
  _newDatasetForm() {
    const host = this.newDatasetHost;
    clear(host);
    const msg = messageArea();
    const name = textInput({ placeholder: 'For example OpenNeuro ds003420', maxlength: 120 });
    const prefix = textInput({ placeholder: 'Optional, for example ds003420' });
    let requestId = null;
    const make = actionButton('Make the dataset', { kind: 'small primary', working: 'Making it…', msg, log: 'register-dataset-create', onClick: async () => {
      const body = datasetBody({ name: name.value, path_prefix: prefix.value }, { creating: true });
      requestId = requestId || newId();
      const r = await this.area.write('dataset_create', { ...body, request_id: requestId });
      requestId = null;
      this._wantDataset = r.dataset.dataset_id;
      clear(host);
      await this.reload();
      this.addMsg.show('success', `Made the dataset ${r.dataset.name}; the recordings will be added to it. Its licence, citation and other details are on the Datasets page.`);
    } });
    host.append(h('div.ds-inline-new', {}, h('div.form-grid', {}, field('Name of the new dataset', name),
      field('Path prefix', prefix, { hint: 'Put in front of each recording ID, so that its sub-001 keeps apart from another dataset\'s.' })),
    h('div.btn-row', {}, make), msg));
  }

  // ------------------------------------------------------------------ list
  _buildList() {
    const scope = select([['', 'Everywhere'], ['study', 'The study']]);
    scope.setAttribute('aria-label', 'Where');
    const status = select([['', 'In use and retired'], ['active', 'In use'], ['retired', 'Retired']]);
    status.setAttribute('aria-label', 'Status');
    const search = textInput({ type: 'search', placeholder: 'Search by name or ID' });
    search.setAttribute('aria-label', 'Search the recordings');
    const dataset = select([['', 'Every dataset']]);
    dataset.setAttribute('aria-label', 'Dataset');
    this.filters = { scope, dataset, status, search };
    for (const f of [scope, dataset, status, search]) f.addEventListener('input', () => this._filter());
    this.listNote = h('p.caption', { role: 'status' });
    this.bulkBar = h('div.bulk-bar', { hidden: true, role: 'region', 'aria-label': 'Act on the recordings chosen' });
    this.bulkResult = h('div.admin-stack.bulk-result');
    this.table = dataTable([
      { title: 'Recording', sort: (r) => r.file_name || r.recording_id, render: (r) => recordingName(r.recording_id, r.file_name) },
      { title: 'Where', sort: (r) => scopeText(r.scope, this.sets), render: (r) => scopeText(r.scope, this.sets) },
      { title: 'Dataset', sort: (r) => (r.scope === 'study' ? this._datasetName(r.dataset_id) : ''), render: (r) => (r.scope === 'study' ? this._datasetName(r.dataset_id) : h('span.caption', {}, '–')) },
      { title: 'Length', num: true, sort: (r) => r.duration_s, render: (r) => durationText(r.duration_s) },
      { title: 'Channels', num: true, sort: (r) => r.n_channels, render: (r) => String(r.n_channels ?? '') },
      { title: 'Done', num: true, sort: (r) => r.done ?? 0, render: (r) => `${r.done ?? 0} of ${r.assigned ?? 0}` },
      { title: 'Status', sort: (r) => (r.retired ? 1 : 0), render: (r) => h('span.chips-inline', {}, r.retired ? chip('Retired', 'warning') : chip('In use', 'done'),
        (r.warnings || []).length ? chip(plural(r.warnings.length, 'warning'), 'warning') : null) },
      { title: '', cls: 'actions', render: (r) => h('button.btn.small', { type: 'button', onclick: () => this.openDetail(r) }, 'Manage') },
    ], [], { empty: 'No recordings match. Add some from this computer.', rowKey: (r) => `${r.scope}|${r.recording_id}`, caption: 'Recordings',
      sortable: true, selectable: true, onSelect: (keys) => this._bulkBar(keys) });
    this.listCard = card('Registered recordings', h('div.row.filters', {}, scope, dataset, status, search), this.listNote, this.table, this.bulkBar, this.bulkResult);
  }

  /** The recordings of the list's keys ("scope|recording ID"). */
  _chosen(keys) {
    const want = new Set(keys);
    return this.recordings.filter((r) => want.has(`${r.scope}|${r.recording_id}`));
  }

  _bulkBar(keys) {
    clear(this.bulkBar);
    this.bulkBar.hidden = !keys.length;
    if (!keys.length) return;
    const chosen = this._chosen(keys);
    const study = chosen.filter((r) => r.scope === 'study');
    const msg = messageArea();
    const progress = progressLine();
    const name = (r) => recordingName(r.recording_id, r.file_name);
    const retire = (to) => actionButton(to ? 'Retire' : 'Bring back into use', { kind: 'small', working: 'Working…', msg, log: to ? 'bulk-retire' : 'bulk-unretire', onClick: async () => {
      const list = this._chosen(this.table.selected()).filter((r) => Boolean(r.retired) !== to);
      if (!list.length) throw new Error(to ? 'The recordings chosen are retired already.' : 'The recordings chosen are in use already.');
      await oneAtATime(this, async () => {
        const results = await eachInTurn(list, (r) => this.area.write('recording_update', { scope: r.scope, recording_id: r.recording_id, retired: to }),
          { progress, words: (i, n) => `${to ? 'Retiring' : 'Bringing back'} ${i} of ${n}…` });
        await this._showResults(results, name, () => (to ? 'Retired: offered for no new assignments; work already assigned stays.' : 'In use again: it can be assigned.'));
      });
    } });
    const removeHost = h('span.inline-confirm');
    removeHost.append(h('button.btn.small.destructive', { type: 'button', 'data-log': 'bulk-remove', onclick: async () => {
      if (this._bulkRunning) { msg.problem(new Error(STILL_RUNNING)); return; }
      const list = this._chosen(this.table.selected());
      const given = list.reduce((n, r) => n + (r.assigned || 0), 0);
      const yes = await confirmInline(removeHost, { text: `Remove the registration of ${plural(list.length, 'recording')}? Their descriptions are deleted from the study${given ? `, and their ${plural(given, 'assignment')} go with them; work in progress is kept by the study and comes back if a recording is added and assigned again. To keep the assignments, retire them instead` : ''}. The EEG files never reached the study and stay where they are. Recordings that someone has saved, or that a reference set uses, are kept.`,
        yes: `Remove ${plural(list.length, 'registration')}` });
      if (!yes) return;
      try {
        await oneAtATime(this, async () => {
          const results = await eachInTurn(list, (r) => this.area.write('recording_remove', { scope: r.scope, recording_id: r.recording_id }),
            { progress, words: (i, n) => `Removing ${i} of ${n}…` });
          for (const r of results) if (!r.ok && r.error && r.error.code === 'has_results') r.kept = true;
          await this._showResults(results, name, () => 'Removed: its registration is deleted.');
        });
      } catch (exc) { msg.problem(exc); }
    } }, 'Remove…'));
    this.bulkBar.append(
      h('p', {}, h('b', {}, `${plural(keys.length, 'recording')} chosen`)),
      h('div.btn-row', {},
        h('button.btn.small', { type: 'button', 'data-log': 'bulk-assign-to', disabled: !study.length,
          title: study.length ? null : 'Only the study\'s own recordings are assigned from here; training recordings come from their reference set.',
          onclick: () => this.area.go('assignments', { recordings: study.map((r) => r.recording_id) }) }, 'Assign to…'),
        retire(true), retire(false), removeHost,
        h('button.btn.small.quiet', { type: 'button', onclick: () => this.table.clearSelection() }, 'Clear the choice')),
      progress, msg);
  }

  /** What happened to each recording; recordings kept because of their results can be retired instead. */
  async _showResults(results, name, done) {
    this.table.clearSelection();
    await this.reload();
    clear(this.bulkResult);
    const kept = results.filter((r) => r.kept).map((r) => r.item);
    put(this.bulkResult, h('h3', {}, `Done for ${results.filter((r) => r.ok).length} of ${plural(results.length, 'recording')}`),
      kept.length ? h('div.banner', { role: 'status' },
        h('p', {}, h('b', {}, `${plural(kept.length, 'recording')} kept`), ': someone has saved annotations of them, or a reference set uses them, and research results are never deleted. Retire them instead, so that they are offered for no new assignments.'),
        h('div.btn-row', {}, actionButton(`Retire the ${plural(kept.length, 'kept recording')}`, { working: 'Retiring…', log: 'bulk-retire-kept', onClick: async () => {
          const again = await eachInTurn(kept.filter((r) => !r.retired), (r) => this.area.write('recording_update', { scope: r.scope, recording_id: r.recording_id, retired: true }));
          await this._showResults(again, name, () => 'Retired: offered for no new assignments.');
        } }))) : null,
      resultsTable(results, { name, done, title: 'Recording' }));
  }

  _filter() {
    const { scope, dataset, status, search } = this.filters;
    const q = search.value.trim().toLowerCase();
    dataset.hidden = !this.datasets.length || scope.value.startsWith('set:');
    const did = dataset.hidden ? '' : dataset.value;
    this.table.setEmpty(this.recordings.length ? 'No recordings match the filters.' : 'No recordings are registered yet. Add some from this computer.');
    this.table.update(this.recordings.filter((r) => (!scope.value || r.scope === scope.value) &&
      (!did || (r.scope === 'study' && (r.dataset_id || DEFAULT_DATASET_ID) === did)) &&
      (!status.value || (status.value === 'retired') === Boolean(r.retired)) &&
      (!q || `${r.recording_id} ${r.file_name || ''}`.toLowerCase().includes(q))), { keepPage: true });
  }

  // ---------------------------------------------------------------- detail
  openDetail(r) {
    this.detailKey = `${r.scope}|${r.recording_id}`;
    this._renderDetail();
    const h2 = this.detail.querySelector('h2');
    if (h2) { h2.tabIndex = -1; h2.focus({ preventScroll: false }); }
  }

  _renderDetail(note = null) {
    clear(this.detail);
    const r = this.recordings.find((x) => `${x.scope}|${x.recording_id}` === this.detailKey);
    if (!r) { this.detail.hidden = true; this.detailKey = null; return; }
    this.detail.hidden = false;
    const msg = messageArea();
    const notes = textArea({ value: r.notes || '', rows: 3, placeholder: 'For the study team, for example where the file came from' });
    const body = { scope: r.scope, recording_id: r.recording_id };
    const save = actionButton('Save notes', { kind: 'primary', working: 'Saving…', msg, onClick: async () => {
      await this.area.write('recording_update', { ...body, notes: notes.value });
      await this.reload();
      this._renderDetail(['success', 'Notes saved.']);
    } });
    const retire = actionButton(r.retired ? 'Bring back into use' : 'Retire', { working: 'Saving…', msg, onClick: async () => {
      await this.area.write('recording_update', { ...body, retired: !r.retired });
      await this.reload();
      this._renderDetail(['success', r.retired ? 'The recording can be assigned again.' : 'Retired: it is offered for no new assignments. Work already assigned stays.']);
    } });
    const removeHost = h('div.btn-row');
    removeHost.append(h('button.btn.destructive', { type: 'button', onclick: async () => {
      if (!(await confirmInline(removeHost, { text: removeQuestion(r, scopeText(r.scope, this.sets).toLowerCase()), yes: 'Remove it' }))) return;
      try {
        await this.area.write('recording_remove', body);
        this.detailKey = null;
        this.detail.hidden = true;
        this.msg.show('success', `${r.recording_id} has been removed.`);
        await this.reload();
      } catch (exc) { msg.problem(exc); }
    } }, 'Remove'));
    const close = h('button.btn.quiet', { type: 'button', onclick: () => { this.detailKey = null; this.detail.hidden = true; } }, 'Close');
    this.detail.append(card(null,
      h('div.card-head', {}, h('h2', {}, r.file_name || r.recording_id), close),
      msg,
      infoTable([
        ['Recording ID', r.recording_id], ['Where', scopeText(r.scope, this.sets)],
        r.scope === 'study' ? ['Dataset', h('button.link', { type: 'button', onclick: () => this.area.go('datasets', { dataset: r.dataset_id || DEFAULT_DATASET_ID }) }, this._datasetName(r.dataset_id))] : null,
        ['Format', formatName(r.format)],
        ['Length', `${durationText(r.duration_s)} at ${r.sfreq} Hz (${Number(r.n_samples || 0).toLocaleString('en-GB')} samples)`],
        ['Channels', String(r.n_channels ?? '')], ['Electrode positions', positionsText(r.electrode_positions || 'unset')], ['File size', bytesText(r.size_bytes)],
        ['Fingerprint', h('code.fingerprint', {}, r.sha256 || '–')],
        ['Added', `${whenText(r.registered_at)} by ${r.registered_by || '–'}${r.registered_via === 'browser' ? ', from a browser' : r.registered_via === 'command' ? ', with the command' : ''}`],
        ['Work', `${r.done ?? 0} of ${r.assigned ?? 0} done`],
      ]),
      (r.warnings || []).length ? h('div.banner', {}, h('p', {}, h('b', {}, 'Found when it was added')), h('ul', {}, r.warnings.map((w) => h('li', {}, w)))) : null,
      field('Notes', notes), h('div.btn-row', {}, save, retire),
      r.scope === 'study' && (r.done ?? 0) > 0 ? h('div.btn-row', {}, h('button.btn', { type: 'button', 'data-log': 'recording-overlay',
        title: 'Everyone\'s saved marks on this recording, over the EEG',
        onclick: async () => (await import('../expert/overlay.js')).startOverlay(this.area.app, { recording_id: r.recording_id },
          { route: 'admin-recordings', params: null }) }, 'Everyone\'s marks…')) : null,
      h('h3', {}, 'Remove'),
      h('p.caption', {}, 'Removing deletes the recording\'s registration, its description in the study; the EEG file never reached the study. A recording that someone has saved, or that a reference set uses, stays; retire it instead.'),
      removeHost));
    if (note) msg.show(...note);
  }

  // ---------------------------------------------------- adding from this computer
  _buildAdd() {
    this.addMsg = messageArea();
    this.addScope = select([['study', 'The study']], 'study');
    this.addScope.addEventListener('change', () => this._datasetChanged());
    this.addDataset = select([['', 'Study recordings']]);
    this.addDataset.addEventListener('change', () => this._datasetChanged());
    this.datasetField = field('Dataset', this.addDataset, { hint: 'The source dataset the recordings come from. Its details and licence are on the Datasets page.' });
    this.newDatasetHost = h('div.ds-new-host', { hidden: true });
    this.replace = checkbox('Replace recordings that are registered already (their description is updated)');
    const folderInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, hidden: true, 'data-log': 'register-folder',
      onchange: () => { const f = [...folderInput.files]; folderInput.value = ''; if (f.length) this.read(f); } });
    const filesInput = h('input', { type: 'file', multiple: true, hidden: true, 'data-log': 'register-files',
      accept: acceptFiles('.edf,.bdf,.rec,.vhdr,.vmrk,.eeg,.tsv,.json'),
      onchange: () => { const f = [...filesInput.files]; filesInput.value = ''; if (f.length) this.read(f); } });
    this.folderBtn = h('button.btn.primary', { type: 'button', hidden: !CAN_CHOOSE_FOLDER, onclick: () => folderInput.click() }, 'Choose a folder…');
    this.filesBtn = h(`button.btn${CAN_CHOOSE_FOLDER ? '' : '.primary'}`, { type: 'button', onclick: () => filesInput.click() }, 'Choose files…');
    // the administrator's recordings folder (js/views/folder.js), when they have one: read as if chosen
    this.myFolderBtn = h('button.btn', { type: 'button', hidden: true, 'data-log': 'register-my-folder', onclick: async () => {
      const f = recordingsFolder(this.area.app);
      const files = f ? await f.allFiles().catch(() => null) : null;
      if (!files) { this.addMsg.show('error', 'Your recordings folder could not be read. Choose the folder instead.'); return; }
      if (!files.length) { this.addMsg.show('error', 'There is no EEG recording in your recordings folder.'); return; }
      this.read(files);
    } }, 'Use my recordings folder');
    const mine = recordingsFolder(this.area.app);
    const showMine = () => {
      if (!mine || !mine.available) return;
      mine.state().then((st) => {
        this.myFolderBtn.hidden = !st;
        if (st) this.myFolderBtn.textContent = `Use my recordings folder (${st.name})`;
      }).catch(() => {});
    };
    showMine();
    this.folderLine = folderLine(this.area.app, { compact: true, onChange: showMine });
    this.progress = progressLine();
    this.review = h('div.admin-review');
    this.addCard = card('Add recordings from this computer',
      h('p', {}, 'Choose the dataset folder (or the files of some recordings). This browser reads each recording, works out its fingerprint and describes its channels, events and timing; only these descriptions are sent to the study, never the EEG.'),
      h('p.caption', {}, 'The folder you choose is the dataset folder: recording IDs are the paths inside it, for example sub-001/eeg/sub-001_task-rest_eeg.vhdr. BIDS sidecar files (channels.tsv, events.tsv) beside a recording are read too.'),
      CAN_CHOOSE_FOLDER ? null : h('p.note', {}, 'On an iPad, choose the files of the recordings: their names become their IDs. Choosing a whole dataset folder, with its paths, needs a computer.'),
      h('div.form-grid', {}, field('Add them to', this.addScope, { hint: 'Recordings for a reference set are only offered for training, never for study annotation.' }),
        this.datasetField),
      this.newDatasetHost,
      this.replace,
      h('div.btn-row', {}, this.folderBtn, this.myFolderBtn, this.filesBtn), folderInput, filesInput, this.folderLine,
      this.progress, this.addMsg, this.review);
  }

  _setJob(job) {
    this.job = job;
    for (const b of [this.folderBtn, this.myFolderBtn, this.filesBtn]) b.disabled = Boolean(job);
    this.addScope.disabled = job === 'registering';
    this.addDataset.disabled = job === 'registering';
    // when nothing runs, Add counts what it would add again (and stays off with nothing to add)
    if (this.registerBtn) { if (job || !this._countAdd || !this.found) this.registerBtn.disabled = Boolean(job); else this._countAdd(); }
  }

  /** Read the chosen files with the recording builder and show what was found. */
  async read(files) {
    if (this.job) return;
    this._setJob('reading');
    this.addMsg.clear();
    clear(this.review);
    this.found = null;
    this.progress.set(null, `Reading ${plural(files.length, 'file')}…`);
    try {
      let mod;
      let catalogue;
      try {
        mod = await loadRegisterModule();
        // Event codes are compared with ElectroTag's own catalogue, as electrotag-web register does.
        catalogue = (await import('../api/demo_catalogue.js')).CATALOGUE;
      } catch {
        throw new Error('This copy of ElectroTag cannot read recordings for the register yet. Update it, or register the recordings with the command electrotag-web register.');
      }
      let settings = {};
      try { settings = (await this.area.read('settings_get')).settings || {}; } catch { /* the builder's defaults */ }
      const scope = this.addScope.value || 'study';
      const out = await mod.buildManifests(files, {
        settings, scope, catalogue,
        onProgress: (p) => { const { text, fraction } = progressText(p); this.progress.set(fraction, text); },
      });
      this.found = { manifests: out.manifests || [], failures: out.failures || [], files: [...files], withPositions: null };
      this.found.positions = await findPositions(this.found.manifests, this.found.files);
      this.progress.hide();
      this._showReview();
    } catch (exc) {
      this.progress.hide();
      this.addMsg.problem(exc);
    } finally {
      this._setJob(null);
    }
  }

  _showReview() {
    clear(this.review);
    const { manifests, failures } = this.found;
    const rows = manifests.map((m) => ({ m, s: manifestSummary(m) }));
    const scope = this.addScope.value || 'study';
    const target = this._target();
    const prefix = target ? target.prefix : '';
    // IDs registered already in another dataset: the study skips them even with Replace (a prefix keeps them apart).
    const elsewhere = target ? collisionsOf(manifests, this.recordings.filter((r) => r.scope === 'study'), target.id, prefix) : new Map();
    const known = new Set(this.recordings.filter((r) => r.scope === scope && !elsewhere.has(r.recording_id)).map((r) => r.recording_id));
    const isKnown = (rid) => known.has(prefixed(rid, prefix)) && !elsewhere.has(rid);
    // Byte-identical copies, of a registered recording or of another one found here: skipped unless confirmed.
    // (compared under the IDs they will have: a prefix makes a copy of a registered recording another ID)
    const same = new Map([...duplicatesOf(manifests.map((m) => ({ ...m, recording_id: prefixed(m.recording_id, prefix) })),
      this.recordings.filter((r) => r.scope === scope))].map(([rid, other]) => [prefix && rid.startsWith(`${prefix}/`) ? rid.slice(prefix.length + 1) : rid, other]));
    const table = dataTable([
      { title: 'Recording', render: ({ s }) => h('span', {}, recordingName(prefixed(s.recordingId, prefix)), isKnown(s.recordingId) ? h('span.chip.warning', {}, 'registered already') : null,
        elsewhere.has(s.recordingId) ? h('span.chip.warning', { 'data-elsewhere': elsewhere.get(s.recordingId) }, `in the dataset ${this._datasetName(elsewhere.get(s.recordingId))}`) : null,
        same.has(s.recordingId) ? h('span.chip.warning', { 'data-duplicate': same.get(s.recordingId) }, `same file as ${same.get(s.recordingId)}`) : null) },
      { title: 'Format', render: ({ s }) => formatName(s.format) },
      { title: 'Channels', num: true, render: ({ s }) => `${s.nChannels}${s.nHidden ? ` (+${s.nHidden} hidden)` : ''}` },
      { title: 'Length', num: true, render: ({ s }) => durationText(s.durationS) },
      { title: 'Electrode positions', render: ({ m }) => this._positionsCell(m) },
      { title: 'Warnings', render: ({ s }) => (s.warnings.length ? h('ul.warnings', {}, s.warnings.map((w) => h('li', {}, w))) : '–') },
    ], rows, { empty: 'No recordings were found among these files.', pageSize: 20, caption: 'Recordings found' });
    this.allowCopies = checkbox('Add the copies too (each is then annotated as a recording of its own)');
    this.registerBtn = h('button.btn.primary', { type: 'button', 'data-log': 'register', onclick: () => this.register() });
    // The button counts what will be added: recordings registered already only with Replace, copies only when ticked.
    const count = () => {
      if (!this.found) return; // added, or started again: nothing waits
      if (this.found.withPositions === null) {
        this.registerBtn.textContent = 'Choose whether to add electrode positions';
        this.registerBtn.disabled = true;
        return;
      }
      const n = manifests.filter((m) => !elsewhere.has(m.recording_id) && (this.replace.input.checked || !isKnown(m.recording_id)) && (this.allowCopies.input.checked || !same.has(m.recording_id))).length;
      this.registerBtn.textContent = n ? `Add ${plural(n, 'recording')}` : 'Nothing to add';
      this.registerBtn.disabled = !n;
    };
    this._countAdd = count;
    this._reviewTable = () => table.update(rows, { keepPage: true });
    this.allowCopies.input.addEventListener('change', count);
    this.replace.input.onchange = count;
    count();
    const again = h('button.btn', { type: 'button', onclick: () => { this.found = null; clear(this.review); this.addMsg.clear(); } }, 'Start again');
    put(this.review, 
      h('h3', {}, `Found ${plural(manifests.length, 'recording')}`),
      target && this.datasets.length ? h('p.caption', {}, `Into the dataset ${this._datasetName(target.id)}${prefix ? `, with their IDs starting ${prefix}/` : ''}.`) : null,
      table,
      this._posBlock = this._positionsBlock(),
      elsewhere.size ? h('div.banner.elsewhere', { role: 'status' },
        h('p', {}, h('b', {}, `${plural(elsewhere.size, 'recording')} ${elsewhere.size === 1 ? 'has' : 'have'} the ID of a recording in another dataset`),
          ', so the study leaves them as they are, even when replacing. If they are different recordings (two BIDS datasets that both have sub-001, for example), '
          + 'add them to a new dataset with a path prefix, which keeps the two apart.')) : null,
      same.size ? h('div.banner.duplicates', { role: 'status' },
        h('p', {}, h('b', {}, `${plural(same.size, 'recording')} ${same.size === 1 ? 'is' : 'are'} the same file as another`),
          ' (the same fingerprint), under another ID. Each would be assigned and annotated as a separate recording, which inflates the counts and the agreement, so copies are skipped.'),
        this.allowCopies) : null,
      failures.length ? h('div.banner.failures', { role: 'status' },
        h('p', {}, h('b', {}, `${plural(failures.length, 'file')} could not be read`)),
        h('ul', {}, failures.map((f) => h('li', {}, h('span.file', {}, f.path || f.recording_id || '?'), `: ${failureText(f.path || f.recording_id, f.reason)}`)))) : null,
      h('div.btn-row', {}, this.registerBtn, again));
  }

  // ---------------------------------------------------- electrode positions
  _positionsCell(m) {
    const f = this.found && this.found.positions ? this.found.positions.get(m.recording_id) : null;
    if (!f) return '–';
    if (this.found.withPositions === false) return h('span.caption', {}, 'None: no topographic map');
    return f.source === 'file' ? h('span', { title: f.fileName }, `${f.fileName} (${plural(f.placed, 'channel')})`)
      : f.source === 'standard' ? 'Standard positions of the channel names' : h('span.chip.warning', {}, 'none found');
  }

  /** After a change of the positions: the table's column, the block under it and Add, the rest of the review as it was. */
  _positionsChanged() {
    this._reviewTable();
    const block = this._positionsBlock();
    this._posBlock.replaceWith(block);
    this._posBlock = block;
    this._countAdd();
  }

  /**
   * The question asked before Add: with or without electrode positions, for the topographic map. With them,
   * the line under the question says where each recording's come from, and Choose position files… adds
   * electrodes.tsv files (with their coordsystem.json) to those already chosen.
   */
  _positionsBlock() {
    const found = this.found;
    const counts = { file: 0, standard: 0, none: 0 };
    for (const f of found.positions.values()) counts[f.source] += 1;
    const choice = h('div.radio-col', { role: 'radiogroup', 'aria-label': 'Electrode positions' });
    const option = (value, text, hint) => {
      const input = h('input', { type: 'radio', name: `positions-${this.addKey || (this.addKey = newId())}`, value: String(value), 'data-log': value ? 'positions-with' : 'positions-without' });
      input.checked = found.withPositions === value;
      input.addEventListener('change', () => { found.withPositions = value; this._positionsChanged(); });
      return h('label.check', {}, input, h('span', {}, text, h('span.caption.block', {}, hint)));
    };
    choice.append(
      option(true, 'Add them with their electrode positions', 'From each recording\'s electrodes.tsv, or the standard positions of its channel names where those are 10-20 names.'),
      option(false, 'Add them without electrode positions', 'They will have no topographic map.'));
    const picker = h('input', { type: 'file', multiple: true, hidden: true, 'data-log': 'positions-files', accept: acceptFiles('.tsv,.json'),
      onchange: async () => {
        const more = [...picker.files];
        picker.value = '';
        if (!more.length) return;
        found.files.push(...more);
        found.positions = await findPositions(found.manifests, found.files);
        this._positionsChanged();
      } });
    const where = [counts.file ? `${plural(counts.file, 'recording')} from ${counts.file === 1 ? 'its' : 'their'} electrodes.tsv` : '',
      counts.standard ? `${plural(counts.standard, 'recording')} from the standard positions of ${counts.standard === 1 ? 'its' : 'their'} channel names` : ''].filter(Boolean);
    return h('div.positions-choice', {},
      h('h3', {}, 'Electrode positions'),
      h('p.caption', {}, 'The topographic map beside the EEG needs to know where each electrode is. Only the electrodes\' places on the map are sent, never the files.'),
      choice,
      found.withPositions === false ? h('div.banner.positions-none', { role: 'status' },
        h('p', {}, h('b', {}, 'Without electrode positions these recordings have no topographic map'),
          ' while they are annotated. To give them one later, add them again with their positions and Replace ticked.')) : null,
      found.withPositions === true ? h('div.positions-with', {},
        where.length ? h('p', {}, `Positions for ${where.join(' and ')}.`) : null,
        counts.none ? h('div.banner.positions-missing', { role: 'status' },
          h('p', {}, h('b', {}, `No positions were found for ${plural(counts.none, 'recording')}`),
            ': no electrodes.tsv among the files chosen belongs to ', counts.none === 1 ? 'it' : 'them',
            ', and the channel names are not standard 10-20 names. Choose their electrodes.tsv files, or ', counts.none === 1 ? 'it is' : 'they are', ' added without a topographic map.')) : null,
        h('div.btn-row', {}, h('button.btn.small', { type: 'button', onclick: () => picker.click() }, 'Choose position files…'), picker)) : null);
  }

  /** Send the manifests found, in groups small enough for one request each. */
  async register() {
    if (this.job || !this.found || !this.found.manifests.length) return;
    this._setJob('registering');
    this.addMsg.clear();
    const scope = this.addScope.value || 'study';
    const target = this._target();
    if (target && this.datasets.length && this.addDataset.value === '__new') {
      this._setJob(null);
      this.addMsg.show('error', 'Make the new dataset first, or choose one of the list.');
      return;
    }
    if (this.found.withPositions === null) {
      this._setJob(null);
      this.addMsg.show('error', 'Choose whether to add the recordings with their electrode positions or without them.');
      return;
    }
    const manifests = this.found.manifests.map((m) => ({ ...withElectrodePositions(m, this.found.positions.get(m.recording_id), this.found.withPositions), scope }));
    const groups = chunkManifests(manifests);
    const batch = newId(); // the parts of one registration, shown as one change in the records
    const results = [];
    let sent = 0;
    try {
      for (const group of groups) {
        this.progress.set(sent / manifests.length, `Adding ${sent + 1}–${sent + group.length} of ${manifests.length}…`);
        const body = { scope, manifests: group, replace: this.replace.input.checked, batch_id: batch };
        if (target && this.datasets.length) body.dataset_id = target.id;
        if (this.allowCopies && this.allowCopies.input.checked) body.allow_duplicates = true;
        results.push(await this.area.write('recordings_register', body));
        sent += group.length;
      }
    } catch (exc) {
      this.progress.hide();
      const done = mergeRegisterResults(results);
      this.addMsg.problem(exc);
      if (sent) this.addMsg.append(h('p.caption', {}, `${plural(done.added.length + done.replaced.length, 'recording')} had been added before this happened. Choose Add again to send the rest: those added already are skipped.`));
      this._setJob(null);
      await this.reload();
      return;
    }
    this.progress.hide();
    const r = mergeRegisterResults(results);
    this.found = null;
    clear(this.review);
    const list = (items) => h('ul.compact', {}, items.slice(0, 50).map((x) => h('li.file', {}, x)), items.length > 50 ? h('li', {}, `and ${items.length - 50} more`) : null);
    put(this.review, h('div.success', { role: 'status' },
      h('p', {}, h('b', {}, `Added ${plural(r.added.length, 'recording')}${r.replaced.length ? `, replaced ${r.replaced.length}` : ''}${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}.`)),
      r.added.length ? list(r.added) : null),
      r.replaced.length ? h('div.note', {}, h('p', {}, h('b', {}, 'Replaced')), list(r.replaced)) : null,
      r.skipped.length ? h('div.banner', {}, h('p', {}, h('b', {}, 'Skipped')),
        h('ul', {}, r.skipped.map((x) => h('li', {}, h('span.file', {}, x.recording_id), `: ${x.reason}`)))) : null,
      r.added.length && scope === 'study' ? h('div.btn-row', {}, h('button.btn', { type: 'button', 'data-log': 'register-assign', onclick: () => this.area.go('assignments', { recordings: [...r.added] }) }, 'Assign them…')) : null);
    this._setJob(null);
    await this.reload();
  }
}
