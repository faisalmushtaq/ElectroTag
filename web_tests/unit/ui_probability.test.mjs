// The probability map in the browser (js/expert/probability.js) against electrotag/reliability/probability.py:
// the same raters, marks and weights give the same runs, to the last bit, so that what an administrator sees
// is what the download holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { ANY, checkedWeights, defaultWeights, raterWeight, runAt, runs } from '../../electrotag/web/static/js/expert/probability.js';
import { REPO, findPython } from '../python.mjs';

const PY = findPython('import electrotag.reliability.probability');

/** The same cases worked out by Python. */
function python(cases) {
  const code = `
import json, sys
from electrotag.reliability.probability import Mark, Rater, Weights, runs
out = []
for c in json.load(sys.stdin):
    w = Weights.from_dict(c["weights"])
    raters = [Rater(r["annotator_id"], [Mark(m["label"], m["onset"], m["duration"], tuple(m["channels"]), m["confidence"]) for m in r["marks"]], r["weight"]) for r in c["raters"]]
    rs = runs(raters, c["n"], w, category=c["category"], channel=c["channel"])
    out.append([[r.start, r.end, r.probability, r.n_marked, r.weight_total, r.weight_marked] for r in rs])
json.dump(out, sys.stdout)
`;
  const r = spawnSync(PY, ['-c', code], { cwd: REPO, input: JSON.stringify(cases), encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** A small random number generator with a seed, so that the cases are the same every time. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function makeCases() {
  const rand = rng(20261106);
  const labels = ['Eye-blink-artifact', 'EMG-artifact', 'Chewing-artifact'];
  const chans = ['Fp1', 'Fp2', 'O1', 'O2'];
  const cases = [];
  for (let k = 0; k < 40; k++) {
    const n = 200 + Math.floor(rand() * 2000);
    const raters = [];
    const nR = 2 + Math.floor(rand() * 6);
    for (let i = 0; i < nR; i++) {
      const marks = [];
      const nM = Math.floor(rand() * 8);
      for (let j = 0; j < nM; j++) {
        marks.push({ label: labels[Math.floor(rand() * 3)], onset: Math.floor(rand() * n) - 20, duration: Math.floor(rand() * 300),
          channels: rand() < 0.4 ? [] : chans.filter(() => rand() < 0.5), confidence: rand() < 0.5 ? null : 1 + Math.floor(rand() * 5) });
      }
      raters.push({ annotator_id: `R${String(nR - i).padStart(2, '0')}`, weight: [1, 0.5, 0.25, 0.8, 0][Math.floor(rand() * 5)], marks });
    }
    const weights = { confidence: [0.2, 0.4, 0.6, 0.8, 1].map((x) => (rand() < 0.3 ? Math.round(rand() * 100) / 100 : x)), questions: {}, no_answer: 1 };
    cases.push({ n, raters, weights, category: rand() < 0.5 ? ANY : labels[Math.floor(rand() * 3)], channel: rand() < 0.5 ? null : chans[Math.floor(rand() * 4)] });
  }
  return cases;
}

test('the browser\'s map is Python\'s, run for run and to the last bit', { skip: PY ? false : 'no Python with ElectroTag' }, () => {
  const cases = makeCases();
  const want = python(cases);
  cases.forEach((c, i) => {
    const got = runs(c.raters, c.n, c.weights, { category: c.category, channel: c.channel })
      .map((r) => [r.start, r.end, r.p, r.n_marked, r.weight_total, r.weight_marked]);
    assert.deepEqual(got, want[i], `case ${i}`);
  });
});

test('confidence, unrated marks and unmarked time weigh as the study decided', () => {
  const w = defaultWeights();
  const raters = [{ annotator_id: 'A01', weight: 1, marks: [{ label: 'Eye-blink-artifact', onset: 10, duration: 10, channels: [], confidence: 2 }] },
    { annotator_id: 'A02', weight: 1, marks: [{ label: 'Eye-blink-artifact', onset: 15, duration: 10, channels: ['Fp1'], confidence: null }] },
    { annotator_id: 'A03', weight: 1, marks: [] }];
  const map = runs(raters, 40, w);
  assert.equal(runAt(map, 12).p, 0.4 / 2.4);
  assert.equal(runAt(map, 22).p, 1 / 3);
  assert.equal(runAt(runs(raters, 40, w, { channel: 'O1' }), 17).p, 0.4 / 2.4, 'A02 marked Fp1 only');
  assert.equal(runAt(map, 40), null);
  assert.equal(raterWeight({ eeg_years: 'Less than 1', career_stage: 'PhD' },
    { questions: { eeg_years: { 'Less than 1': 0.5 }, career_stage: { PhD: 0.5 } }, no_answer: 1 }), 0.25);
  assert.equal(raterWeight({}, { questions: { eeg_years: { 'Less than 1': 0.5 } }, no_answer: 0.7 }), 0.7);
});

test('weights kept in a browser are checked before they are used', () => {
  assert.deepEqual(checkedWeights(null), defaultWeights());
  assert.deepEqual(checkedWeights({ confidence: [1, 2, 3, 4, 5], questions: { q: { a: 0.5, b: -1 } }, no_answer: 'x' }),
    { confidence: defaultWeights().confidence, questions: { q: { a: 0.5 } }, no_answer: 1 });
});
