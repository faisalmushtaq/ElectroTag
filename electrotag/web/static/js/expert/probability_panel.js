// The probability map in the overlay of everyone's marks, for administrators only (docs/admin_area.md,
// "Probability maps"): a lane above the EEG with the weighted share of the raters marking each moment, for any
// artifact or one HED-SCORE type, and, broken down by channel, the same share in the band under each channel
// in place of the crowd's. The side panel holds the category, the breakdown, the weights (of each confidence
// level, and of the answers to the questionnaire's single-choice questions, multiplied when several are used),
// a warning when only two people rated the recording, and the downloads, which the study works out with the
// same weights (probability_export). The weights are kept in this browser for the next map.
//
// The raters come from probability_get: everyone's latest study work on the recording, and the experts whose
// own files of it were kept with a training reference. The map is worked out here (js/expert/probability.js),
// as the study works it out.

import { h, clear } from '../ui/dom.js';
import { COLOURS } from '../ui/theme.js';
import { local, rgba } from '../util.js';
import { logger } from '../log/logger.js';
import { decode } from './crowd.js';
import { ANY, MIN_RATERS, checkedWeights, defaultWeights, ratersOf, runAt, runs } from './probability.js';
import { UNCERTAIN_LABEL, UNCERTAIN_TEXT } from '../catalogue.js';

const STORE_KEY = 'electrotag.probability.weights';
const LANE_HEIGHT = 40;
const pct = (x) => `${Math.round(x * 100)}%`;

/** A slider from 0 to 100 % for a weight, with its value beside it. */
function slider(label, value, onChange, log) {
  const out = h('output.caption.prob-value', {}, pct(value));
  const input = h('input.prob-slider', { type: 'range', min: '0', max: '100', step: '5', value: String(Math.round(value * 100)), 'aria-label': label, 'data-log': log });
  input.addEventListener('input', () => { out.textContent = `${input.value}%`; onChange(Number(input.value) / 100); });
  return h('label.prob-weight', {}, h('span.caption', {}, label), input, out);
}

export class ProbabilityPanel {
  /** @param {object} view the OverlayView of a study recording, opened by an administrator */
  constructor(view) {
    this.view = view;
    this.ws = view.ws;
    this.sf = view.sf;
    this.shown = false;
    this.category = ANY;
    this.byChannel = false;
    this.weights = checkedWeights(local.get(STORE_KEY, null));
    this.answer = null;
    this.maps = new Map();
    this._build();
  }

  // ---------------------------------------------------------------- the data
  async _load() {
    if (this.answer) return true;
    this.say('Reading the raters…');
    try {
      this.answer = await this.view.app.backend.admin('probability_get', { recording_id: this.view.data.recording_id });
    } catch (exc) {
      this.say(exc.message);
      return false;
    }
    this.data = decode(this.answer);
    this.answers = Object.fromEntries((this.answer.people || []).map((p) => [p.annotator_id, p.answers || {}]));
    this.data.people.forEach((p, i) => { p.source = this.answer.people[i].source; p.set_id = this.answer.people[i].set_id; });
    this._fillCategories();
    this._fillQuestions();
    this.say('');
    return true;
  }

  get raters() { return this.data ? ratersOf(this.data, this.answers, this.weights) : []; }

  /** The map of a channel (null: the recording as a whole), worked out when first asked for since the last change. */
  map(channel = null) {
    const key = channel ?? '';
    if (!this.maps.has(key)) this.maps.set(key, runs(this._raters || (this._raters = this.raters), this.data.nSamples, this.weights, { category: this.category, channel }));
    return this.maps.get(key);
  }

  _changed(what) {
    this.maps.clear();
    this._raters = null;
    local.set(STORE_KEY, this.weights);
    this._describe();
    this.redraw();
    if (what) logger.event('probability_changed', { what, category: this.category === ANY ? 'any' : 'type', by_channel: this.byChannel });
  }

  // ---------------------------------------------------------------- the panel
  _build() {
    this.msg = h('p.caption.prob-msg', { role: 'status' });
    this.warn = h('p.prob-warn', { role: 'status', hidden: true });
    this.readout = h('p.caption.prob-readout', { 'aria-live': 'polite' });
    this.ratersEl = h('p.caption.prob-raters');
    this.show = h('input', { type: 'checkbox', 'data-log': 'probability-show' });
    this.show.addEventListener('change', () => this.setShown(this.show.checked));
    this.catSelect = h('select.field', { 'aria-label': 'What the map is of', 'data-log': 'probability-category' }, h('option', { value: ANY }, 'Any artifact'));
    this.catSelect.addEventListener('change', () => { this.category = this.catSelect.value; this._changed('category'); });
    this.chanBox = h('input', { type: 'checkbox', 'data-log': 'probability-by-channel' });
    this.chanBox.addEventListener('change', () => { this.byChannel = this.chanBox.checked; this._changed('by_channel'); });
    this.confHost = h('div.prob-weights');
    this.questionsHost = h('div.prob-questions');
    this.downloadKinds = h('select.field', { 'aria-label': 'Types in the download', 'data-log': 'probability-download-kinds' },
      h('option', { value: 'shown' }, 'The category shown'), h('option', { value: 'each' }, 'Any artifact and each type'));
    const one = h('button.btn.small', { type: 'button', 'data-log': 'probability-download-one', onclick: (e) => this.download(e.currentTarget, true) }, 'Download this recording (TSV)');
    const every = h('button.btn.small', { type: 'button', 'data-log': 'probability-download-every', onclick: (e) => this.download(e.currentTarget, false) }, 'Download every recording (zip)');
    const reset = h('button.btn.small.quiet', { type: 'button', 'data-log': 'probability-reset', onclick: () => { this.weights = defaultWeights(); this._fillConfidence(); this._fillQuestions(); this._changed('reset'); } }, 'Back to equal weights');
    this.body = h('div.prob-body', { hidden: true },
      h('label.ov-filter', {}, h('span.caption', {}, 'The map of'), this.catSelect),
      h('label.check', {}, this.chanBox, h('span', {}, 'Break it down by channel, in the band under each channel')),
      this.warn, this.ratersEl, this.readout,
      h('details.prob-details', { open: true }, h('summary', {}, 'Weights'),
        h('p.caption', {}, 'A rater counts for less where they gave their mark a low confidence. Marks without a confidence, and time a rater left unmarked (their judgement that there is no artifact), count in full.'),
        this.confHost,
        h('p.caption', {}, 'Weigh raters by their answers to the questionnaire as they stood when they saved the recording. With several questions, the weights of a rater\'s answers are multiplied.'),
        this.questionsHost, h('div.btn-row', {}, reset)),
      h('label.ov-filter', {}, h('span.caption', {}, 'Types in the download'), this.downloadKinds),
      h('div.btn-row', {}, one, every));
    this.el = h('div.prob-panel', { 'data-part': 'probability' },
      h('h3', {}, 'Probability map'),
      h('p.caption', {}, 'For administrators: the share of the raters who marked each moment, weighed by their confidence and, if you choose, their answers to the questionnaire. Raters are everyone\'s latest study work and the experts\' own files kept with a training reference.'),
      h('label.check', {}, this.show, h('span', {}, 'Show the probability map')), this.msg, this.body);
    this.view.el.insertBefore(this.el, this.view.el.querySelector('.ov-msg'));
    // the lane above the EEG
    this.canvas = h('canvas.prob-canvas', { 'aria-hidden': 'true' });
    this.track = h('div.lane-track.prob-track', {}, this.canvas);
    this.row = h('div.lane.prob-lane', { hidden: true }, h('span.lane-name', { title: 'The weighted share of the raters who marked each moment, from 0 at the foot to 1 at the top' }, h('b', {}, 'Probability')), this.track);
    this.track.addEventListener('pointermove', (e) => this._hover(e.clientX));
    this.track.addEventListener('pointerleave', () => { this.readout.textContent = ''; });
    this._fillConfidence();
  }

  say(text) { this.msg.textContent = text; }

  _fillConfidence() {
    clear(this.confHost);
    this.weights.confidence.forEach((w, i) => this.confHost.append(slider(`Confidence ${i + 1}`, w, (x) => { this.weights.confidence[i] = x; this._changed('confidence'); }, `probability-confidence-${i + 1}`)));
  }

  _fillCategories() {
    clear(this.catSelect);
    this.catSelect.append(h('option', { value: ANY }, 'Any artifact'),
      ...this.data.labels.map((l) => h('option', { value: l }, l === UNCERTAIN_LABEL ? `${l} (${UNCERTAIN_TEXT.toLowerCase()})` : l)));
    this.catSelect.value = this.data.labels.includes(this.category) ? this.category : ANY;
    this.category = this.catSelect.value;
  }

  _fillQuestions() {
    clear(this.questionsHost);
    const qs = (this.answer && this.answer.questions) || [];
    if (!qs.length) { this.questionsHost.append(h('p.caption', {}, 'The study\'s questionnaire has no single-choice questions to weigh raters by.')); return; }
    for (const q of qs) {
      const used = Object.prototype.hasOwnProperty.call(this.weights.questions, q.id);
      const box = h('input', { type: 'checkbox', checked: used, 'data-log': 'probability-question', 'data-question': q.id });
      const options = h('div.prob-weights', { hidden: !used });
      const table = () => this.weights.questions[q.id];
      for (const o of q.options) {
        options.append(slider(o.label, used && table()[o.value] !== undefined ? table()[o.value] : 1, (x) => { table()[o.value] = x; this._changed('answer'); }, 'probability-answer'));
      }
      box.addEventListener('change', () => {
        if (box.checked) this.weights.questions[q.id] = Object.fromEntries(q.options.map((o) => [o.value, 1]));
        else delete this.weights.questions[q.id];
        options.hidden = !box.checked;
        if (box.checked) [...options.querySelectorAll('input')].forEach((i) => { i.value = '100'; i.nextSibling.textContent = '100%'; });
        this._fillNoAnswer();
        this._changed('question');
      });
      this.questionsHost.append(h('div.prob-question', {}, h('label.check', {}, box, h('span', {}, q.text)), options));
    }
    this.noAnswerHost = h('div.prob-weights');
    this.questionsHost.append(this.noAnswerHost);
    this._fillNoAnswer();
  }

  _fillNoAnswer() {
    if (!this.noAnswerHost) return;
    clear(this.noAnswerHost);
    if (!Object.keys(this.weights.questions).length) return;
    this.noAnswerHost.append(slider('No answer to a question used', this.weights.no_answer, (x) => { this.weights.no_answer = x; this._changed('no_answer'); }, 'probability-no-answer'));
  }

  /** Who the raters are and what they weigh, and a warning for a small sample. */
  _describe() {
    if (!this.data) return;
    const rs = this.raters;
    const n = rs.length;
    this.warn.hidden = n > MIN_RATERS;
    this.warn.textContent = n < MIN_RATERS
      ? `Only ${n === 1 ? 'one person has' : 'nobody has'} rated this recording: a map needs at least ${MIN_RATERS} raters.`
      : n === MIN_RATERS ? `Only ${MIN_RATERS} people rated this recording: a sample this small says little about how likely an artifact is.` : '';
    this.ratersEl.textContent = n ? `${n} rater${n === 1 ? '' : 's'}: ${rs.map((r) => `${r.annotator_id}${r.source === 'expert' ? ` (expert, ${r.set_id})` : ''} ${pct(r.weight)}`).join(', ')}.` : '';
  }

  async setShown(on) {
    this.shown = on;
    this.body.hidden = !on;
    if (on && !(await this._load())) { this.shown = false; this.show.checked = false; this.body.hidden = true; return; }
    logger.event('probability_shown', { on, raters: this.data ? this.data.people.length : 0 });
    this._describe();
    this.redraw();
  }

  get usable() { return this.shown && this.data && this.data.people.length >= MIN_RATERS; }

  /** Whether the bands under the channels show the map (in place of the crowd's share). */
  get channelsShown() { return this.usable && this.byChannel; }

  redraw() {
    const strip = this.view.strip;
    if (this.row.parentNode !== strip) strip.prepend(this.row);
    this.row.hidden = !this.usable;
    this.ws.viewer.invalidate(['over']);
    this.drawLane();
  }

  // ---------------------------------------------------------------- drawing
  drawLane() {
    const v = this.ws.viewer;
    if (!v || !v.view || this.row.hidden) return;
    const w = Math.max(0, Math.round(v.plotW));
    const dpr = v.dpr || 1;
    const c = this.canvas;
    this.track.style.marginLeft = `${Math.round(v.x0)}px`;
    this.track.style.width = `${w}px`;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(LANE_HEIGHT * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(LANE_HEIGHT * dpr); }
    c.style.width = `${w}px`;
    c.style.height = `${LANE_HEIGHT}px`;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, LANE_HEIGHT);
    ctx.strokeStyle = COLOURS.separator;
    ctx.beginPath();
    ctx.moveTo(0, LANE_HEIGHT / 2 + 0.5);
    ctx.lineTo(w, LANE_HEIGHT / 2 + 0.5);
    ctx.stroke();
    const s0 = v.view.startS * this.sf;
    const s1 = (v.view.startS + v.view.durationS) * this.sf;
    const x = (s) => Math.min(w, Math.max(0, v.sampleToX(s) - v.x0));
    ctx.fillStyle = rgba(COLOURS.accent, 0.3);
    ctx.strokeStyle = COLOURS.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (const r of this.map(null)) {
      if (r.end <= s0 || r.start >= s1 || r.p === null) continue;
      const xa = x(r.start);
      const xb = x(r.end);
      const y = LANE_HEIGHT - r.p * (LANE_HEIGHT - 2);
      if (r.p > 0) ctx.fillRect(xa, y, Math.max(1, xb - xa), LANE_HEIGHT - y);
      if (!started) { ctx.moveTo(xa, y); started = true; } else ctx.lineTo(xa, y);
      ctx.lineTo(xb, y);
    }
    ctx.stroke();
  }

  /** The bands under the channels, shaded by each channel's map. */
  paintChannels(ctx, v) {
    const s0 = v.view.startS * this.sf;
    const s1 = (v.view.startS + v.view.durationS) * this.sf;
    const hgt = this.view.bandHeight(v);
    ctx.save();
    for (const { row, ch } of v.visibleRows()) {
      if (!this.data.channels.includes(ch.name)) continue;
      const y = v.rowCentre(row) + v.rowH / 2 - hgt;
      for (const r of this.map(ch.name)) {
        if (r.end <= s0 || r.start >= s1 || !r.p) continue;
        const xa = Math.max(v.x0, v.sampleToX(r.start));
        const xb = Math.min(v.x1, v.sampleToX(r.end));
        if (xb <= xa) continue;
        ctx.fillStyle = rgba(COLOURS.accent, 0.12 + 0.83 * r.p);
        ctx.fillRect(xa, y, Math.max(1, xb - xa), hgt);
      }
    }
    ctx.restore();
  }

  _hover(clientX) {
    const v = this.ws.viewer;
    if (!this.usable || !v || !v.view) return;
    const box = this.track.getBoundingClientRect();
    const t = v.view.startS + ((clientX - box.left) / Math.max(1, box.width)) * v.view.durationS;
    const r = runAt(this.map(null), Math.floor(t * this.sf));
    if (!r) { this.readout.textContent = ''; return; }
    this.readout.textContent = `At ${t.toFixed(2)} s: ${r.p === null ? 'no value (every rater weighs nothing)' : r.p.toFixed(2)}, ${r.n_marked} of ${this.data.people.length} raters marked it.`;
  }

  // ---------------------------------------------------------------- downloads
  async download(button, one) {
    button.disabled = true;
    this.say(one ? 'Working out the map…' : 'Working out the maps of every recording…');
    try {
      const out = await this.view.app.backend.admin('probability_export', {
        weights: this.weights, by_channel: this.byChannel, category: this.downloadKinds.value === 'each' ? 'each' : this.category,
        ...(one ? { recording_ids: [this.view.data.recording_id], as: 'tsv' } : {}),
      });
      if (one) this._save(out.file_name, new Blob([out.text], { type: 'text/tab-separated-values' }));
      else this._save(out.file_name, new Blob([Uint8Array.from(atob(out.base64), (ch) => ch.charCodeAt(0))], { type: 'application/zip' }));
      this.say(`${one ? 'The map' : `${out.recordings} map${out.recordings === 1 ? '' : 's'}`} offered to save${out.left_out && out.left_out.length && !one ? `; ${out.left_out.length} recording${out.left_out.length === 1 ? ' has' : 's have'} too few raters` : ''}${out.low_sample && out.low_sample.length ? `; ${out.low_sample.length} with only two raters, marked low_sample` : ''}.`);
      logger.event('probability_downloaded', { one, recordings: out.recordings });
    } catch (exc) {
      this.say(exc.message);
    } finally { button.disabled = false; }
  }

  _save(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  destroy() { this.el.remove(); this.row.remove(); }
}
