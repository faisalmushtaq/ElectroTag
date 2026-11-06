// The topographic map's arithmetic, without the page (docs/using.md, "The topographic map"): the value of
// each channel at a moment or over a stretch, the spherical spline that spreads them over the scalp, and
// the colour of a value. Plain functions that the unit tests check (web_tests/unit/ui_topo.test.mjs).
//
// Electrodes come as map positions {x, y} (js/viewer/head_map.js: x to the right, y to the front, the
// ring through Fpz, T7, Oz and T8 at radius 1, drawn with the azimuthal equidistant projection), which
// unitVector turns back into points on a unit sphere: the distance from the centre is the angle from the
// vertex, a quarter turn at the ring.
//
// The interpolation is the spherical spline of Perrin, Pernier, Bertrand and Echallier (1989): the value
// at a point e of the sphere is c0 + sum_i c_i g(cos(e, e_i)), with
//
//   g(x) = 1 / (4 pi) * sum_{n >= 1} (2n + 1) / (n (n + 1))^m * P_n(x)
//
// (P_n the Legendre polynomials, m = 4, the first 50 terms), and c0 and c_i the solution of
// G c + c0 = v, sum c_i = 0 at the electrodes, the values v there.

import { mapLayout, standardPosition } from './head_map.js';

/** The order of the spline. */
export const SPLINE_ORDER = 4;
/** The terms of the Legendre series. */
export const LEGENDRE_TERMS = 50;
/** A little smoothing on the diagonal, so that electrodes very close together do not make the system singular. */
export const SMOOTHING = 1e-7;

/** A point on the unit sphere [x, y, z] from a map position (z up at the vertex). */
export function unitVector(p) {
  const r = Math.hypot(p.x, p.y);
  if (r < 1e-12) return [0, 0, 1];
  const theta = Math.min(r, 2) * (Math.PI / 2); // a quarter turn at the ring, the south pole at radius 2
  const s = Math.sin(theta) / r;
  return [p.x * s, p.y * s, Math.cos(theta)];
}

/** g(x) of the spline, x the cosine of the angle between two points. */
export function splineG(x, m = SPLINE_ORDER, terms = LEGENDRE_TERMS) {
  const c = Math.max(-1, Math.min(1, x));
  let p0 = 1;
  let p1 = c;
  let sum = 0;
  for (let n = 1; n <= terms; n++) {
    sum += ((2 * n + 1) / (n * (n + 1)) ** m) * p1;
    const p2 = ((2 * n + 1) * c * p1 - n * p0) / (n + 1); // Bonnet's recursion
    p0 = p1;
    p1 = p2;
  }
  return sum / (4 * Math.PI);
}

/** g over [-1, 1] in a table, with linear interpolation: for the many points of the map's grid. */
export function gTable(size = 4001) {
  const t = new Float64Array(size);
  for (let i = 0; i < size; i++) t[i] = splineG(-1 + (2 * i) / (size - 1));
  return (x) => {
    const f = ((Math.max(-1, Math.min(1, x)) + 1) / 2) * (size - 1);
    const i = Math.min(size - 2, Math.floor(f));
    return t[i] + (t[i + 1] - t[i]) * (f - i);
  };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** LU factors with partial pivoting of a square matrix (rows of Float64Array), in place; returns the pivots. */
function factor(a) {
  const n = a.length;
  const piv = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i][k]) > Math.abs(a[p][k])) p = i;
    piv[k] = p;
    if (p !== k) { const t = a[k]; a[k] = a[p]; a[p] = t; }
    const d = a[k][k];
    if (Math.abs(d) < 1e-300) throw new Error('The electrode positions do not allow a map (two may be in the same place).');
    for (let i = k + 1; i < n; i++) {
      const f = (a[i][k] /= d);
      if (f !== 0) for (let j = k + 1; j < n; j++) a[i][j] -= f * a[k][j];
    }
  }
  return piv;
}

function solve(lu, piv, b) {
  const n = lu.length;
  const x = Float64Array.from(b);
  for (let k = 0; k < n; k++) { const p = piv[k]; if (p !== k) { const t = x[k]; x[k] = x[p]; x[p] = t; } }
  for (let i = 0; i < n; i++) { let s = x[i]; for (let j = 0; j < i; j++) s -= lu[i][j] * x[j]; x[i] = s; }
  for (let i = n - 1; i >= 0; i--) { let s = x[i]; for (let j = i + 1; j < n; j++) s -= lu[i][j] * x[j]; x[i] = s / lu[i][i]; }
  return x;
}

/**
 * A spline through electrodes at map positions `points` ([{x, y}], at least three), to be evaluated at the
 * map positions `at` ([{x, y}]): returns a function from the values at the electrodes (in their order) to
 * the values at `at` (a Float64Array), which reuses the factors worked out here.
 */
export function makeSpline(points, at) {
  const n = points.length;
  if (n < 3) throw new Error('A map needs at least three electrodes with positions.');
  const e = points.map(unitVector);
  const a = [];
  for (let i = 0; i <= n; i++) a.push(new Float64Array(n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) a[i][j] = splineG(dot(e[i], e[j]));
    a[i][i] += SMOOTHING;
    a[i][n] = 1;
    a[n][i] = 1;
  }
  const piv = factor(a);
  const g = gTable();
  const q = at.map(unitVector);
  const gAt = q.map((u) => Float64Array.from(e, (v) => g(dot(u, v))));
  return (values) => {
    const rhs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) rhs[i] = values[i];
    const c = solve(a, piv, rhs);
    const out = new Float64Array(q.length);
    for (let k = 0; k < q.length; k++) {
      const row = gAt[k];
      let s = c[n];
      for (let i = 0; i < n; i++) s += c[i] * row[i];
      out[k] = s;
    }
    return out;
  };
}

/**
 * The grid of a map: `size` by `size` cells over the square of half-width `radius`, row by row from the
 * front. The map is drawn in the circle of that radius; the cells in its corners are worked out too, so
 * that the colours stay even up to its edge when the grid is smoothed onto the screen.
 */
export function grid(size, radius) {
  const cells = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      cells.push({ x: (((c + 0.5) / size) * 2 - 1) * radius, y: (1 - ((r + 0.5) / size) * 2) * radius, r, c });
    }
  }
  return cells;
}

// ------------------------------------------------------------------ the values of the channels
/**
 * The value of each channel from `data` (one Float32Array a channel, from sample `start`), relative to its
 * mean over the samples [b0, b1) (the stretch on the screen, as the viewer centres each trace there), with
 * the average reference when `average` (the mean of the channels that `use` marks at each sample):
 *   - `what` 'moment': the value at sample `at`;
 *   - 'mean': the mean over [w0, w1);
 *   - 'rms': the root mean square over [w0, w1).
 * Returns a Float64Array, NaN for a channel without data there.
 */
export function channelValues(data, start, { what = 'moment', at = 0, w0 = 0, w1 = 0, b0, b1, average = false, use = null }) {
  const n = data.length;
  const ok = use || new Array(n).fill(true);
  const base = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    const d = data[c];
    const i0 = Math.max(0, b0 - start);
    const i1 = Math.min(d ? d.length : 0, b1 - start);
    let s = 0;
    for (let i = i0; i < i1; i++) s += d[i];
    base[c] = i1 > i0 ? s / (i1 - i0) : NaN;
  }
  const sampleAt = (c, s) => {
    const d = data[c];
    const i = s - start;
    return d && i >= 0 && i < d.length ? d[i] - base[c] : NaN;
  };
  const refAt = (s) => {
    if (!average) return 0;
    let sum = 0;
    let k = 0;
    for (let c = 0; c < n; c++) {
      if (!ok[c]) continue;
      const v = sampleAt(c, s);
      if (Number.isFinite(v)) { sum += v; k++; }
    }
    return k ? sum / k : 0;
  };
  const out = new Float64Array(n);
  if (what === 'moment') {
    const r = refAt(at);
    for (let c = 0; c < n; c++) out[c] = sampleAt(c, at) - r;
    return out;
  }
  const a = Math.max(w0, start);
  const b = Math.max(a, w1);
  const refs = new Float64Array(b - a);
  for (let s = a; s < b; s++) refs[s - a] = refAt(s);
  for (let c = 0; c < n; c++) {
    let sum = 0;
    let k = 0;
    for (let s = a; s < b; s++) {
      const v = sampleAt(c, s) - refs[s - a];
      if (!Number.isFinite(v)) continue;
      sum += what === 'rms' ? v * v : v;
      k++;
    }
    out[c] = !k ? NaN : what === 'rms' ? Math.sqrt(sum / k) : sum / k;
  }
  return out;
}

// ------------------------------------------------------------------ colours
/** Blue (negative) through near white (0) to red (positive): RdBu, reversed, in eleven steps. */
export const DIVERGING = Object.freeze(['#053061', '#2166AC', '#4393C3', '#92C5DE', '#D1E5F0', '#F7F7F7',
  '#FDDBC7', '#F4A582', '#D6604D', '#B2182B', '#67001F']);

const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const STOPS = DIVERGING.map(rgbOf);

/** The colour [r, g, b] of value v on a scale from -limit to +limit (beyond it, the end colours). */
export function colourOf(v, limit) {
  if (!Number.isFinite(v) || !(limit > 0)) return [...STOPS[5]];
  const f = (Math.max(-1, Math.min(1, v / limit)) + 1) / 2 * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(f));
  const t = f - i;
  return STOPS[i].map((x, k) => Math.round(x + (STOPS[i + 1][k] - x) * t));
}

/** The limits a person steps through with − and + (µV). */
export const LIMITS_UV = Object.freeze([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]);

/** The limit nearest to `uv` microvolts on the ladder, moved `step` places (−1 narrower, +1 wider). */
export function stepLimit(uv, step = 0) {
  let best = 0;
  for (let i = 1; i < LIMITS_UV.length; i++) if (Math.abs(Math.log(LIMITS_UV[i] / uv)) < Math.abs(Math.log(LIMITS_UV[best] / uv))) best = i;
  return LIMITS_UV[Math.max(0, Math.min(LIMITS_UV.length - 1, best + step))];
}

// ------------------------------------------------------------------ where the electrodes are
const isEeg = (c) => ['eeg', ''].includes(String(c.type || '').toLowerCase());

/**
 * Where the map places a recording's EEG channels (`channels`: [{name, type}]): from the positions the
 * administrator gave when the recording was added (`registered`, the manifest's electrode_positions:
 * {source: 'file', points: {name: [x, y]}}, {source: 'standard'} or {source: 'none'}), or, for a
 * recording added without that choice (before it was asked, with electrotag-web register, or opened from
 * this computer only), as the channel chooser's map places them (head_map.js mapLayout, with `local`, the
 * positions of an electrodes.tsv opened with the recording). Returns {source: 'file' | 'standard' | 'none',
 * points: Map name -> {x, y}, registered: bool}; 'none' when the administrator chose no positions, or the
 * names say nothing about where the electrodes are (the map would only place them in rings).
 */
export function topoPositions(channels, registered = null, local = null) {
  const eeg = channels.filter(isEeg);
  const out = (source, pairs, reg) => ({ source, points: new Map(pairs), registered: reg });
  if (registered && typeof registered === 'object' && ['file', 'standard', 'none'].includes(registered.source)) {
    if (registered.source === 'none') return out('none', [], true);
    if (registered.source === 'file') {
      const pts = registered.points || {};
      return out('file', eeg.filter((c) => Array.isArray(pts[c.name]) && pts[c.name].length === 2 && pts[c.name].every(Number.isFinite))
        .map((c) => [c.name, { x: pts[c.name][0], y: pts[c.name][1] }]), true);
    }
    return out('standard', eeg.map((c) => [c.name, standardPosition(c.name)]).filter(([, p]) => p), true);
  }
  const layout = mapLayout(channels, local);
  if (layout.source === 'order') return out('none', [], false);
  const names = new Set(eeg.map((c) => c.name));
  return out(layout.source, layout.points.filter((p) => !p.extra && names.has(p.name)).map((p) => [p.name, { x: p.x, y: p.y }]), false);
}

/**
 * What a recording's manifest records of its positions, from the choice made when it is added: 'none',
 * 'standard' (the 10-20, 10-10 and 10-05 positions of its channel names) or 'file' with `positions`, the
 * map positions of its electrodes.tsv (head_map.js projectPositions, a Map name -> {x, y}), kept for its
 * EEG channels, rounded to 4 decimals. Returns null when there is nothing to keep for 'file' or 'standard'.
 */
export function registeredPositions(channels, source, positions = null) {
  if (source === 'none') return { source: 'none' };
  const eeg = channels.filter(isEeg);
  if (source === 'standard') return eeg.some((c) => standardPosition(c.name)) ? { source: 'standard' } : null;
  const pts = {};
  for (const c of eeg) {
    const p = positions && positions.get(c.name);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) pts[c.name] = [Math.round(p.x * 1e4) / 1e4, Math.round(p.y * 1e4) / 1e4];
  }
  return Object.keys(pts).length ? { source: 'file', points: pts } : null;
}
