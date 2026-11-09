// The viewer's arithmetic (js/viewer/geometry.js) and choosing files from a folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { axisFormat, axisTitle, columnMinMax, decimateColumns, fitTags, layoutTags, niceStep, stepOption, tickLabel, voltsText, DURATIONS, CHANNEL_COUNTS } from '../../electrotag/web/static/js/viewer/geometry.js';
import { filesForRecording } from '../../electrotag/web/static/js/views/open.js';

test('min and max per pixel column', () => {
  const data = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 5));
  const { min, max } = columnMinMax(data, 0, 0, 100, 10);
  for (let c = 0; c < 10; c++) {
    const part = Array.from(data.subarray(c * 10, c * 10 + 10));
    assert.equal(min[c], Math.min(...part));
    assert.equal(max[c], Math.max(...part));
  }
  const outside = columnMinMax(data, 1000, 0, 100, 10);
  assert.ok(outside.min.every(Number.isNaN));
});

test('scrolling reuses the columns already worked out', () => {
  const data = Float32Array.from({ length: 5000 }, (_, i) => Math.cos(i / 7) + (i % 13) / 10);
  const grid = 9.41;
  const first = decimateColumns(data, 0, grid, 100, 200);
  const moved = decimateColumns(data, 0, grid, 150, 200, first);
  const fresh = decimateColumns(data, 0, grid, 150, 200);
  assert.deepEqual(Array.from(moved.min), Array.from(fresh.min));
  assert.deepEqual(Array.from(moved.max), Array.from(fresh.max));
  assert.deepEqual(Array.from(moved.sum), Array.from(fresh.sum));
});

test('axis ticks, tags, steps and scale bars', () => {
  assert.equal(niceStep(10, 1000), 1);
  assert.equal(niceStep(60, 1000), 5);
  assert.equal(tickLabel(12, 1), '12');
  assert.equal(tickLabel(12.5, 0.5), '12.5');
  assert.equal(tickLabel(3725, 600), '1:02:05');
  assert.deepEqual(layoutTags([{ x: 100, w: 80 }, { x: 150, w: 80 }, { x: 400, w: 50 }]), [0, 1, 0]);
  assert.equal(stepOption(DURATIONS, 10, 1), 20);
  assert.equal(stepOption(DURATIONS, 10, -1), 5);
  assert.equal(stepOption(CHANNEL_COUNTS, 22, 1, 22), 22);
  assert.equal(stepOption(CHANNEL_COUNTS, 20, 1, 22), 22);
  assert.equal(stepOption(CHANNEL_COUNTS, 22, -1, 22), 20);
  assert.equal(stepOption(DURATIONS, 60, 1, 70), 70);
  assert.equal(voltsText(1e-4), '100 µV');
  assert.equal(voltsText(1e-3), '1 mV');
});

test('the files of one recording from a folder', () => {
  const f = (name) => ({ name });
  assert.deepEqual(filesForRecording([f('a.edf'), f('notes.txt')]).map((x) => x.name), ['a.edf']);
  assert.deepEqual(filesForRecording([f('a.vhdr'), f('a.vmrk'), f('a.eeg'), f('x.txt')]).map((x) => x.name), ['a.vhdr', 'a.vmrk', 'a.eeg']);
  assert.equal(filesForRecording([f('a.edf'), f('b.edf')]), null);
  assert.deepEqual(filesForRecording([f('a.edf'), f('b.edf')], 'b.edf').map((x) => x.name), ['b.edf']);
  assert.deepEqual(filesForRecording([f('x.txt')]), []);
});

test('the time axis: one format per screen, named by its title, with the decimals the step needs', () => {
  assert.equal(axisFormat(0, 10, 1), 's');
  assert.equal(axisFormat(595, 10, 1), 'clock', 'a screen that reaches ten minutes is written as a clock throughout');
  assert.equal(axisFormat(0, 1200, 120), 'clock');
  assert.equal(axisTitle('s', 10), 'time (s)');
  assert.equal(axisTitle('clock', 1200), 'time (m:ss)');
  assert.equal(axisTitle('clock', 3725), 'time (h:mm:ss)');
  assert.equal(tickLabel(596, 1, 'clock'), '9:56');
  assert.equal(tickLabel(900.2, 0.2, 'clock'), '15:00.2', 'tenths are kept on a clock');
  assert.equal(tickLabel(899.8, 0.2, 'clock'), '14:59.8');
  assert.equal(tickLabel(59.96, 0.1, 'clock'), '1:00.0', 'never 0:60.0');
  assert.equal(tickLabel(3725.5, 0.5, 'clock'), '1:02:05.5');
  assert.equal(tickLabel(12.5, 0.5, 's'), '12.5');
});

test('tags: whole where they fit in two rows, cut to their numbers and set side by side where more overlap', () => {
  const tag = (x, w = 120) => ({ x, w, wShort: 24 });
  // two overlapping and one apart: all whole, in two rows
  assert.deepEqual(fitTags([tag(100), tag(150), tag(400)]), [{ row: 0, x: 100, short: false }, { row: 1, x: 150, short: false }, { row: 0, x: 400, short: false }]);
  // three in the same stretch of time: cut to numbers, side by side in time order, centred on them; the one apart stays whole
  const three = fitTags([tag(210), tag(200), tag(205), tag(700)], 2, { x0: 0, x1: 1000 });
  assert.deepEqual(three.map((p) => [p.row, p.short]), [[0, true], [0, true], [0, true], [0, false]]);
  assert.deepEqual([three[1].x, three[2].x, three[0].x], [177, 205, 233], 'in time order, 4 pixels apart, centred on the group');
  // near the left edge: kept on screen
  const edge = fitTags([tag(5), tag(6), tag(7)], 2, { x0: 0, x1: 1000 });
  assert.equal(Math.min(...edge.map((p) => p.x - 12)), 0);
  // too many for one row of a narrow plot: they continue on the second
  const many = fitTags(Array.from({ length: 6 }, () => tag(50)), 2, { x0: 0, x1: 100 });
  assert.deepEqual(many.map((p) => p.row), [0, 0, 0, 1, 1, 1]);
  assert.ok(many.every((p) => p.short));
});
