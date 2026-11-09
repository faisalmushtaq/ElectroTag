// The side panel's width (js/annotate/side_panel.js): dragged or moved with the keys, it stays between its
// narrowest and the width that leaves the EEG its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EEG_MIN, SIDE_MIN, WIDE_AT, clampSideWidth } from '../../electrotag/web/static/js/annotate/side_panel.js';

test('the panel keeps between its narrowest and the width that leaves the EEG 480 pixels', () => {
  assert.equal(clampSideWidth(500, 1264), 500);
  assert.equal(clampSideWidth(100, 1264), SIDE_MIN);
  assert.equal(clampSideWidth(5000, 1264), 1264 - EEG_MIN);
  assert.equal(clampSideWidth(Infinity, 1264), 1264 - EEG_MIN, 'End: as wide as it goes');
  assert.equal(clampSideWidth(NaN, 1264), SIDE_MIN);
  assert.equal(clampSideWidth(420.6, 1264), 421);
  // a window too narrow for both: the panel at its narrowest
  assert.equal(clampSideWidth(600, 700), SIDE_MIN);
});

test('a panel can be made wide enough on a laptop screen to set its parts side by side', () => {
  assert.ok(clampSideWidth(Infinity, 1280 - 16) >= WIDE_AT);
});
