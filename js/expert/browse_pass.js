// Looking at a recording for training (docs/admin_area.md, "Looking for training recordings"; the operations in
// docs/api.md, "Looking for training recordings"). An expert given a dataset opens any of its recordings from their
// own computer, checked against the study's copy as always, and the recording opens in the annotation view, editable.
// Beside it are the expert's own rating (Yes, Maybe or No), a note of their own and Ask for it to be added to
// training. The marks, the note and the rating are the expert's alone: they are kept with browse_save, never as a
// draft or saved work, so they never reach the results, the exports or an analysis, and app.js does not record this
// view in the interaction log (its route, BROWSING_ROUTE, pauses the log as the questionnaire does).
//
// The marks are sent a moment after each change and when the view is left; until the study has them they are kept in
// this browser too (BrowseSession.localKey), and come back the next time the recording is opened here.

import { h, clear } from '../ui/dom.js';
import { choose, inform } from '../ui/dialog.js';
import { local, debounce } from '../util.js';
import { AnnotationSession } from '../annotate/session.js';
import { Workspace } from '../annotate/workspace.js';
import { MAX_NOTE, RATINGS, STATUS_WORDS, canAsk, requestText } from './browse_model.js';

/** The route of this view: app.js pauses the interaction log on it. */
export const BROWSING_ROUTE = 'expert-browsing';
const SEND_AFTER_MS = 1500;

/** Where the marks not yet sent to the study are kept in this browser. */
export function browseKey(backend, me, recordingId) {
  return `electrotag.browse|${(backend && (backend.server || backend.kind)) || ''}|${me || ''}|${recordingId}`;
}

/** The annotation session of a recording looked at for training: its marks go to browse_save, never to a draft. */
export class BrowseSession extends AnnotationSession {
  constructor(o) {
    super(o);
    this.target = o.target;
    this.sentText = JSON.stringify(this.store.toJSON());
    this.sending = null;
    this.onSent = null;
  }

  get localKey() { return browseKey(this.backend, this.me && this.me.annotator_id, this.recordingId); }

  get discarded() { return null; }

  async discardDrafts({ close = false } = {}) {
    if (close) this.close();
  }

  marksText() { return JSON.stringify(this.store.toJSON()); }

  get unsent() { return this.marksText() !== this.sentText; }

  /** The marks kept in this browser from a visit whose last changes did not reach the study, or null. */
  keptMarks() {
    const d = local.get(this.localKey, null);
    return d && Array.isArray(d.annotations) && JSON.stringify(d.annotations) !== this.sentText ? d : null;
  }

  saveLocal() {
    if (this.unsent) super.saveLocal();
  }

  /** The workspace's own saves send the marks (when they changed); never a draft. */
  async saveRemote() { return this.sendMarks(); }

  /** Send the marks as they are now, once the send before has its answer; true when the study has them. */
  async sendMarks() {
    while (this.sending) await this.sending.catch(() => {});
    const text = this.marksText();
    if (text === this.sentText) return true;
    const p = this.backend.expert('browse_save', { recording_id: this.recordingId, annotations: JSON.parse(text) });
    this.sending = p;
    try {
      const out = await p;
      this.sentText = text;
      if (!this.unsent) this.forgetLocal();
      if (this.onSent) this.onSent(null, out);
      return true;
    } catch (exc) {
      super.saveLocal();
      if (this.onSent) this.onSent(exc, null);
      return false;
    } finally {
      if (this.sending === p) this.sending = null;
    }
  }
}

export class BrowsePass {
  /**
   * @param {Workspace} ws an editable workspace of kind 'browsing' (its session a BrowseSession)
   * @param {{target: object, backend: object}} o target: the answer of browse_recording_get
   */
  constructor(ws, { target, backend }) {
    this.ws = ws;
    this.s = ws.s;
    this.target = target;
    this.backend = backend;
    const mine = target.mine || {};
    this.rating = mine.rating || null;
    this.note = mine.note || '';
    this.sentNote = this.note;
    this.request = target.request || null;
    this.problem = null;
    ws.pass = this;
    ws.el.classList.add('browsing');
    this._build();
    this.s.onSent = (exc) => { this.problem = exc; this._status(); };
    this._send = debounce(() => { void this.s.sendMarks(); }, SEND_AFTER_MS);
    this._listener = () => { this._status(); this._send(); };
    ws.store.addListener(this._listener);
    ws.onDestroy(() => ws.store.removeListener(this._listener));
    this._sendNote = debounce(() => { void this.saveNote(); }, SEND_AFTER_MS);
    this._status();
  }

  _build() {
    const t = this.target;
    this.statusEl = h('p.caption.browse-status', { role: 'status', 'aria-live': 'polite' });
    this.ratingEl = h('div.segmented.browse-rating', { role: 'radiogroup', 'aria-label': 'Is this recording good for training?' });
    this.noteEl = h('textarea.field.browse-note', { rows: 5, maxlength: String(MAX_NOTE), 'aria-label': 'Your note on this recording', placeholder: 'What you noticed: which artifacts, where, how clear they are' });
    this.noteEl.value = this.note;
    this.noteEl.addEventListener('input', () => { this.note = this.noteEl.value; this._status(); this._sendNote(); });
    this.noteEl.addEventListener('blur', () => { void this.saveNote(); });
    this.requestHost = h('div.browse-request');
    this.el = h('section.review.card.browse-pass', { 'aria-label': 'Looking for training recordings' },
      h('h2', {}, 'Looking for training recordings'),
      h('p.caption', {}, `${t.dataset_name || t.dataset_id}. Mark what you see if it helps you decide. Your marks, your note and your rating are yours alone: `
        + 'they are never saved as study work, never exported and never analysed, and this view is not recorded in the interaction log.'),
      h('h3', {}, 'Good for training?'), this.ratingEl,
      h('h3', {}, 'Your note'), this.noteEl,
      this.statusEl,
      h('h3', {}, 'Training'), this.requestHost);
    this._drawRating();
    this._drawRequest();
    this.ws.reviewHost.append(this.el);
    this.ws.hintEl.textContent = 'Mark artifacts as usual: your marks are kept for you only';
  }

  _drawRating() {
    clear(this.ratingEl);
    for (const [value, text] of RATINGS) {
      this.ratingEl.append(h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(this.rating === value), 'data-rating': value, 'data-log': 'browse-rating',
        title: this.rating === value ? 'Press again to take the rating back' : `Rate this recording ${text} for training`,
        onclick: () => this.setRating(this.rating === value ? null : value) }, text));
    }
  }

  _drawRequest() {
    clear(this.requestHost);
    const r = this.request;
    if (r && STATUS_WORDS[r.status]) this.requestHost.append(h('p.caption', {}, requestText(r)));
    if (canAsk({ request: r })) {
      this.requestHost.append(h('button.btn.primary', { type: 'button', 'data-log': 'browse-ask', onclick: () => this.ask() }, 'Ask for it to be added to training'));
    } else if (r.status === 'pending') {
      this.requestHost.append(h('button.btn.small', { type: 'button', 'data-log': 'browse-withdraw', onclick: () => this.withdraw() }, 'Take the request back'));
    }
  }

  _status() {
    if (!this.statusEl) return;
    const waiting = this.s.unsent || this.note !== this.sentNote;
    this.statusEl.textContent = this.problem
      ? `Not saved yet (${this.problem.message}). Your changes are kept in this browser and sent again with your next change.`
      : waiting ? 'Saving your changes…' : 'Your marks, note and rating are saved for you.';
    this.statusEl.dataset.state = this.problem ? 'failed' : waiting ? 'saving' : 'saved';
  }

  async setRating(value) {
    const before = this.rating;
    this.rating = value;
    this._drawRating();
    try {
      await this.backend.expert('browse_save', { recording_id: this.target.recording_id, rating: value });
      this.problem = null;
      this.ws.say(value ? `Rated ${value} for training` : 'Rating taken back');
    } catch (exc) {
      if (exc.status === 401) return;
      this.rating = before;
      this._drawRating();
      this.problem = exc;
    }
    this._status();
  }

  async saveNote() {
    const note = this.note;
    if (note === this.sentNote) return true;
    try {
      await this.backend.expert('browse_save', { recording_id: this.target.recording_id, note });
      this.sentNote = note;
      this.problem = null;
      this._status();
      return true;
    } catch (exc) {
      this.problem = exc;
      this._status();
      return false;
    }
  }

  async ask() {
    try {
      const out = await this.backend.expert('training_request', { recording_ids: [this.target.recording_id] });
      this.request = (out.requests || [])[0] || this.request;
      this._drawRequest();
      this.ws.say('Asked for: the study team sees your request in Training.');
    } catch (exc) {
      if (exc.status !== 401) await inform('The request was not sent', exc.message);
    }
  }

  async withdraw() {
    try {
      const out = await this.backend.expert('training_request_withdraw', { recording_id: this.target.recording_id });
      this.request = out.request || null;
      this._drawRequest();
    } catch (exc) {
      if (exc.status !== 401) await inform('The request was not taken back', exc.message);
      if (exc.code === 'decided') this.ws.say('The study team has decided on it already.');
    }
  }

  /** Before leaving: what is not saved yet is sent; if the study cannot be reached, the person chooses. */
  async beforeClose() {
    for (;;) {
      const ok = (await this.s.sendMarks()) && (await this.saveNote());
      if (ok) return true;
      const again = 'Try again';
      const leave = 'Leave';
      const stay = 'Stay here';
      const c = await choose('Your last changes are not saved yet', `${this.problem ? this.problem.message : 'The study could not be reached.'}\n\n`
        + `${leave}: your marks stay in this browser and are sent the next time you open this recording here${this.note !== this.sentNote ? ', but the change to your note is lost' : ''}.`,
      [again, leave, stay], 0);
      if (c === leave) { this.s.close(); return true; }
      if (c !== again) return false;
    }
  }
}

/** Open a recording to look at for training, once the file is checked against the study's copy (purpose browse). */
export async function openBrowse(app, { recording, fp, view, target }) {
  const t = target;
  let session;
  try {
    session = new BrowseSession({ backend: app.backend, recording, manifest: t.manifest, recordingId: t.recording_id, mode: 'standard', contextId: '',
      me: app.me, catalogue: app.catalogue, sha256: fp.hex, target: t });
    session.store.reset(((t.mine || {}).annotations || []).filter((a) => app.catalogue.has(a.label)));
    session.sentText = session.marksText();
  } catch (exc) {
    view.showProblem(exc.message, [view.chooseAgainButton()]);
    return null;
  }
  const kept = session.keptMarks();
  if (kept) session.store.reset(kept.annotations.filter((a) => app.catalogue.has(a.label))); // sent with the first save
  if (app.ws) app.ws.destroy();
  const back = view.purpose.back || { route: 'expert-browse', params: null };
  const leave = async (ws) => {
    ws.destroy();
    if (app.ws === ws) app.ws = null;
    await app.showExpert(back.route || 'expert-browse', back.params || null);
  };
  const ws = new Workspace(app, session, { kind: 'browsing', onLeave: leave });
  app.ws = ws;
  app._render(ws.el, BROWSING_ROUTE);
  ws.mount(app.content);
  const pass = new BrowsePass(ws, { target: t, backend: app.backend });
  if (kept) {
    ws.say('Your marks from last time, kept in this browser, are back: they are being saved now.');
    void session.sendMarks();
  }
  return pass;
}

/** Look at one recording for training: what the study keeps of it for the caller is read, then the file is opened. */
export async function startBrowse(app, recordingId, back = { route: 'expert-browse', params: null }) {
  let target;
  try {
    target = await app.backend.expert('browse_recording_get', { recording_id: recordingId });
  } catch (exc) {
    if (exc.status !== 401) await inform('The recording cannot be opened', exc.message);
    return null;
  }
  const m = target.manifest || {};
  return app.openFromComputer({ recording_id: recordingId, file_name: target.file_name, format: m.format }, { purpose: { kind: 'browse', route: BROWSING_ROUTE, target, back,
    onBack: () => app.showExpert(back.route, back.params),
    title: `Look at ${target.file_name}`,
    note: `A recording of ${target.dataset_name || target.dataset_id}. Open it from this computer: its fingerprint is checked against the study's copy, then it opens for you to look through, `
      + 'with your own marks, note and rating, which are never saved as study work.' } });
}
