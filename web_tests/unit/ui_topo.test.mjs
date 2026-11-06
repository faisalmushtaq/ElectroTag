// The topographic map's arithmetic (js/viewer/topo.js): the spherical spline against the same formula worked
// out by NumPy, the values of the channels at a moment and over a mark, where the electrodes go, and the
// colour scale, which stays readable with red-green colour blindness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  DIVERGING, LEGENDRE_TERMS, SMOOTHING, SPLINE_ORDER, channelValues, colourOf, grid, makeSpline, registeredPositions, splineG, stepLimit,
  topoPositions, unitVector,
} from '../../electrotag/web/static/js/viewer/topo.js';
import { standardPosition } from '../../electrotag/web/static/js/viewer/head_map.js';
import { REPO, findPython } from '../python.mjs';
import { cvd, oklab } from './_colour_science.mjs';

const PY = findPython('import numpy');
const NAMES = ['Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8', 'T7', 'C3', 'Cz', 'C4', 'T8', 'P7', 'P3', 'Pz', 'P4', 'P8', 'O1', 'Oz', 'O2'];

test('a map position goes back onto the sphere: the vertex up, the ring on the equator', () => {
  assert.deepEqual(unitVector({ x: 0, y: 0 }), [0, 0, 1]);
  const t8 = unitVector({ x: 1, y: 0 });
  assert.ok(Math.abs(t8[0] - 1) < 1e-12 && Math.abs(t8[2]) < 1e-12);
  const fp = unitVector(standardPosition('Fpz'));
  assert.ok(Math.abs(Math.hypot(...fp) - 1) < 1e-12 && fp[1] > 0.99);
});

test('the spline is Perrin and colleagues\' formula, as NumPy works it out, and fits the electrodes', () => {
  const pts = NAMES.map(standardPosition);
  const values = pts.map((p) => 30e-6 * p.x - 20e-6 * p.y + 10e-6 * p.x * p.y); // a smooth field
  const at = [{ x: 0, y: 0 }, { x: 0.3, y: -0.4 }, { x: -0.8, y: 0.2 }, { x: 0.55, y: 0.6 }];
  const code = `
import json, sys
import numpy as np
from numpy.polynomial import legendre
d = json.load(sys.stdin)
n = np.arange(1, d["terms"] + 1)
coef = np.concatenate([[0.0], (2 * n + 1) / (n * (n + 1)) ** d["m"]]) / (4 * np.pi)
g = lambda x: legendre.legval(np.clip(x, -1, 1), coef)
def unit(p):
    r = np.hypot(p["x"], p["y"])
    if r < 1e-12: return np.array([0.0, 0.0, 1.0])
    t = min(r, 2) * np.pi / 2
    return np.array([p["x"] * np.sin(t) / r, p["y"] * np.sin(t) / r, np.cos(t)])
e = np.array([unit(p) for p in d["pts"]]); q = np.array([unit(p) for p in d["at"]])
k = len(e)
A = np.zeros((k + 1, k + 1)); A[:k, :k] = g(e @ e.T) + d["smooth"] * np.eye(k); A[:k, k] = 1; A[k, :k] = 1
c = np.linalg.solve(A, np.concatenate([d["values"], [0.0]]))
json.dump({"g": [float(g(x)) for x in d["xs"]], "at": (g(q @ e.T) @ c[:k] + c[k]).tolist(), "fit": (g(e @ e.T) @ c[:k] + c[k]).tolist()}, sys.stdout)
`;
  const xs = [-1, -0.5, 0, 0.3, 0.9, 0.999, 1];
  const r = spawnSync(PY, ['-c', code], { cwd: REPO, encoding: 'utf8',
    input: JSON.stringify({ pts, values, at, xs, terms: LEGENDRE_TERMS, m: SPLINE_ORDER, smooth: SMOOTHING }) });
  assert.equal(r.status, 0, r.stderr);
  const want = JSON.parse(r.stdout);
  xs.forEach((x, i) => assert.ok(Math.abs(splineG(x) - want.g[i]) < 1e-13, `g(${x})`));
  const got = makeSpline(pts, at)(values);
  const span = Math.max(...values) - Math.min(...values);
  got.forEach((v, i) => assert.ok(Math.abs(v - want.at[i]) < 1e-4 * span, `at ${JSON.stringify(at[i])}: ${v} and ${want.at[i]}`));
  // through the electrodes themselves (up to the smoothing), and a constant field stays constant
  const fit = makeSpline(pts, pts)(values);
  fit.forEach((v, i) => assert.ok(Math.abs(v - values[i]) < 1e-3 * span, NAMES[i]));
  for (const v of makeSpline(pts, at)(pts.map(() => 7e-6))) assert.ok(Math.abs(v - 7e-6) < 1e-12);
  assert.throws(() => makeSpline(pts.slice(0, 2), at), /at least three electrodes/);
});

test('the grid covers the square around the head, row by row from the front', () => {
  const g = grid(4, 1.2);
  assert.equal(g.length, 16);
  assert.deepEqual([g[0].r, g[0].c], [0, 0]);
  assert.ok(g[0].y > 0 && g[0].x < 0 && Math.abs(g[0].x + 0.9) < 1e-12);
});

test('the values of the channels: at a moment, the mean and the RMS over a mark, centred on the screen, with the average reference', () => {
  // three channels from sample 100; the screen is samples 100 to 110
  const a = Float32Array.from([1, 1, 1, 1, 1, 5, 5, 1, 1, 1]);
  const b = Float32Array.from([2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  const c = Float32Array.from([0, 0, 0, 0, 0, -3, 3, 0, 0, 0]);
  const data = [a, b, c];
  const base = { b0: 100, b1: 110 };
  const at = channelValues(data, 100, { ...base, what: 'moment', at: 105 });
  assert.deepEqual([...at].map((v) => Math.round(v * 1e6) / 1e6), [3.2, 0, -3]);
  const mean = channelValues(data, 100, { ...base, what: 'mean', w0: 105, w1: 107 });
  assert.deepEqual([...mean].map((v) => Math.round(v * 1e6) / 1e6), [3.2, 0, 0]);
  const rms = channelValues(data, 100, { ...base, what: 'rms', w0: 105, w1: 107 });
  assert.deepEqual([...rms].map((v) => Math.round(v * 1e6) / 1e6), [3.2, 0, 3]);
  // the average reference: the mean of the good channels at each sample is taken away (c is bad here)
  const ref = channelValues(data, 100, { ...base, what: 'moment', at: 105, average: true, use: [true, true, false] });
  assert.deepEqual([...ref].map((v) => Math.round(v * 1e6) / 1e6), [1.6, -1.6, -4.6]);
  const refRms = channelValues(data, 100, { ...base, what: 'rms', w0: 105, w1: 107, average: true, use: [true, true, false] });
  assert.deepEqual([...refRms].map((v) => Math.round(v * 1e6) / 1e6), [1.6, 1.6, 3.4]);
  // a sample outside what was read has no value
  assert.ok(Number.isNaN(channelValues(data, 100, { ...base, what: 'moment', at: 400 })[0]));
});

test('where the electrodes go: the positions given when the recording was added, or else as the channel chooser places them', () => {
  const chans = [...NAMES.map((name) => ({ name, type: 'eeg' })), { name: 'EOG1', type: 'eog' }];
  const none = topoPositions(chans, { source: 'none' });
  assert.equal(none.source, 'none');
  assert.equal(none.points.size, 0);
  const std = topoPositions(chans, { source: 'standard' });
  assert.equal(std.source, 'standard');
  assert.equal(std.points.size, NAMES.length, 'the EEG channels only');
  assert.ok(std.registered);
  const file = topoPositions(chans, { source: 'file', points: { Cz: [0, 0], Fz: [0, 0.5], Pz: [0, -0.5], EOG1: [1, 1], Oz: [Infinity, 0] } });
  assert.deepEqual([...file.points.keys()], ['Fz', 'Cz', 'Pz']);
  // added before the question: placed as the channel chooser places them, by name here
  const unset = topoPositions(chans, undefined);
  assert.equal(unset.source, 'standard');
  assert.equal(unset.registered, false);
  // ... or from an electrodes.tsv opened with the recording
  const local = new Map([['Cz', { x: 0.01, y: 0 }], ['Fz', { x: 0, y: 0.4 }]]);
  assert.equal(topoPositions(chans, null, local).source, 'file');
  // names that say nothing about where the electrodes are: no map
  const biosemi = Array.from({ length: 32 }, (_, i) => ({ name: `A${i + 1}`, type: 'eeg' }));
  assert.equal(topoPositions(biosemi, null).source, 'none');
});

test('what a manifest records of the positions chosen when the recording is added', () => {
  const chans = [{ name: 'Cz', type: 'eeg' }, { name: 'X1', type: 'eeg' }, { name: 'EOG', type: 'eog' }];
  assert.deepEqual(registeredPositions(chans, 'none'), { source: 'none' });
  assert.deepEqual(registeredPositions(chans, 'standard'), { source: 'standard' });
  assert.equal(registeredPositions([{ name: 'X1', type: 'eeg' }], 'standard'), null);
  const pos = new Map([['Cz', { x: 0.000012345, y: -0.123456 }], ['EOG', { x: 1, y: 1 }]]);
  assert.deepEqual(registeredPositions(chans, 'file', pos), { source: 'file', points: { Cz: [0, -0.1235] } });
  assert.equal(registeredPositions(chans, 'file', new Map()), null);
});

test('the colours run from blue through white to red, apart for red-green colour blindness', () => {
  assert.deepEqual(colourOf(0, 1), [247, 247, 247]);
  assert.deepEqual(colourOf(-5, 1), [5, 48, 97]);
  assert.deepEqual(colourOf(5, 1), [103, 0, 31]);
  assert.deepEqual(colourOf(NaN, 1), [247, 247, 247]);
  // lightness falls from the middle to each end, so that a larger value always looks stronger
  const L = DIVERGING.map((hex) => oklab(hex.slice(1).match(/../g).map((x) => parseInt(x, 16)))[0]);
  for (let i = 0; i < 5; i++) assert.ok(L[i] < L[i + 1], `step ${i} on the blue side`);
  for (let i = 5; i < 10; i++) assert.ok(L[i] > L[i + 1], `step ${i} on the red side`);
  // a negative value and a positive one of the same size stay apart with protanopia and deuteranopia, from a
  // fifth of the scale on (nearer 0 both sides are nearly white, as they are with full colour vision)
  for (let i = 0; i < 4; i++) assert.ok(cvd(DIVERGING[i], DIVERGING[10 - i]) > 10, `${DIVERGING[i]} and ${DIVERGING[10 - i]}`);
});

test('the colour scale steps through whole limits', () => {
  assert.equal(stepLimit(50), 50);
  assert.equal(stepLimit(45), 50);
  assert.equal(stepLimit(50, 1), 100);
  assert.equal(stepLimit(50, -1), 20);
  assert.equal(stepLimit(1, -1), 1);
  assert.equal(stepLimit(5000, 1), 5000);
});
