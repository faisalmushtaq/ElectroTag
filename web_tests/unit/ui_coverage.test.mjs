// The parts of a recording that have been on screen (js/viewer/coverage.js): merged intervals, the
// stretches not yet viewed, the next of them and how a draft keeps them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_INTERVALS, addInterval, complement, coveredS, fromDraft, mergeIntervals, nextUnviewed, percentText, toDraft, unviewed,
  viewStartFor, viewedFraction,
} from '../../electrotag/web/static/js/viewer/coverage.js';
import { intersect, partlyFraction, partlyViewed } from '../../electrotag/web/static/js/viewer/coverage_partly.js';

// --------------------------------------------------------------- the coverage

test('intervals merge: sorted, overlapping and touching ones joined, empty ones dropped', () => {
  assert.deepEqual(mergeIntervals([[5, 10], [0, 2], [9, 12], [2.01, 3], [4, 4], [NaN, 1], 'x']), [[0, 3], [5, 12]]);
  assert.deepEqual(mergeIntervals([[0, 1], [1.5, 2]]), [[0, 1], [1.5, 2]]);
  let list = [];
  list = addInterval(list, 10, 20, 70);
  list = addInterval(list, 60, 80, 70);
  list = addInterval(list, -5, 2, 70);
  assert.deepEqual(list, [[0, 2], [10, 20], [60, 70]], 'clipped to the recording');
  assert.equal(addInterval(list, 3, 3, 70), list, 'nothing to add: the same list');
  assert.deepEqual(addInterval(list, 15, 65, 70), [[0, 2], [10, 70]]);
  assert.equal(coveredS(list), 22);
  assert.deepEqual(complement(list, 70), [[2, 10], [20, 60]]);
  assert.deepEqual(complement([], 5), [[0, 5]]);
  assert.deepEqual(complement([[0, 5]], 5), []);
});

test('a list never grows past its limit: the closest neighbours are joined first', () => {
  let list = [];
  for (let i = 0; i < MAX_INTERVALS + 50; i++) list = addInterval(list, i * 2, i * 2 + 1, Infinity);
  assert.ok(list.length <= MAX_INTERVALS, `${list.length} intervals`);
  assert.equal(list[0][0], 0);
  assert.equal(list[list.length - 1][1], (MAX_INTERVALS + 49) * 2 + 1);
});

test('the unviewed stretches, the fraction viewed and its text', () => {
  const seen = [[0, 28], [50, 60]];
  assert.deepEqual(unviewed(seen, 70), [[28, 50], [60, 70]]);
  assert.deepEqual(unviewed([[0, 69.5]], 70), [], 'less than a second is left out');
  assert.deepEqual(unviewed([[0, 28]], 70, { noData: [[30, 70]] }), [[28, 30]], 'stretches without data have nothing to see');
  assert.equal(viewedFraction(seen, 70), 38 / 70);
  assert.equal(viewedFraction([[0, 28]], 70, [[28, 70]]), 1);
  assert.equal(viewedFraction([], 0), 1);
  assert.equal(percentText(38 / 70), '54%');
  assert.equal(percentText(0.999), '99%', 'rounded down: 100% only when everything is seen');
  assert.equal(percentText(1), '100%');
});

test('the next unviewed stretch comes after the view, then round from the start', () => {
  const gaps = [[28, 50], [60, 70]];
  assert.deepEqual(nextUnviewed(gaps, 10), [28, 50]);
  assert.deepEqual(nextUnviewed(gaps, 55), [60, 70]);
  assert.deepEqual(nextUnviewed(gaps, 30), [28, 50], 'a stretch that runs on past the view');
  assert.deepEqual(nextUnviewed(gaps, 70), [28, 50]);
  assert.equal(nextUnviewed([], 0), null);
  // The view starts a second before the stretch when it still fits on the screen.
  assert.equal(viewStartFor([10, 70], 10), 9);
  assert.equal(viewStartFor([60, 70], 10), 60, 'exactly a screen: nothing before it');
  assert.equal(viewStartFor([60, 66], 10), 59);
  assert.equal(viewStartFor([60, 69], 10), 59.5);
  assert.equal(viewStartFor([0.2, 5], 10), 0);
});

test('a draft keeps the stretches to a hundredth of a second, and reads anything back safely', () => {
  assert.deepEqual(toDraft([[0.123, 9.991], [9.995, 20.0001]]), [[0.12, 20.01]]);
  assert.deepEqual(fromDraft([[0, 10], [5, 'x'], [60, 80], [1], null], 70), [[0, 10], [60, 70]]);
  assert.deepEqual(fromDraft(undefined, 70), []);
  assert.deepEqual(fromDraft({ a: 1 }, 70), []);
});

// ---------------------------------------- the parts seen only while some good channels were hidden

test('the common parts of two lists', () => {
  assert.deepEqual(intersect([[0, 10], [20, 30]], [[5, 25]]), [[5, 10], [20, 25]]);
  assert.deepEqual(intersect([[0, 10]], [[10, 20]]), []);
  assert.deepEqual(intersect([], [[0, 5]]), []);
  assert.deepEqual(intersect([[0, 2], [3, 4], [5, 6]], [[1, 5.5]]), [[1, 2], [3, 4], [5, 5.5]]);
});

test('a part seen only with some channels hidden still counts as not viewed, and is listed apart', () => {
  const full = [[0, 30]]; // on the screen with every good channel
  const partly = [[20, 50]]; // on the screen while some good channels were hidden
  // still to view: everything after 30 s; of it, 30 to 50 s was seen with some channels hidden
  assert.deepEqual(unviewed(full, 100), [[30, 100]]);
  assert.deepEqual(partlyViewed(full, partly, 100), [[30, 50]]);
  assert.equal(viewedFraction(full, 100), 0.3, 'the fraction viewed leaves the partly seen part out');
  assert.ok(Math.abs(partlyFraction(full, partly, 100) - 0.2) < 1e-9);
  // once that part has been on the screen with all the channels, it is no longer listed
  const later = addInterval(full, 30, 50, 100);
  assert.deepEqual(partlyViewed(later, partly, 100), []);
  assert.equal(partlyFraction(later, partly, 100), 0);
  // a short sliver is not listed, and stretches without data are not asked for
  assert.deepEqual(partlyViewed(full, [[29, 30.5]], 100), []);
  assert.deepEqual(partlyViewed(full, partly, 100, { noData: [[40, 60]] }), [[30, 40]]);
  assert.deepEqual(partlyViewed(full, [], 100), []);
});
