// Results: everyone's progress (GET /admin/progress, the operation `progress`), and every result
// of the study as one zip file (results_zip), or the command that exports them when they are too
// large to send through the page; and the interaction logs, all of them or those chosen, as one zip
// file (logs_zip, electrotag/web/log_download.py).

import { h, clear } from '../ui/dom.js';
import { MODES, STATUS, bytesText, csvText, fileParts, programmeText, progressCounts, whenText } from './model.js';
import { actionButton, card, checkList, checkbox, chip, dataTable, downloadBase64, downloadText, field, messageArea, recordingName, sectionHead, textInput } from './ui.js';
import { allReviewsCard, reviewButton, reviewCount } from './reviews.js';
import { savedWorkButtons, withdrawnCard } from './saved_work.js';

export class ResultsSection {
  constructor(area) {
    this.area = area;
    this.rows = [];
    this.recordings = [];
    this.msg = messageArea();
    this.note = h('p.caption', { role: 'status' });
    this.table = dataTable([
      { title: 'Annotator', render: (r) => h('span', {}, h('b', {}, r.annotator_id), r.display_name ? h('span.caption.block', {}, r.display_name) : null) },
      { title: 'Done', num: true, render: (r) => `${r.c.done} of ${r.c.assigned}` },
      { title: 'In progress', num: true, render: (r) => String(r.c.in_progress) },
      { title: 'To do', num: true, render: (r) => String(r.c.todo) },
      { title: 'Cannot be annotated', num: true, render: (r) => String(r.c.unusable || 0) },
      { title: 'Training', render: (r) => (r.programme ? h('span', {}, h('span.caption.block', {}, r.programme.name || r.programme.set_id || ''), programmeText(r.programme)) : '–') },
      { title: 'Last seen', render: (r) => whenText(r.last_seen) },
      { title: '', cls: 'actions', render: (r) => h('button.btn.small', { type: 'button', onclick: () => this._showWork(r) }, 'Work') },
    ], [], { empty: 'Nobody is in the study yet.', pageSize: 25, caption: 'Each person\'s work' });
    this.work = h('div.admin-stack');
    const csv = h('button.btn', { type: 'button', 'data-log': 'results-csv', onclick: () => this._downloadTable() }, 'Download the table (CSV)');
    this.reviews = allReviewsCard();
    this.zipMsg = messageArea();
    const zip = actionButton('Download all results (zip)', { kind: 'primary', working: 'Preparing the zip…', msg: this.zipMsg, log: 'results-zip', onClick: () => this._zip() });
    // Names and contact details go into the zip only when asked for, as contacts.csv (docs/admin_area.md, "Results").
    this.contacts = checkbox('Include names and contact details (contacts.csv)', false);
    this.contacts.input.dataset.log = 'results-contacts';
    const contactsWarning = h('p.banner.contacts-warning', { hidden: true }, 'contacts.csv identifies people: keep it apart from the research data and share it only with the study team. The download is noted in the audit log.');
    this.contacts.input.addEventListener('change', () => { contactsWarning.hidden = !this.contacts.input.checked; });
    this.el = h('section.admin-section', { 'data-section': 'results' },
      sectionHead('Results', 'Who has done what, and every saved result of the study.'),
      this.msg,
      card('Each person\'s work', h('p.caption', {}, 'Each person\'s recordings and training, with Work to see them one by one and review what was saved. Progress has the figures, times and the pace.'),
        this.note, this.table, h('div.btn-row', {}, csv)), this.work, this.reviews,
      card('All results',
          h('p', {}, 'The annotations (in ElectroTag\'s usual folders: _annotations.json, _events.tsv, _session.json for each recording and annotator), the interaction logs, the training progress and the reports, and the answers to the sign-up questionnaire by annotator ID, as one zip file.'),
          this.contacts, contactsWarning,
          h('div.btn-row', {}, zip), this.zipMsg),
      this.logsCard());
  }

  /** The interaction logs as one zip file: everyone's, or those of the people, sessions, days and recordings ticked. */
  logsCard() {
    this.logsMsg = messageArea();
    this.logsPeople = h('div');
    this.logsRecordings = h('div');
    this.logsModes = Object.entries(MODES).map(([v, t]) => ({ v, box: checkbox(t, true) }));
    for (const m of this.logsModes) m.box.input.dataset.log = `logs-mode-${m.v}`;
    this.logsFrom = textInput({ type: 'date', name: 'logs-from' });
    this.logsTo = textInput({ type: 'date', name: 'logs-to' });
    const go = actionButton('Download the interaction logs (zip)', { working: 'Preparing the logs…', msg: this.logsMsg, log: 'logs-zip', onClick: () => this._logsZip() });
    const el = card('Interaction logs',
      h('p', {}, 'Each visit\'s log of clicks, keys and what was on screen, from signing in to signing out, as one zip file with a list of the visits (visits.tsv). Leave everything as it is for every log, or narrow it down: nobody ticked means everyone, and a visit chosen for a recording keeps all of its events.'),
      h('div.admin-grid', {}, this.logsPeople, this.logsRecordings),
      h('fieldset.admin-fieldset', {}, h('legend', {}, 'Sessions'), h('div.row.wrap', {}, this.logsModes.map((m) => m.box))),
      h('div.form-grid', {}, field('Visits begun from', this.logsFrom, { hint: 'The first day, or empty for the first visit.' }),
        field('Visits begun up to', this.logsTo, { hint: 'The last day, or empty for today.' })),
      h('div.btn-row', {}, go), this.logsMsg);
    el.dataset.card = 'logs';
    return el;
  }

  /** The people and recordings to choose from, as they are now, keeping what was ticked. */
  _fillLogChoices() {
    const keepPeople = this.logsPeopleList ? this.logsPeopleList.values() : [];
    const keepRecordings = this.logsRecordingList ? this.logsRecordingList.values() : [];
    this.logsPeopleList = checkList(this.rows.map((r) => ({ value: r.annotator_id, text: r.annotator_id, extra: r.display_name || '' })),
      { selected: keepPeople, legend: 'People (none ticked: everyone)', name: 'logs-people', empty: 'Nobody is in the study yet.' });
    this.logsRecordingList = checkList(this.recordings.map((r) => ({ value: r.recording_id, text: r.file_name || fileParts(r.recording_id).name, extra: fileParts(r.recording_id).folder })),
      { selected: keepRecordings, legend: 'Visits that opened (none ticked: any or none)', name: 'logs-recordings', empty: 'No recordings are in the study yet.' });
    clear(this.logsPeople);
    this.logsPeople.append(this.logsPeopleList);
    clear(this.logsRecordings);
    this.logsRecordings.append(this.logsRecordingList);
  }

  /** What is chosen, as logs_zip takes it (docs/api.md): only what narrows the logs is sent. */
  logsBody() {
    const body = {};
    const people = this.logsPeopleList ? this.logsPeopleList.values() : [];
    const recordings = this.logsRecordingList ? this.logsRecordingList.values() : [];
    const modes = this.logsModes.filter((m) => m.box.input.checked).map((m) => m.v);
    if (people.length) body.annotator_ids = people;
    if (recordings.length) body.recording_ids = recordings;
    if (modes.length < this.logsModes.length) body.modes = modes;
    if (this.logsFrom.value) body.from = this.logsFrom.value;
    if (this.logsTo.value) body.to = this.logsTo.value;
    return body;
  }

  async _logsZip() {
    this.logsMsg.clear();
    const body = this.logsBody();
    if (body.modes && !body.modes.length) { this.logsMsg.show('note', 'Tick at least one kind of session.'); return; }
    if (body.from && body.to && body.from > body.to) { this.logsMsg.show('note', 'The first day comes after the last: swap them, or leave one empty.'); return; }
    try { await this.area.app.flushLog?.(); } catch { /* the events not sent yet follow in the next download */ }
    let r;
    try {
      r = await this.area.backend.admin('logs_zip', body);
    } catch (exc) {
      if (exc.code === 'no_logs') { this.logsMsg.show('note', exc.message); return; }
      if (exc.code === 'too_large' || exc.status === 413) { this.logsMsg.show('note', exc.message, this._exportHelp()); return; }
      if (exc.code === 'needs_server' && this.area.isDemo) {
        this.logsMsg.show('note', exc.message, h('p', {}, 'The demonstration\'s results (JSON) hold its interaction logs.'),
          h('div.btn-row', {}, h('button.btn', { type: 'button', onclick: () => this.area.app.downloadResults() }, 'Download the demonstration\'s results (JSON)')));
        return;
      }
      throw exc;
    }
    downloadBase64(r.file_name || 'interaction_logs.zip', r.base64, 'application/zip');
    const visits = r.visits === 1 ? '1 visit' : `${r.visits} visits`;
    this.logsMsg.show('success', `Downloaded the logs of ${visits}${r.size_bytes ? ` (${bytesText(r.size_bytes)})` : ''}.`);
  }

  async show() {
    this.msg.clear();
    this.note.textContent = 'Loading…';
    try {
      const p = await this.area.read('progress');
      this.rows = (p.annotators || []).map((a) => ({ ...a, c: progressCounts(a.items) }));
      this.note.textContent = p.generated_at ? `As of ${whenText(p.generated_at)}.` : '';
      try { this.recordings = (await this.area.read('recordings_list', { scope: 'study' })).recordings || []; } catch { this.recordings = []; }
      this.area.read('reviews_list', {}).then((r) => this.reviews.update(r.reviews || [])).catch(() => this.reviews.update([]));
    } catch (exc) {
      this.note.textContent = '';
      this.msg.problem(exc);
      return;
    }
    this.table.update(this.rows);
    this._fillLogChoices();
  }

  async _showWork(r, said = null) {
    try { this.reviewsOf = (await this.area.read('reviews_list', { annotator_id: r.annotator_id })).reviews || []; } catch { this.reviewsOf = []; }
    clear(this.work);
    const msg = messageArea();
    if (said) msg.append(...said);
    // after a withdrawal or a restoration: the table and the person's work afresh, keeping what was said
    const again = async () => {
      const kept = [...msg.childNodes];
      await this.show();
      await this._showWork(this.rows.find((x) => x.annotator_id === r.annotator_id) || r, kept);
    };
    this.work.append(card(`Work of ${r.annotator_id}`, msg,
      dataTable([
        { title: 'Recording', render: (i) => recordingName(i.recording_id) },
        { title: 'Mode', render: (i) => (MODES[i.mode] || i.mode) + (i.context_id ? ` (${i.context_id})` : '') },
        { title: 'Status', render: (i) => chip(STATUS[i.status] || i.status, i.status === 'done' ? 'done' : i.status === 'in_progress' ? 'active' : '') },
        { title: 'Reviews', num: true, render: (i) => reviewCount(this.reviewsOf, r.annotator_id, i) },
        { title: 'Saved', num: true, render: (i) => String(i.attempts ?? 0) },
        { title: 'Last activity', render: (i) => whenText(i.last_activity, { never: '–' }) },
        { title: '', cls: 'actions', render: (i) => h('span.btn-row.tight', {}, reviewButton(this.area, r.annotator_id, i, { route: 'admin-results', params: null }),
          savedWorkButtons(this.area, r.annotator_id, i, { msg, onChange: again })) },
      ], r.items || [], { empty: 'Nothing is assigned to this person.', pageSize: 20 }),
      h('div.btn-row', {}, h('button.btn.quiet', { type: 'button', onclick: () => clear(this.work) }, 'Close'))),
    withdrawnCard(this.area, r.annotator_id, { msg, onChange: again }));
    this.work.querySelector('h2').tabIndex = -1;
    this.work.querySelector('h2').focus({ preventScroll: false });
  }

  _downloadTable() {
    const rows = this.rows.map((r) => ({ annotator_id: r.annotator_id, display_name: r.display_name || '', role: r.role, assigned: r.c.assigned,
      done: r.c.done, in_progress: r.c.in_progress, todo: r.c.todo, unusable: r.c.unusable, training: r.programme ? programmeText(r.programme) : '', last_seen: r.last_seen || '' }));
    downloadText('results_people.csv', csvText(['annotator_id', 'display_name', 'role', 'assigned', 'done', 'in_progress', 'todo', 'unusable', 'training', 'last_seen'], rows), 'text/csv;charset=utf-8');
  }

  async _zip() {
    this.zipMsg.clear();
    let r;
    try {
      r = await this.area.backend.admin('results_zip', this.contacts.input.checked ? { include_contacts: true } : {});
    } catch (exc) {
      if (exc.code === 'too_large' || exc.status === 413) { this.zipMsg.show('note', 'The results are too large to send through the page.', this._exportHelp()); return; }
      if (exc.code === 'needs_server' && this.area.isDemo) {
        this.zipMsg.show('note', exc.message, h('p', {}, 'The demonstration gives its results as one JSON file instead.'),
          h('div.btn-row', {}, h('button.btn', { type: 'button', onclick: () => this.area.app.downloadResults() }, 'Download the demonstration\'s results (JSON)')));
        return;
      }
      throw exc;
    }
    downloadBase64(r.file_name || 'results.zip', r.base64, 'application/zip');
    this.zipMsg.show('success', `Downloaded ${r.file_name || 'the results'}${r.size_bytes ? ` (${bytesText(r.size_bytes)})` : ''}.`);
  }

  /** How to get the results without the page: the command, with this study's names filled in. */
  _exportHelp() {
    const b = this.area.backend;
    if (b.kind === 'firebase') {
      const project = (b.health && b.health.project) || '<project>';
      const cmd = `electrotag-web export --firebase-project ${project} --study ${b.study || '<study>'} --to results`;
      return h('div', {}, h('p', {}, 'Export them with this command, on a computer with ElectroTag installed and the study\'s key (see the Firebase guide):'), h('pre.command', {}, cmd));
    }
    return h('div', {}, h('p', {}, 'On the study server they are already in the study folder, in Annotated_Events: copy that folder, for example with'),
      h('pre.command', {}, 'zip -r results.zip <study folder>/Annotated_Events'));
  }
}
