// The topographic map beside the EEG (docs/using.md, "The topographic map"): a section at the top of the
// side panel, folded with its heading, that spreads the channels' values over a drawing of the head. With
// a mark selected, or just drawn, it shows the mean or the root mean square (RMS) of each channel over the
// mark, as the person chooses; otherwise the value at the time cursor that a click on the EEG places. Channels marked
// bad are grey and left out at once; a click on an electrode chooses its channel on the EEG, and pointing
// at one names it. The signal is the EEG as the viewer shows it (its filters, as recorded) unless the
// study, or the person for themselves, chooses otherwise: no filters, or the average reference. Each
// channel is centred on its mean over the seconds on the screen, as the viewer centres its trace. The
// colours run from blue (negative) through white to red (positive) on a scale that stays the same for
// the whole recording, ± the recording's starting EEG amplitude, which − and + change.
//
// The arithmetic is in js/viewer/topo.js. Loaded as a part of its own (js/lazy.js, 'topomap') when a
// recording opens with a map to show. Logged as topomap events, with channels, times and choices only.

import { h, clear } from '../ui/dom.js';
import { COLOURS } from '../ui/theme.js';
import { icon } from '../views/common.js';
import { logger } from '../log/logger.js';
import { clamp, local, touchFirst } from '../util.js';
import { colourOf, channelValues, grid, makeSpline, stepLimit, DIVERGING } from '../viewer/topo.js';

/** The longest stretch of a mark whose mean or RMS is worked out (s), and of the screen a channel is centred on. */
export const MAX_WINDOW_S = 30;
export const MAX_BASELINE_S = 20;
/** Cells across the grid of the map, and the smallest and largest drawing (CSS pixels). */
const CELLS = 72;
const MIN_PX = 200;
const MAX_PX = 280;

export const MEASURES = Object.freeze({ mean: 'Mean', rms: 'RMS (root mean square)' });
export const FILTER_CHOICES = Object.freeze({ as_shown: 'As in the viewer', none: 'None' });
export const REFERENCE_CHOICES = Object.freeze({ as_recorded: 'As recorded', average: 'Average of the good channels' });

const uv = (v) => (Number.isFinite(v) ? `${(v * 1e6).toFixed(Math.abs(v) < 1e-5 ? 1 : 0)} µV` : 'no value');
const secs = (s) => `${s.toFixed(3)} s`;

/** The topographic map's section in the annotation view `ws`, with the channels placed at `positions` (topo.js topoPositions). */
export function mountTopomap(ws, host, positions) {
  return new TopoMap(ws, host, positions);
}

export class TopoMap {
  constructor(ws, host, positions) {
    this.ws = ws;
    this.host = host;
    this.positions = positions;
    const study = (ws.s.me && ws.s.me.study) || {};
    const d = study.display || {};
    this.studySignal = { filters: FILTER_CHOICES[d.topomap_filters] ? d.topomap_filters : 'as_shown',
      reference: REFERENCE_CHOICES[d.topomap_reference] ? d.topomap_reference : 'as_recorded' };
    const kept = local.get(ws._toolKey('topomap_signal'), null);
    this.signal = {
      filters: kept && FILTER_CHOICES[kept.filters] ? kept.filters : this.studySignal.filters,
      reference: kept && REFERENCE_CHOICES[kept.reference] ? kept.reference : this.studySignal.reference,
    };
    this.measure = MEASURES[local.get(ws._toolKey('topomap_measure'), null)] ? local.get(ws._toolKey('topomap_measure'), 'mean') : 'mean';
    this.open = local.get(ws._toolKey('topomap_open'), true) !== false;
    this.limitUv = stepLimit(((ws.s.scalings && ws.s.scalings.eeg) || 50e-6) * 1e6);
    // The channels on the map, in the order of the montage.
    this.chans = ws.s.channels.filter((c) => positions.points.has(c.name)).map((c) => ({ ...c, p: positions.points.get(c.name) }));
    this.radius = Math.max(1, ...this.chans.map((c) => Math.hypot(c.p.x, c.p.y))) + 0.06;
    this.cells = grid(CELLS, this.radius);
    this._splines = new Map(); // the good channels' names -> the spline through them
    this._token = 0;
    this.values = null; // the values on the map now, by channel name (V)
    this.target = null;
    this.following = 'cursor'; // 'made': the mark just drawn, until the time cursor is placed
    this._lastShown = '';
    this.update = () => { clearTimeout(this._later); this._later = setTimeout(() => { void this._update(); }, 80); };
    this._build();
    // redrawn to the panel's width when the layout changes (a tablet turned, the window resized)
    this._width = 0;
    this._resize = new ResizeObserver(() => { const w = this.body.clientWidth; if (w && w !== this._width) { this._width = w; this._draw(); } });
    this._resize.observe(this.body);
    this._draw(); // the head and the scale at once; the values follow
    this.update();
  }

  destroy() {
    this._destroyed = true;
    clearTimeout(this._later);
    if (this._resize) this._resize.disconnect();
    this.el.remove();
  }

  // ------------------------------------------------------------------ the section
  _build() {
    const ws = this.ws;
    const id = `topo-body-${ws.windowNo}`;
    this.toggle = h('button.topo-toggle', { type: 'button', 'aria-expanded': String(this.open), 'aria-controls': id, 'data-log': 'topomap-toggle',
      title: 'Show or fold the topographic map', onclick: () => this.setOpen(!this.open) },
      icon(this.open ? 'chevron-down' : 'chevron-right'), h('span.topo-title', {}, 'Topographic map'));
    this.caption = h('p.caption.topo-caption', { 'aria-live': 'polite' });
    this.canvas = h('canvas.topo-canvas', { role: 'img', 'aria-label': 'Topographic map', 'data-log': 'topomap-canvas' });
    this.tip = h('span.topo-tip', { hidden: true });
    this.bar = h('canvas.topo-bar', { 'aria-hidden': 'true' });
    this.lo = h('span.topo-lim');
    this.hi = h('span.topo-lim');
    const narrower = h('button.btn.icon.small', { type: 'button', 'aria-label': 'Narrower colour scale', title: 'Narrower colour scale', 'data-log': 'topomap-scale-down',
      onclick: () => this.setLimit(stepLimit(this.limitUv, -1)) }, icon('minus'));
    const wider = h('button.btn.icon.small', { type: 'button', 'aria-label': 'Wider colour scale', title: 'Wider colour scale', 'data-log': 'topomap-scale-up',
      onclick: () => this.setLimit(stepLimit(this.limitUv, 1)) }, icon('plus'));
    this.measureSel = h('select.field.topo-select', { id: `topo-measure-${ws.windowNo}`, 'data-log': 'topomap-measure' },
      Object.entries(MEASURES).map(([k, v]) => h('option', { value: k }, v)));
    this.measureSel.value = this.measure;
    this.measureSel.addEventListener('change', () => this.setMeasure(this.measureSel.value));
    this.filtersSel = h('select.field.topo-select', { id: `topo-filters-${ws.windowNo}`, 'data-log': 'topomap-filters' },
      Object.entries(FILTER_CHOICES).map(([k, v]) => h('option', { value: k }, v)));
    this.refSel = h('select.field.topo-select', { id: `topo-reference-${ws.windowNo}`, 'data-log': 'topomap-reference' },
      Object.entries(REFERENCE_CHOICES).map(([k, v]) => h('option', { value: k }, v)));
    this.filtersSel.value = this.signal.filters;
    this.refSel.value = this.signal.reference;
    for (const s of [this.filtersSel, this.refSel]) s.addEventListener('change', () => this.setSignal({ filters: this.filtersSel.value, reference: this.refSel.value }));
    this.signalNote = h('p.caption.topo-signal-note');
    // The signal's choices are folded under a line that says what they are, to keep the panel short.
    const signalId = `topo-signal-${ws.windowNo}`;
    this.signalBtn = h('button.topo-signal-toggle', { type: 'button', 'aria-expanded': 'false', 'aria-controls': signalId, 'data-log': 'topomap-signal-toggle',
      onclick: () => this._showSignal(this.signalBox.hidden) });
    this.signalBox = h('div.topo-opts', { id: signalId, hidden: true },
      h('label', { for: this.filtersSel.id }, 'Filters'), this.filtersSel,
      h('label', { for: this.refSel.id }, 'Reference'), this.refSel);
    this.body = h('div.topo-body', { id, hidden: !this.open },
      this.caption,
      h('div.topo-figure', {}, this.canvas, this.tip),
      this.scaleRow = h('div.topo-scale', {}, this._narrower = narrower, this.lo, this.bar, this.hi, this._wider = wider),
      h('div.topo-opts', {}, h('label', { for: this.measureSel.id }, 'Over a mark'), this.measureSel),
      this.signalBtn, this.signalBox, this.signalNote);
    this.el = h('section.topo', { 'aria-label': 'Topographic map', 'data-part': 'topomap', class: this.open ? null : 'folded' }, h('h2.topo-head', {}, this.toggle), this.body);
    clear(this.host);
    this.host.append(this.el);
    this.canvas.addEventListener('pointermove', (e) => this._hover(e));
    this.canvas.addEventListener('pointerleave', () => { this.tip.hidden = true; this._hot = null; this._draw(); });
    this.canvas.addEventListener('click', (e) => this._click(e));
    this._signalText();
  }

  setOpen(open) {
    this.open = Boolean(open);
    this.body.hidden = !this.open;
    this.el.classList.toggle('folded', !this.open);
    this.toggle.setAttribute('aria-expanded', String(this.open));
    this.toggle.firstChild.replaceWith(icon(this.open ? 'chevron-down' : 'chevron-right'));
    local.set(this.ws._toolKey('topomap_open'), this.open);
    logger.event('topomap', { action: this.open ? 'open' : 'close', via: logger.via() });
    this._lastShown = '';
    if (this.open) this.update();
  }

  setMeasure(m) {
    if (!MEASURES[m]) return;
    this.measure = m;
    this.measureSel.value = m;
    local.set(this.ws._toolKey('topomap_measure'), m);
    logger.event('topomap', { action: 'measure', measure: m, via: logger.via() });
    this.update();
  }

  /** The signal mapped: kept for the person in this browser, and so used for their next recording too. */
  setSignal(sig) {
    this.signal = { filters: FILTER_CHOICES[sig.filters] ? sig.filters : 'as_shown', reference: REFERENCE_CHOICES[sig.reference] ? sig.reference : 'as_recorded' };
    local.set(this.ws._toolKey('topomap_signal'), this.signal);
    logger.event('topomap', { action: 'signal', filters: this.signal.filters, reference: this.signal.reference, via: logger.via() });
    this._signalText();
    this.update();
  }

  setLimit(limitUv) {
    this.limitUv = limitUv;
    logger.event('topomap', { action: 'scale', limit_uv: limitUv, via: logger.via() });
    this._draw();
  }

  _signalText() {
    const same = this.signal.filters === this.studySignal.filters && this.signal.reference === this.studySignal.reference;
    this.signalNote.textContent = same ? 'The study\'s choice of signal.' : 'Your own choice of signal, kept for your next recordings.';
    clear(this.signalBtn);
    this.signalBtn.append(icon(this.signalBox && !this.signalBox.hidden ? 'chevron-down' : 'chevron-right'),
      h('span', {}, `Signal: filters ${FILTER_CHOICES[this.signal.filters].toLowerCase()}, reference ${REFERENCE_CHOICES[this.signal.reference].toLowerCase()}`));
  }

  _showSignal(show) {
    this.signalBox.hidden = !show;
    this.signalBtn.setAttribute('aria-expanded', String(show));
    this._signalText();
  }

  // ------------------------------------------------------------------ what is shown
  /** What the map follows when no mark is selected: the time cursor, or ('made') the mark just drawn. */
  follow(what) {
    this.following = what;
    this.update();
  }

  /** What the map is of: the selected mark (one), the mark just drawn, or the time cursor; null for none of them. */
  _target() {
    const ws = this.ws;
    const sf = ws.sf;
    const n = ws.s.recording.nSamples;
    const id = ws.selection.length === 1 && ws.store.has(ws.selection[0]) ? ws.selection[0]
      : this.following === 'made' && !ws.selection.length && ws.lastMadeId && ws.store.has(ws.lastMadeId) ? ws.lastMadeId : null;
    if (id) {
      const a = ws.store.get(id);
      const w0 = clamp(a.onset_sample, 0, n - 1);
      const full = Math.max(1, a.duration_samples);
      const w1 = clamp(w0 + Math.min(full, Math.round(MAX_WINDOW_S * sf)), w0 + 1, n);
      return { what: this.measure, w0, w1, cut: full > w1 - w0, id: a.annotation_id, label: a.label, selected: id !== ws.lastMadeId || ws.selection.includes(id) };
    }
    const t = ws.viewer.cursorT;
    if (t === null || t === undefined || !Number.isFinite(t)) return null;
    return { what: 'moment', at: clamp(Math.round(t * sf), 0, n - 1) };
  }

  _bad() {
    return new Set([...this.ws.s.channels.filter((c) => c.bad).map((c) => c.name), ...this.ws.store.badChannels]);
  }

  async _update() {
    if (this._destroyed || !this.open) return;
    const ws = this.ws;
    const target = this._target();
    this.target = target;
    if (!target) {
      this.values = null;
      this.caption.textContent = touchFirst() ? 'Tap the EEG for the map at that moment, or select or draw a mark for its mean or RMS.'
        : 'Click the EEG for the map at that moment, or select or draw a mark for its mean or RMS.';
      this._draw();
      return;
    }
    const sf = ws.sf;
    const n = ws.s.recording.nSamples;
    const v = ws.viewer.view;
    const centre = target.what === 'moment' ? target.at : Math.round((target.w0 + target.w1) / 2);
    // Each channel is centred on its mean over the screen, as the viewer centres its trace, when the screen
    // holds what is mapped and is not too long; otherwise over the stretch of that length around it.
    const most = Math.round(MAX_BASELINE_S * sf);
    let b0 = Math.floor(v.startS * sf);
    let b1 = Math.ceil((v.startS + v.durationS) * sf);
    if (b1 - b0 > most || centre < b0 || centre >= b1) { b0 = centre - Math.floor(most / 2); b1 = b0 + most; }
    b0 = clamp(b0, 0, n - 1); b1 = clamp(b1, b0 + 1, n);
    const r0 = Math.min(b0, target.what === 'moment' ? target.at : target.w0);
    const r1 = Math.max(b1, target.what === 'moment' ? target.at + 1 : target.w1);
    const token = ++this._token;
    const bad = this._bad();
    const use = this.chans.map((c) => !bad.has(c.name));
    let res;
    try {
      res = await ws.s.recording.readWindow({ startSample: r0, nSamples: r1 - r0, channels: this.chans.map((c) => c.index),
        filters: this.signal.filters === 'as_shown' ? { ...ws.viewer.filters } : null });
    } catch (exc) {
      if (token !== this._token || this._destroyed) return;
      this.values = null;
      this.caption.textContent = `The map could not be worked out: ${exc.message || exc}`;
      this._draw();
      return;
    }
    if (token !== this._token || this._destroyed) return;
    const vals = channelValues(res.data, res.startSample, { ...target, b0, b1, average: this.signal.reference === 'average', use });
    this.values = new Map(this.chans.map((c, i) => [c.name, vals[i]]));
    this.bad = bad;
    this.caption.textContent = target.what === 'moment' ? `At ${secs(target.at / sf)}`
      : `${target.what === 'rms' ? 'RMS' : 'Mean'} over the ${target.selected ? 'selected mark' : 'mark just made'}, ${secs(target.w0 / sf)} to ${secs(target.w1 / sf)}${target.cut ? ` (its first ${MAX_WINDOW_S} s)` : ''}`;
    this._draw();
    const shown = JSON.stringify(target);
    if (shown !== this._lastShown) {
      this._lastShown = shown;
      logger.event('topomap', { action: 'show', what: target.what,
        ...(target.what === 'moment' ? { t_s: Math.round((target.at / sf) * 1000) / 1000 } : { annotation_id: target.id, onset_s: Math.round((target.w0 / sf) * 1000) / 1000,
          duration_s: Math.round(((target.w1 - target.w0) / sf) * 1000) / 1000 }),
        filters: this.signal.filters, reference: this.signal.reference, n_bad: this.chans.filter((c) => bad.has(c.name)).length });
    }
  }

  /** The spline through the good channels with a value (cached for each set of them). */
  _spline(good) {
    const key = good.map((c) => c.name).join('\u0001');
    let s = this._splines.get(key);
    if (!s) {
      s = good.length >= 3 ? makeSpline(good.map((c) => c.p), this.cells) : null;
      if (this._splines.size > 8) this._splines.clear();
      this._splines.set(key, s);
    }
    return s;
  }

  // ------------------------------------------------------------------ drawing
  _geometry() {
    const w = this.body.clientWidth || this.host.clientWidth || MAX_PX;
    const size = Math.round(clamp(w, MIN_PX, MAX_PX));
    const half = size / 2;
    const scale = (half - 6) / (this.radius + 0.12); // room for the nose
    return { size, cx: half, cy: half + 0.04 * scale, scale };
  }

  _at(p, g) { return { x: g.cx + p.x * g.scale, y: g.cy - p.y * g.scale }; }

  _draw() {
    if (this._destroyed || !this.open) return;
    const g = this._geometry();
    const dpr = window.devicePixelRatio || 1;
    const c = this.canvas;
    if (c.width !== Math.round(g.size * dpr)) { c.width = Math.round(g.size * dpr); c.height = Math.round(g.size * dpr); }
    c.style.width = `${g.size}px`;
    c.style.height = `${g.size}px`;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.size, g.size);
    const R = this.radius * g.scale;
    // the map
    const good = this.values ? this.chans.filter((ch) => !this.bad.has(ch.name) && Number.isFinite(this.values.get(ch.name))) : [];
    const spline = this.values ? this._spline(good) : null;
    ctx.save();
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, R, 0, 2 * Math.PI);
    ctx.clip();
    ctx.fillStyle = COLOURS.surface;
    ctx.fillRect(0, 0, g.size, g.size);
    if (spline) {
      const at = spline(good.map((ch) => this.values.get(ch.name)));
      const img = new ImageData(CELLS, CELLS);
      const limit = this.limitUv * 1e-6;
      this.cells.forEach((cell, k) => {
        const [r, gg, b] = colourOf(at[k], limit);
        const i = (cell.r * CELLS + cell.c) * 4;
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
      });
      const off = (this._off ||= document.createElement('canvas'));
      off.width = CELLS; off.height = CELLS;
      off.getContext('2d').putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, g.cx - R, g.cy - R, 2 * R, 2 * R);
    }
    ctx.restore();
    // the head: its outline at the ring, the nose and the ears
    ctx.strokeStyle = COLOURS.text;
    ctx.lineWidth = 1.5;
    const r1 = g.scale;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, r1, 0, 2 * Math.PI);
    ctx.moveTo(g.cx - 0.09 * r1, g.cy - Math.sqrt(1 - 0.09 ** 2) * r1);
    ctx.lineTo(g.cx, g.cy - 1.1 * r1);
    ctx.lineTo(g.cx + 0.09 * r1, g.cy - Math.sqrt(1 - 0.09 ** 2) * r1);
    for (const side of [-1, 1]) {
      ctx.moveTo(g.cx + side * r1, g.cy - 0.12 * r1);
      ctx.quadraticCurveTo(g.cx + side * 1.08 * r1, g.cy, g.cx + side * r1, g.cy + 0.12 * r1);
    }
    ctx.stroke();
    // the electrodes: bad ones grey and hollow
    for (const ch of this.chans) {
      const { x, y } = this._at(ch.p, g);
      const bad = this.bad ? this.bad.has(ch.name) : this._bad().has(ch.name);
      const hot = this._hot === ch.name;
      ctx.beginPath();
      ctx.arc(x, y, hot ? 4 : 2.5, 0, 2 * Math.PI);
      if (bad) { ctx.fillStyle = COLOURS.surface; ctx.fill(); ctx.strokeStyle = COLOURS.text_disabled; ctx.lineWidth = 1.2; ctx.stroke(); }
      else { ctx.fillStyle = COLOURS.text; ctx.fill(); }
    }
    this.canvas.setAttribute('aria-label', this.values ? `Topographic map: ${this.caption.textContent}` : 'Topographic map: nothing shown yet');
    this._drawBar();
  }

  _drawBar() {
    this.lo.textContent = `−${this.limitUv} µV`;
    this.hi.textContent = `+${this.limitUv} µV`;
    // as wide as the row leaves beside the limits and their buttons
    const row = this.scaleRow.clientWidth;
    const rest = this._narrower.offsetWidth + this._wider.offsetWidth + this.lo.offsetWidth + this.hi.offsetWidth + 4 * 6;
    const w = Math.round(clamp(row ? row - rest : 120, 32, 120));
    const hgt = 10;
    const dpr = window.devicePixelRatio || 1;
    const b = this.bar;
    if (b.width !== Math.round(w * dpr)) { b.width = Math.round(w * dpr); b.height = Math.round(hgt * dpr); }
    b.style.width = `${w}px`;
    b.style.height = `${hgt}px`;
    const ctx = b.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let x = 0; x < w; x++) {
      const [r, g, bl] = colourOf(((x + 0.5) / w) * 2 - 1, 1);
      ctx.fillStyle = `rgb(${r}, ${g}, ${bl})`;
      ctx.fillRect(x, 0, 1, hgt);
    }
    ctx.strokeStyle = COLOURS.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, hgt - 1);
  }

  /** The electrode nearest the pointer, within reach (CSS pixels), or null. */
  _nearest(e, reach) {
    const r = this.canvas.getBoundingClientRect();
    const g = this._geometry();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best = null;
    let d = reach;
    for (const ch of this.chans) {
      const p = this._at(ch.p, g);
      const dd = Math.hypot(p.x - x, p.y - y);
      if (dd <= d) { d = dd; best = { ch, p }; }
    }
    return best;
  }

  _hover(e) {
    const hit = this._nearest(e, e.pointerType === 'mouse' ? 10 : 16);
    const name = hit ? hit.ch.name : null;
    if (name !== this._hot) { this._hot = name; this._draw(); }
    if (!hit) { this.tip.hidden = true; return; }
    const bad = (this.bad || this._bad()).has(name);
    this.tip.textContent = bad ? `${name}: marked bad` : this.values ? `${name}: ${uv(this.values.get(name))}` : name;
    this.tip.style.left = `${Math.round(hit.p.x)}px`;
    this.tip.style.top = `${Math.round(hit.p.y)}px`;
    this.tip.hidden = false;
  }

  _click(e) {
    const hit = this._nearest(e, e.pointerType === 'mouse' ? 10 : 18);
    if (!hit) return;
    logger.noteInput('topomap:electrode');
    logger.event('topomap', { action: 'channel', channel: hit.ch.name, via: 'topomap' });
    this.ws.chooseChannelFromMap(hit.ch.name);
  }
}

/** The colours of the scale, for the tests. */
export const SCALE_COLOURS = DIVERGING;
