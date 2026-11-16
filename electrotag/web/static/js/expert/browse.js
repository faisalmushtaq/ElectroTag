// Find training recordings, a section of the expert area (docs/admin_area.md, "Looking for training recordings"): the
// datasets the study team has given the expert to look through, then one dataset's recordings with the expert's own
// rating (Yes, Maybe or No, changed here or while looking), their note and marks, and where their request stands.
// Open looks at a recording (js/expert/browse_pass.js); Ask asks for one recording, or for every recording ticked, to
// be added to the training material, which the study team approves into a training set in Training.

import { h, clear } from '../ui/dom.js';
import { inform } from '../ui/dialog.js';
import { whenText } from '../admin/model.js';
import { friendlyDuration } from '../util.js';
import { card, chip, dataTable, loading, messageArea, recordingName, sectionHead, select } from '../admin/ui.js';
import { BROWSE_FILTERS, RATINGS, STATUS_WORDS, askable, canAsk, filterRows, marksText, requestText } from './browse_model.js';

export class BrowseSection {
  constructor(area) {
    this.area = area;
    this.msg = messageArea();
    this.host = h('div.admin-stack');
    this.datasetId = null;
    this.filter = '';
    this.el = h('section.admin-section', { 'data-section': 'browse' },
      sectionHead('Find training recordings', 'Look through the datasets the study team has given you, rate each recording for training and ask for the good ones to be added. '
        + 'Your marks, notes and ratings here are yours alone: they are never saved as study work, exported or analysed.'),
      this.msg, this.host);
  }

  async show(params = {}) {
    this.msg.clear();
    this.datasetId = params && params.dataset ? String(params.dataset) : null;
    if (params && params.filter !== undefined) this.filter = String(params.filter || '');
    clear(this.host);
    this.host.append(loading());
    try {
      if (this.datasetId) await this._dataset();
      else await this._datasets();
    } catch (exc) {
      clear(this.host);
      this.msg.problem(exc);
    }
  }

  async _datasets() {
    const got = await this.area.read('browse_datasets_list');
    clear(this.host);
    const list = got.datasets || [];
    if (!list.length) {
      this.host.append(card(null, h('p.caption', {}, 'No dataset has been given to you to look through yet. The study team gives datasets to experts on each dataset\'s page, under Data.')));
      return;
    }
    if (got.everything) this.host.append(h('p.caption', {}, 'As an administrator you may look through every dataset of the study.'));
    for (const d of list) {
      this.host.append(card(d.name || d.dataset_id,
        d.description ? h('p.caption', {}, d.description) : null,
        h('p', {}, `${d.n_recordings} recording${d.n_recordings === 1 ? '' : 's'} · ${d.n_rated} rated by you · ${d.n_requested} asked for`),
        h('div.btn-row', {}, h('button.btn.primary', { type: 'button', 'data-log': 'browse-dataset', 'data-dataset': d.dataset_id,
          onclick: () => this.area.go('browse', { dataset: d.dataset_id }) }, 'Look through it'))));
    }
  }

  async _dataset() {
    const got = await this.area.read('browse_recordings_list', { dataset_id: this.datasetId });
    this.rows = got.recordings || [];
    this.dataset = got.dataset || { dataset_id: this.datasetId };
    this._draw();
  }

  _back() { return { route: 'expert-browse', params: { dataset: this.datasetId, filter: this.filter } }; }

  _draw() {
    clear(this.host);
    const app = this.area.app;
    const filter = select(BROWSE_FILTERS, this.filter);
    filter.setAttribute('aria-label', 'Show');
    filter.dataset.log = 'browse-filter';
    filter.addEventListener('change', () => { this.filter = filter.value; this.table.update(filterRows(this.rows, this.filter)); });
    const askBtn = h('button.btn.primary', { type: 'button', 'data-log': 'browse-ask-chosen', disabled: true, onclick: () => this._ask(this.table.selectedRows()) }, 'Ask for the chosen recordings');
    const ratingCell = (r) => h('span.segmented.browse-rating.small', { role: 'radiogroup', 'aria-label': `Good for training: ${r.file_name}` },
      RATINGS.map(([value, text]) => h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(r.rating === value), 'data-rating': value, 'data-log': 'browse-rate',
        onclick: () => this._rate(r, r.rating === value ? null : value) }, text)));
    const columns = [
      { title: 'Recording', sort: (r) => r.file_name, render: (r) => recordingName(r.recording_id, r.file_name) },
      { title: 'Length', num: true, sort: (r) => r.duration_s, render: (r) => friendlyDuration(r.duration_s) },
      { title: 'Good for training?', sort: (r) => r.rating || '', render: ratingCell },
      { title: 'Yours', render: (r) => h('span', {}, h('span.caption.block', { title: marksText(r.n_annotations, r.labels) }, r.n_annotations ? marksText(r.n_annotations, {}) : 'No marks'),
        r.has_note ? chip('Note', 'active') : null, r.updated_at ? h('span.caption.block', {}, `Changed ${whenText(r.updated_at)}`) : null) },
      { title: 'Training', sort: (r) => (r.request ? r.request.status : ''), render: (r) => (r.request && STATUS_WORDS[r.request.status]
        ? h('span', { title: requestText(r.request) }, chip(STATUS_WORDS[r.request.status][0], STATUS_WORDS[r.request.status][1]),
          r.request.status === 'approved' ? h('span.caption.block', {}, r.request.set_name || r.request.set_id) : null) : '–') },
      { title: '', render: (r) => h('span.row-actions', {},
        h('button.btn.small', { type: 'button', 'data-log': 'browse-open', 'data-recording': r.recording_id, title: 'Open it from this computer to look through it',
          onclick: async () => (await import('./browse_pass.js')).startBrowse(app, r.recording_id, this._back()) }, 'Open'),
        canAsk(r) ? h('button.btn.small', { type: 'button', 'data-log': 'browse-ask', 'data-recording': r.recording_id, onclick: () => this._ask([r]) }, 'Ask') : null) },
    ];
    this.table = dataTable(columns, filterRows(this.rows, this.filter), { empty: this.rows.length ? 'No recording matches this filter.' : 'This dataset has no recordings in use.',
      pageSize: 50, sortable: true, selectable: true, rowKey: (r) => r.recording_id, caption: `The recordings of ${this.dataset.name || this.datasetId}`,
      onSelect: () => {
        const a = askable(this.table.selectedRows());
        askBtn.textContent = a.label;
        askBtn.disabled = !a.rows.length;
      } });
    this.host.append(
      h('div.btn-row', {}, h('button.btn.quiet.back', { type: 'button', 'data-log': 'browse-datasets', onclick: () => this.area.go('browse') }, 'All your datasets')),
      card(this.dataset.name || this.datasetId,
        this.dataset.description ? h('p.caption', {}, this.dataset.description) : null,
        h('p.caption', {}, 'Open a recording from this computer to look through it: you can mark artifacts, keep a note and rate it as you go. '
          + 'Tick recordings and ask for them all at once, or ask for one with Ask.'),
        h('div.row.filters', {}, filter, askBtn),
        this.table));
  }

  async _rate(row, value) {
    try {
      await this.area.write('browse_save', { recording_id: row.recording_id, rating: value });
      row.rating = value;
      this.table.update(filterRows(this.rows, this.filter), { keepPage: true });
    } catch (exc) {
      if (exc.status !== 401) this.msg.problem(exc);
    }
  }

  async _ask(rows) {
    const want = askable(rows).rows;
    if (!want.length) return;
    try {
      const out = await this.area.write('training_request', { recording_ids: want.map((r) => r.recording_id) });
      const by = new Map((out.requests || []).map((r) => [r.recording_id, r]));
      for (const r of this.rows) if (by.has(r.recording_id)) r.request = by.get(r.recording_id);
      this.table.clearSelection();
      this.table.update(filterRows(this.rows, this.filter), { keepPage: true });
      const n = (out.requested || []).length;
      this.msg.show('success', n ? `Asked for ${n} recording${n === 1 ? '' : 's'}. The study team sees your requests in Training.` : 'Those recordings were asked for already.');
    } catch (exc) {
      if (exc.status !== 401) await inform('The request was not sent', exc.message);
    }
  }
}
